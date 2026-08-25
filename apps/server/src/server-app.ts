import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { Elysia, status, t } from "elysia";
import {
  compileDelete,
  compileInsert,
  compileSelectByPkTuples,
  compileUpdate,
  collectCascadingRows,
  inferRelations,
  listColumns,
  listEnums,
  listIncomingFks,
  listOutgoingFks,
  listPrimaryKeys,
  listRows,
  listTables,
  listUniqueConstraints,
  pickDisplayColumn,
  resolveIncomingReferences,
  resolveOutgoingReferences,
} from "@pg-studio/db";
import { restoreBatch, RestoreError } from "./restore";
import { BackupStore, type SnapshotInput } from "./backup";

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

const CellSchema = t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]);
const PkValuesSchema = t.Array(CellSchema);

export const SaveBodySchema = t.Object({
  updates: t.Array(
    t.Object({
      pkValues: PkValuesSchema,
      set: t.Record(t.String(), CellSchema),
    }),
  ),
  deletes: t.Array(t.Object({ pkValues: PkValuesSchema })),
  inserts: t.Array(t.Object({ values: t.Record(t.String(), CellSchema) })),
});

export const SaveResultSchema = t.Object({
  batchId: t.String(),
  appliedUpdates: t.Integer(),
  appliedDeletes: t.Integer(),
  cascadedDeletes: t.Integer(),
  appliedInserts: t.Integer(),
  skipped: t.Integer(),
});

export type SaveBody = typeof SaveBodySchema.static;

export interface ServerAppConfig {
  databaseUrl: string;
  /** Built SPA directory; when present the server also serves the frontend. */
  staticDir?: string;
  /** Override for tests; defaults to a per-connection file under ~/.pg-studio. */
  backupStore?: BackupStore;
}

/** Stable per-connection identifier derived from the URL (never contains secrets). */
export function connectionIdFromUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
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

  const connectionId = connectionIdFromUrl(config.databaseUrl);
  const backupStore =
    config.backupStore ??
    BackupStore.open(join(homedir(), ".pg-studio", "backups", `${connectionId}.sqlite`));
  backupStore.init();

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
        "/api/schemas/:schema/tables/:table/inferred",
        async ({ params }) => {
          const [tables, columns, outgoing] = await Promise.all([
            listTables(db),
            listColumns(db, params.schema, params.table),
            listOutgoingFks(db, params.schema, params.table),
          ]);
          const inferred = inferRelations({
            schema: params.schema,
            table: params.table,
            columns: columns.map(c => ({ name: c.name })),
            tables: tables.map(t => ({ schema: t.schema, name: t.name })),
            realFkChildColumns: outgoing.map(fk => fk.childColumns),
          });
          return { inferred };
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          response: {
            200: t.Object({
              inferred: t.Array(
                t.Object({
                  column: t.String(),
                  parentSchema: t.String(),
                  parentTable: t.String(),
                  confidence: t.Union([t.Literal("strong"), t.Literal("weak")]),
                }),
              ),
            }),
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
      .post(
        "/api/schemas/:schema/tables/:table/save",
        async ({ params, body }) => {
          const totalOps =
            body.updates.length + body.deletes.length + body.inserts.length;
          if (totalOps === 0) {
            return status(400, { error: "no operations submitted" });
          }

          const [columns, pks] = await Promise.all([
            listColumns(db, params.schema, params.table),
            listPrimaryKeys(db),
          ]);
          const knownColumns = new Set(columns.map(c => c.name));
          const pkColumns =
            pks.find(p => p.schema === params.schema && p.table === params.table)?.columns ?? [];
          const needsPk = body.updates.length + body.deletes.length > 0;
          if (needsPk && pkColumns.length === 0) {
            return status(400, { error: "table has no primary key; edits are not supported" });
          }

          for (const op of [...body.updates, ...body.deletes]) {
            if (op.pkValues.some(v => v === null)) {
              return status(400, { error: "primary key values must not be null" });
            }
            if (op.pkValues.length !== pkColumns.length) {
              return status(400, {
                error: `pk arity mismatch: expected ${pkColumns.length} value(s)`,
              });
            }
          }
          for (const update of body.updates) {
            if (Object.keys(update.set).length === 0) {
              return status(400, { error: "update requires at least one column" });
            }
            for (const column of Object.keys(update.set)) {
              if (!knownColumns.has(column)) {
                return status(400, { error: `unknown column "${column}"` });
              }
            }
          }
          for (const insert of body.inserts) {
            for (const column of Object.keys(insert.values)) {
              if (!knownColumns.has(column)) {
                return status(400, { error: `unknown column "${column}"` });
              }
            }
            if (Object.keys(insert.values).length === 0) {
              return status(400, { error: "insert requires at least one value" });
            }
          }

          // Before-images for every targeted row in ONE statement.
          const targets = [...body.updates.map(u => u.pkValues), ...body.deletes.map(d => d.pkValues)];
          const beforeRows: Array<Record<string, unknown>> = [];
          if (targets.length > 0) {
            const select = compileSelectByPkTuples({
              schema: params.schema,
              table: params.table,
              pkColumns,
              tuples: targets,
            });
            beforeRows.push(...(await db.unsafe(select.text, select.params)));
          }
          // PK tuples arrive as positional arrays; rows are objects. Two shapes.
          const tupleKey = (values: readonly unknown[]) => JSON.stringify(values);
          const beforeByKey = new Map(beforeRows.map(row => [tupleKey(pkColumns.map(c => row[c])), row]));

          const snapshots: SnapshotInput[] = [];
          const updateSnapshotIds: number[] = [];
          const appliedUpdates: SaveBody["updates"] = [];
          const appliedDeletes: SaveBody["deletes"] = [];
          let skipped = 0;
          for (const update of body.updates) {
            const before = beforeByKey.get(tupleKey(update.pkValues));
            if (!before) {
              skipped++;
              continue;
            }
            appliedUpdates.push(update);
            snapshots.push({
              schema: params.schema,
              table: params.table,
              pkValues: update.pkValues as SnapshotInput["pkValues"],
              operation: "update",
              beforeImage: before,
            });
          }
          for (const remove of body.deletes) {
            const before = beforeByKey.get(tupleKey(remove.pkValues));
            if (!before) {
              skipped++;
              continue;
            }
            appliedDeletes.push(remove);
            snapshots.push({
              schema: params.schema,
              table: params.table,
              pkValues: remove.pkValues as SnapshotInput["pkValues"],
              operation: "delete",
              beforeImage: before,
            });
          }
          // Inserts are captured AFTER execution via RETURNING while the
          // batch is still pending — the pending batch created below is the
          // two-phase marker, so undo can target generated rows exactly.

          // Cascade-aware capture: children that Postgres would silently
          // delete or null out must be snapshotted BEFORE we touch the DB.
          let cascadedDeletes = 0;
          if (appliedDeletes.length > 0) {
            const cascade = await collectCascadingRows(db, {
              rootSchema: params.schema,
              rootTable: params.table,
              rootPkColumns: pkColumns,
              rootTuples: appliedDeletes.map(d => d.pkValues),
            });
            for (const row of cascade.rows) {
              cascadedDeletes++;
              snapshots.push({
                schema: row.schema,
                table: row.table,
                pkValues: row.pkColumns.map(c => row.row[c] ?? null) as SnapshotInput["pkValues"],
                // Cascaded children are undone by re-insert; nulled references
                // by rewriting the full captured row.
                operation: row.effect === "cascade" ? "delete" : "update",
                beforeImage: row.row,
              });
            }
          }

          // Non-negotiable #3: pending snapshots exist BEFORE Postgres is touched.
          const batchId = backupStore.beginBatch(
            connectionId,
            `${params.schema}.${params.table}`,
          );
          // Update snapshots are tracked so post-mutation after-images can be
          // attached (while still pending) for the History diff view.
          const updateSnapshots = snapshots.filter(s => s.operation === "update");
          try {
            if (updateSnapshots.length > 0) {
              const updateIds = backupStore.addSnapshots(batchId, updateSnapshots);
              updateSnapshotIds.push(...updateIds);
            }
            const restSnapshots = snapshots.filter(s => s.operation !== "update");
            if (restSnapshots.length > 0) backupStore.addSnapshots(batchId, restSnapshots);

            const insertedRows: Array<Record<string, unknown>> = [];
            await db.begin(async tx => {
              for (const update of appliedUpdates) {
                const pk = Object.fromEntries(pkColumns.map((c, i) => [c, update.pkValues[i]]));
                const compiled = compileUpdate({
                  schema: params.schema,
                  table: params.table,
                  set: update.set,
                  pk: pk as Record<string, string | number | boolean | null>,
                });
                await tx.unsafe(compiled.text, compiled.params);
              }
              for (const remove of appliedDeletes) {
                const pk = Object.fromEntries(pkColumns.map((c, i) => [c, remove.pkValues[i]]));
                const compiled = compileDelete({
                  schema: params.schema,
                  table: params.table,
                  pk: pk as Record<string, string | number | boolean | null>,
                });
                await tx.unsafe(compiled.text, compiled.params);
              }
              for (const insert of body.inserts) {
                const compiled = compileInsert({
                  schema: params.schema,
                  table: params.table,
                  values: insert.values,
                });
                // RETURNING lets us attach after-images so undo can target
                // generated rows (identity sequences etc.).
                const returned = await tx.unsafe(`${compiled.text} returning *`, compiled.params);
                insertedRows.push(...(returned as Array<Record<string, unknown>>));
              }
            });

            // Batch is still pending here, so post-mutation captures stay
            // within the two-phase discipline.
            if (insertedRows.length > 0 && pkColumns.length > 0) {
              backupStore.addSnapshots(
                batchId,
                insertedRows.map(row => ({
                  schema: params.schema,
                  table: params.table,
                  pkValues: pkColumns.map(c => row[c] ?? null) as SnapshotInput["pkValues"],
                  operation: "insert" as const,
                  beforeImage: null,
                  afterImage: row,
                })),
              );
            }
            // Attach update after-images so History can render before → after.
            if (updateSnapshotIds.length > 0) {
              const afterSelect = compileSelectByPkTuples({
                schema: params.schema,
                table: params.table,
                pkColumns,
                tuples: appliedUpdates.map(u => u.pkValues),
              });
              const afterRows = await db.unsafe(afterSelect.text, afterSelect.params);
              const afterByKey = new Map(
                (afterRows as Array<Record<string, unknown>>).map(row => [
                  tupleKey(pkColumns.map(c => row[c])),
                  row,
                ]),
              );
              appliedUpdates.forEach((update, index) => {
                const after = afterByKey.get(tupleKey(update.pkValues));
                const snapshotId = updateSnapshotIds[index];
                if (after && snapshotId !== undefined) {
                  backupStore.attachAfterImage(batchId, snapshotId, after);
                }
              });
            }

            backupStore.confirmBatch(batchId);
            return {
              batchId,
              appliedUpdates: appliedUpdates.length,
              appliedDeletes: appliedDeletes.length,
              cascadedDeletes,
              appliedInserts: body.inserts.length,
              skipped,
            };
          } catch (error) {
            // Failed Postgres writes must never look restorable.
            backupStore.failBatch(batchId);
            return status(500, {
              error: `save failed: ${(error as Error).message}`,
              batchId,
            });
          }
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          body: SaveBodySchema,
          response: {
            200: SaveResultSchema,
            400: ApiErrorSchema,
            404: ApiErrorSchema,
            500: t.Object({ error: t.String(), batchId: t.String() }),
          },
        },
      )
      .get(
        "/api/history/batches",
        async () => ({ batches: backupStore.listRestorableBatches(connectionId) }),
        {
          response: t.Object({
            batches: t.Array(
              t.Object({
                id: t.String(),
                connectionId: t.String(),
                createdAt: t.String(),
                status: t.String(),
                description: t.Nullable(t.String()),
              }),
            ),
          }),
        },
      )
      .get(
        "/api/history/batches/:batchId/snapshots",
        async ({ params }) => {
          const batch = backupStore.getBatch(params.batchId);
          if (!batch || batch.connectionId !== connectionId) {
            return status(404, { error: "batch not found" });
          }
          if (batch.status !== "confirmed") {
            return status(409, { error: `batch is ${batch.status}; only confirmed batches are restorable` });
          }
          const snapshots = backupStore.getSnapshots(params.batchId);
          const asCells = (image: Record<string, unknown> | null) =>
            image === null
              ? null
              : (Object.fromEntries(
                  Object.entries(image).map(([k, v]) => [
                    k,
                    typeof v === "boolean" || typeof v === "number" || typeof v === "string"
                      ? v
                      : v === null
                        ? null
                        : v instanceof Date
                          ? v.toISOString()
                          : String(v),
                  ]),
                ) as Record<string, string | number | boolean | null>);
          return {
            batch,
            snapshots: snapshots.map(s => ({
              id: s.id,
              schema: s.schema,
              table: s.table,
              pkValues: s.pkValues,
              operation: s.operation,
              beforeImage: asCells(s.beforeImage),
              afterImage: asCells(s.afterImage ?? null),
            })),
          };
        },
        {
          params: t.Object({ batchId: t.String() }),
          response: {
            200: t.Object({
              batch: t.Object({
                id: t.String(),
                connectionId: t.String(),
                createdAt: t.String(),
                status: t.String(),
                description: t.Nullable(t.String()),
              }),
              snapshots: t.Array(
                t.Object({
                  id: t.Integer(),
                  schema: t.String(),
                  table: t.String(),
                  pkValues: t.Array(CellSchema),
                  operation: t.String(),
                  beforeImage: t.Union([t.Record(t.String(), CellSchema), t.Null()]),
                  afterImage: t.Union([t.Record(t.String(), CellSchema), t.Null()]),
                }),
              ),
            }),
            404: ApiErrorSchema,
            409: ApiErrorSchema,
          },
        },
      )
      .post(
        "/api/history/batches/:batchId/restore",
        async ({ params }) => {
          try {
            const result = await restoreBatch(db, backupStore, {
              batchId: params.batchId,
              connectionId,
            });
            return result;
          } catch (error) {
            if (error instanceof RestoreError) {
              return status(409, { error: error.message });
            }
            return status(500, { error: `restore failed: ${(error as Error).message}` });
          }
        },
        {
          params: t.Object({ batchId: t.String() }),
          response: {
            200: t.Object({
              batchId: t.String(),
              restoredDeletes: t.Integer(),
              restoredInserts: t.Integer(),
              restoredUpdates: t.Integer(),
            }),
            404: ApiErrorSchema,
            409: ApiErrorSchema,
            500: ApiErrorSchema,
          },
        },
      )
      .post(
        "/api/schemas/:schema/tables/:table/references/outgoing",
        async ({ params, body }) => {
          const [columns, pks] = await Promise.all([
            listColumns(db, params.schema, params.table),
            listPrimaryKeys(db),
          ]);
          const pkColumns =
            pks.find(p => p.schema === params.schema && p.table === params.table)?.columns ?? [];
          if (pkColumns.length === 0 || body.pkValues.length !== pkColumns.length) {
            return status(400, { error: "pkValues must match the table primary key" });
          }
          const select = compileSelectByPkTuples({
            schema: params.schema,
            table: params.table,
            pkColumns,
            tuples: [body.pkValues],
          });
          const rows = await db.unsafe(select.text, select.params);
          if (rows.length === 0) {
            return status(404, { error: "row not found" });
          }
          const row = rows[0] as Record<string, string | number | boolean | null>;
          const references = await resolveOutgoingReferences(db, {
            schema: params.schema,
            table: params.table,
            pkColumns,
            row,
          });
          return { outgoing: references };
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          body: t.Object({ pkValues: PkValuesSchema }),
          response: {
            200: t.Object({
              outgoing: t.Array(
                t.Object({
                  constraintName: t.String(),
                  parentSchema: t.String(),
                  parentTable: t.String(),
                  parentColumns: t.Array(t.String()),
                  preview: t.Nullable(
                    t.Object({
                      row: t.Record(t.String(), CellSchema),
                      displayColumn: t.String(),
                    }),
                  ),
                }),
              ),
            }),
            400: ApiErrorSchema,
            404: ApiErrorSchema,
          },
        },
      )
      .post(
        "/api/schemas/:schema/tables/:table/references/incoming",
        async ({ params, body }) => {
          const [columns, pks] = await Promise.all([
            listColumns(db, params.schema, params.table),
            listPrimaryKeys(db),
          ]);
          const pkColumns =
            pks.find(p => p.schema === params.schema && p.table === params.table)?.columns ?? [];
          if (pkColumns.length === 0 || body.pkValues.length !== pkColumns.length) {
            return status(400, { error: "pkValues must match the table primary key" });
          }
          const select = compileSelectByPkTuples({
            schema: params.schema,
            table: params.table,
            pkColumns,
            tuples: [body.pkValues],
          });
          const rows = await db.unsafe(select.text, select.params);
          if (rows.length === 0) {
            return status(404, { error: "row not found" });
          }
          const groups = await resolveIncomingReferences(db, {
            schema: params.schema,
            table: params.table,
            pkColumns,
            row: rows[0] as Record<string, string | number | boolean | null>,
            offset: body.offset ?? 0,
            limit: body.limit ?? 10,
          });
          return { groups };
        },
        {
          params: t.Object({ schema: IdentParam, table: IdentParam }),
          body: t.Object({
            pkValues: PkValuesSchema,
            offset: t.Optional(t.Number({ minimum: 0 })),
            limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
          }),
          response: {
            200: t.Object({
              groups: t.Array(
                t.Object({
                  constraintName: t.String(),
                  childSchema: t.String(),
                  childTable: t.String(),
                  childColumns: t.Array(t.String()),
                  totalCount: t.Integer(),
                  rows: t.Array(t.Record(t.String(), CellSchema)),
                  nextOffset: t.Nullable(t.Integer()),
                }),
              ),
            }),
            400: ApiErrorSchema,
            404: ApiErrorSchema,
          },
        },
      )
      .onStop(async () => {
        await db.close();
        backupStore.close();
      })
  );

  if (config.staticDir) {
    mkdirSync(config.staticDir, { recursive: true });
    attachStatic(app, config.staticDir);
  }
  return app;
}
