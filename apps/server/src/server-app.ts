import { SQL } from "bun";
import { Elysia, status, t } from "elysia";
import {
  listColumns,
  listEnums,
  listIncomingFks,
  listOutgoingFks,
  listPrimaryKeys,
  listTables,
  listUniqueConstraints,
} from "@pg-studio/db";

/**
 * The real studio API. Built per connection URL so tests can construct an
 * app against $TEST_DATABASE_URL without binding a port.
 */

const SAFE_IDENT_PATTERN = "^[A-Za-z_][A-Za-z0-9_$]*$";

const IdentParam = t.String({ pattern: SAFE_IDENT_PATTERN });

export const RelationRefSchema = t.Object({
  schema: t.String(),
  name: t.String(),
});

export const TableMetaSchema = t.Object({
  schema: t.String(),
  name: t.String(),
  kind: t.Union([t.Literal("table"), t.Literal("view")]),
});

export const ColumnMetaSchema = t.Object({
  schema: t.String(),
  table: t.String(),
  name: t.String(),
  position: t.Integer(),
  dataType: t.String(),
  udtName: t.String(),
  nullable: t.Boolean(),
  hasDefault: t.Boolean(),
  default: t.Nullable(t.String()),
});

export const FkActionSchema = t.Union([
  t.Literal("NO ACTION"),
  t.Literal("RESTRICT"),
  t.Literal("CASCADE"),
  t.Literal("SET NULL"),
  t.Literal("SET DEFAULT"),
]);

export const FkConstraintSchema = t.Object({
  name: t.String(),
  childSchema: t.String(),
  childTable: t.String(),
  childColumns: t.Array(t.String()),
  parentSchema: t.String(),
  parentTable: t.String(),
  parentColumns: t.Array(t.String()),
  onDelete: FkActionSchema,
  onUpdate: FkActionSchema,
});

export const EnumMetaSchema = t.Object({
  schema: t.String(),
  name: t.String(),
  values: t.Array(t.String()),
});

export const TableDetailSchema = t.Object({
  table: TableMetaSchema,
  columns: t.Array(ColumnMetaSchema),
  primaryKey: t.Array(t.String()),
  uniqueConstraints: t.Array(
    t.Object({
      schema: t.String(),
      table: t.String(),
      name: t.String(),
      columns: t.Array(t.String()),
    }),
  ),
  fks: t.Object({
    outgoing: t.Array(FkConstraintSchema),
    incoming: t.Array(FkConstraintSchema),
  }),
});

export const ApiErrorSchema = t.Object({ error: t.String() });

export interface ServerAppConfig {
  databaseUrl: string;
}

/** URL-safe redaction for any log line that might carry the connection string. */
export function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

export function createServerApp(config: ServerAppConfig) {
  const db = new SQL(config.databaseUrl);

  return (
    new Elysia({ name: "pg-studio-server" })
      .get("/health", () => ({ ok: true }))
      .get(
        "/api/tables",
        async () => ({ tables: await listTables(db) }),
        { response: t.Object({ tables: t.Array(TableMetaSchema) }) },
      )
      .get(
        "/api/enums",
        async () => ({ enums: await listEnums(db) }),
        { response: t.Object({ enums: t.Array(EnumMetaSchema) }) },
      )
      .get(
        "/api/schemas/:schema/tables/:table",
        async ({ params }) => {
          const tables = await listTables(db);
          const found = tables.find(t => t.schema === params.schema && t.name === params.table);
          if (!found) {
            return status(404, { error: `relation ${params.schema}.${params.table} not found` });
          }
          const [columns, pks, uniques, outgoing, incoming] = await Promise.all([
            listColumns(db, params.schema, params.table),
            listPrimaryKeys(db),
            listUniqueConstraints(db),
            listOutgoingFks(db, params.schema, params.table),
            listIncomingFks(db, params.schema, params.table),
          ]);
          const pk = pks.find(p => p.schema === params.schema && p.table === params.table);
          return {
            table: found,
            columns,
            primaryKey: pk?.columns ?? [],
            uniqueConstraints: uniques.filter(u => u.schema === params.schema && u.table === params.table),
            fks: { outgoing, incoming },
          };
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          response: {
            200: TableDetailSchema,
            404: ApiErrorSchema,
          },
        },
      )
      .onStop(async () => {
        await db.close();
      })
  );
}
