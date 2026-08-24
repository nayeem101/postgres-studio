import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Elysia, status, t } from "elysia";
import {
  listColumns,
  listEnums,
  listIncomingFks,
  listOutgoingFks,
  listPrimaryKeys,
  listRows,
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

export const RowsPageSchema = t.Object({
  rows: t.Array(
    t.Record(
      t.String(),
      t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]),
    ),
  ),
  nextCursor: t.Nullable(t.String()),
});

const RowsQuerySchema = t.Object({
  limit: t.Optional(t.String({ pattern: "^\\d{1,4}$" })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
});

export interface ServerAppConfig {
  databaseUrl: string;
  /** Built SPA directory; when present the server also serves the frontend. */
  staticDir?: string;
}

/** URL-safe redaction for any log line that might carry the connection string. */
export function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/** Serve a built SPA with an index.html fallback; blocks path traversal. */
function attachStatic(
  app: {
    get(path: string, handler: (context: { request: Request }) => unknown): unknown;
  },
  dir: string,
): void {
  const root = resolve(dir);
  app.get("/*", async ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/health") {
      return status(404, { error: "not found" });
    }
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return status(404, { error: "not found" });
    }
    const file = Bun.file(candidate);
    if (!(await file.exists())) {
      // SPA fallback: client-side routes get the shell.
      return new Response(Bun.file(join(root, "index.html")), {
        headers: { "content-type": MIME_BY_EXT[".html"]! },
      });
    }
    return new Response(file, {
      headers: { "content-type": MIME_BY_EXT[extname(candidate)] ?? "application/octet-stream" },
    });
  });
}

export function createServerApp(config: ServerAppConfig) {
  const db = new SQL(config.databaseUrl);

  const app = (
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
      .get(
        "/api/schemas/:schema/tables/:table/rows",
        async ({ params, query }) => {
          let orderBy: string[];
          if (query.sort) {
            orderBy = query.sort.split(",").map(s => s.trim()).filter(Boolean);
          } else {
            const pks = await listPrimaryKeys(db);
            orderBy =
              pks.find(p => p.schema === params.schema && p.table === params.table)?.columns ?? [];
          }
          if (orderBy.length === 0) {
            return status(400, { error: "no sortable key available for this relation" });
          }

          const catalogColumns = await listColumns(db, params.schema, params.table);
          const known = new Set(catalogColumns.map(c => c.name));
          const unknownSort = orderBy.find(c => !known.has(c));
          if (unknownSort) {
            return status(400, { error: `unknown sort column "${unknownSort}"` });
          }

          try {
            return await listRows(db, {
              schema: params.schema,
              table: params.table,
              orderBy,
              descending: query.dir === "desc",
              cursor: query.cursor,
              limit: Number(query.limit ?? 50),
            });
          } catch (error) {
            if ((error as Error).name === "CursorError") {
              return status(400, { error: "invalid cursor token" });
            }
            throw error;
          }
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          query: RowsQuerySchema,
          response: {
            200: RowsPageSchema,
            400: ApiErrorSchema,
          },
        },
      )
      .onStop(async () => {
        await db.close();
      })
  );

  if (config.staticDir) {
    mkdirSync(config.staticDir, { recursive: true });
    attachStatic(app, config.staticDir);
  }
  return app;
}
