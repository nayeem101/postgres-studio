import type { SQL } from "bun";
import {
  compileDelete,
  compileInsert,
  compileUpdate,
  listColumns,
  listIncomingFks,
  listPrimaryKeys,
  topoRestoreOrder,
  tableKey,
  type FkEdge,
  type TableRef,
} from "@pg-studio/db";
import type { BackupStore, SnapshotInput } from "./backup";

/**
 * Batch rollback (Phase 3): replays a confirmed batch's snapshots in reverse
 * inside ONE Postgres transaction. Deletes-of-inserts run child-first;
 * re-inserts/updates run parent-first (topological). Schema drift between
 * capture and restore aborts loudly instead of silently dropping columns.
 */

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

export interface RestoreResult {
  batchId: string;
  restoredDeletes: number;
  restoredInserts: number;
  restoredUpdates: number;
}

type CellPayload = Record<string, string | number | boolean | null>;

interface UndoOp {
  kind: "insert-undo" | "delete-undo" | "update-undo";
  schema: string;
  table: string;
  /** Kept structured so ops can be topologically ordered before compiling. */
  payload: CellPayload;
  pk: CellPayload;
}

const asCells = (image: Record<string, unknown>): CellPayload =>
  Object.fromEntries(
    Object.entries(image).map(([k, v]) => [
      k,
      typeof v === "boolean" || typeof v === "number" || typeof v === "string" ? v : v === null ? null : String(v),
    ]),
  ) as CellPayload;

const refOf = (schema: string, table: string): TableRef => ({ schema, name: table });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export async function restoreBatch(
  db: SQL,
  backupStore: BackupStore,
  options: { batchId: string; connectionId: string },
): Promise<RestoreResult> {
  const batch = backupStore.getBatch(options.batchId);
  if (!batch) throw new RestoreError(`batch ${options.batchId} not found`);
  if (batch.connectionId !== options.connectionId) {
    throw new RestoreError("batch belongs to a different connection");
  }
  if (batch.status !== "confirmed") {
    // Non-negotiable #3: failed writes never look restorable.
    throw new RestoreError(`batch is ${batch.status}; only confirmed batches can be restored`);
  }
  if (batch.restoredAt !== null) {
    throw new RestoreError("batch has already been restored");
  }

  const snapshots = backupStore.getSnapshots(options.batchId);
  if (snapshots.length === 0) throw new RestoreError("batch has no snapshots");

  await assertNoSchemaDrift(db, snapshots);

  const pks = await listPrimaryKeys(db);
  const pkByTable = new Map<string, string[]>();
  for (const pk of pks) pkByTable.set(`${pk.schema}.${pk.table}`, pk.columns);

  const [insertUndos, deleteUndos, updateUndos] = partitionUndoOps(snapshots, pkByTable);
  const involvedTables = distinctTables(snapshots);
  const edges = await collectEdges(db, involvedTables);

  const applied = { batchId: options.batchId, restoredDeletes: 0, restoredInserts: 0, restoredUpdates: 0 };

  await db.begin(async tx => {
    // Undoing inserts removes rows: children must go before parents.
    const removeOrder = topoRestoreOrder(involvedTables, edges).reverse();
    for (const table of removeOrder) {
      for (const op of insertUndos.filter(op => op.schema === table.schema && op.table === table.name)) {
        const compiled = compileDelete({ schema: op.schema, table: op.table, pk: op.pk });
        await tx.unsafe(compiled.text, compiled.params);
        applied.restoredInserts++;
      }
    }
    // Undoing deletes/updates brings rows back: parents before children.
    const restoreOrder = topoRestoreOrder(involvedTables, edges);
    for (const table of restoreOrder) {
      for (const op of deleteUndos.filter(op => op.schema === table.schema && op.table === table.name)) {
        const compiled = compileInsert({ schema: op.schema, table: op.table, values: op.payload });
        await tx.unsafe(compiled.text, compiled.params);
        applied.restoredDeletes++;
      }
      for (const op of updateUndos.filter(op => op.schema === table.schema && op.table === table.name)) {
        const compiled = compileUpdate({ schema: op.schema, table: op.table, set: op.payload, pk: op.pk });
        await tx.unsafe(compiled.text, compiled.params);
        applied.restoredUpdates++;
      }
    }
  });

  backupStore.markRestored(options.batchId);
  return applied;
}

function partitionUndoOps(
  snapshots: Array<SnapshotInput & { id: number }>,
  pkByTable: Map<string, string[]>,
): [UndoOp[], UndoOp[], UndoOp[]] {
  const insertUndos: UndoOp[] = [];
  const deleteUndos: UndoOp[] = [];
  const updateUndos: UndoOp[] = [];

  for (const snap of snapshots) {
    const declaredPk = pkByTable.get(`${snap.schema}.${snap.table}`);
    if (snap.operation === "insert") {
      if (!isRecord(snap.afterImage)) {
        throw new RestoreError(
          `insert snapshot #${snap.id} lacks an after-image (captured by an older version); cannot undo`,
        );
      }
      const pk = pickPk(snap.afterImage, declaredPk);
      if (Object.keys(pk).length === 0) {
        throw new RestoreError(`insert snapshot #${snap.id} has no primary key columns`);
      }
      insertUndos.push({ kind: "insert-undo", schema: snap.schema, table: snap.table, payload: asCells(snap.afterImage), pk });
      continue;
    }
    if (!isRecord(snap.beforeImage)) {
      throw new RestoreError(`snapshot #${snap.id} (${snap.operation}) lacks its before-image`);
    }
    if (snap.operation === "delete") {
      deleteUndos.push({
        kind: "delete-undo",
        schema: snap.schema,
        table: snap.table,
        payload: asCells(snap.beforeImage),
        pk: pickPk(snap.beforeImage, declaredPk),
      });
    } else {
      updateUndos.push({
        kind: "update-undo",
        schema: snap.schema,
        table: snap.table,
        payload: asCells(snap.beforeImage),
        pk: pickPk(snap.beforeImage, declaredPk),
      });
    }
  }
  return [insertUndos, deleteUndos, updateUndos];
}

/** PK projection from a captured image using the table's declared key. */
function pickPk(image: Record<string, unknown>, declaredPk: string[] | undefined): CellPayload {
  const keys = declaredPk ?? Object.keys(image).filter(k => k.toLowerCase() === "id" || k.toLowerCase().endsWith("_id"));
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in image) picked[key] = image[key];
  }
  return picked as CellPayload;
}

async function assertNoSchemaDrift(db: SQL, snapshots: Array<SnapshotInput & { id: number }>): Promise<void> {
  const pks = await listPrimaryKeys(db);
  const columnCache = new Map<string, Set<string>>();
  const problems: string[] = [];

  for (const snap of snapshots) {
    const key = `${snap.schema}.${snap.table}`;
    let current = columnCache.get(key);
    if (!current) {
      current = new Set((await listColumns(db, snap.schema, snap.table)).map(c => c.name));
      columnCache.set(key, current);
    }
    const image = snap.beforeImage ?? snap.afterImage;
    if (!isRecord(image)) continue;
    const missing = Object.keys(image).filter(column => !current.has(column));
    if (missing.length > 0) {
      problems.push(`${key}: captured column(s) ${missing.join(", ")} no longer exist`);
    }
  }

  // Validate pk tuples still match arity so undo can address the row.
  for (const snap of snapshots) {
    if (snap.operation !== "delete" && snap.operation !== "update") continue;
    const pkMeta = pks.find(p => p.schema === snap.schema && p.table === snap.table);
    if (pkMeta && pkMeta.columns.length !== snap.pkValues.length) {
      problems.push(`${snap.schema}.${snap.table}: primary key shape changed since capture`);
    }
  }

  if (problems.length > 0) {
    throw new RestoreError(`schema drift detected — restore aborted: ${problems.join("; ")}`);
  }
}

function distinctTables(snapshots: Array<SnapshotInput>): TableRef[] {
  const seen = new Map<string, TableRef>();
  for (const snap of snapshots) seen.set(`${snap.schema}.${snap.table}`, refOf(snap.schema, snap.table));
  return [...seen.values()];
}

async function collectEdges(db: SQL, tables: TableRef[]): Promise<FkEdge[]> {
  const edges: FkEdge[] = [];
  const cache = new Set<string>();
  for (const table of tables) {
    const key = tableKey(table);
    if (cache.has(key)) continue;
    cache.add(key);
    for (const fk of await listIncomingFks(db, table.schema, table.name)) {
      edges.push({ from: { schema: fk.childSchema, name: fk.childTable }, to: { schema: fk.parentSchema, name: fk.parentTable } });
    }
  }
  return edges;
}
