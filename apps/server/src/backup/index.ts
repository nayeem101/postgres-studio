import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Local bun:sqlite rollback store — one file per connection under
 * ~/.pg-studio/backups/<connection-id>.sqlite (AGENTS.md).
 *
 * Two-phase discipline: every mutation flow MUST record its batch and
 * before-images here (status `pending`) BEFORE touching Postgres, then mark
 * the batch `confirmed` after commit or `failed` after abort. Only
 * `confirmed` batches ever appear restorable in History.
 */

export type BatchStatus = "pending" | "confirmed" | "failed";

export type SnapshotOperation = "insert" | "update" | "delete";

export interface SnapshotInput {
  schema: string;
  table: string;
  /** Primary-key tuple identifying the row (composite-safe). */
  pkValues: Array<string | number>;
  operation: SnapshotOperation;
  /**
   * Row state before the mutation. Required for update/delete (the actual
   * undo payload); must be omitted for insert (undo = delete by PK).
   */
  beforeImage: Record<string, unknown> | null;
  /**
   * Row state after the mutation. Captured for INSERTs via RETURNING so undo
   * knows which generated row to remove; optional for updates (diff UI).
   */
  afterImage?: Record<string, unknown> | null;
}

export interface BatchRecord {
  id: string;
  connectionId: string;
  createdAt: string;
  status: BatchStatus;
  description: string | null;
  /** Non-null once rolled back; such batches leave History and cannot re-restore. */
  restoredAt: string | null;
}

export class BackupStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupStoreError";
  }
}

const STATUSES: readonly BatchStatus[] = ["pending", "confirmed", "failed"];

export class BackupStore {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  /** Open (creating directories as needed) the store file for one connection. */
  static open(path: string): BackupStore {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const database = new Database(path);
    database.run("PRAGMA journal_mode = WAL;");
    return new BackupStore(database);
  }

  /** Create tables if missing. Safe to call on every startup. */
  init(): void {
    this.database.run(`
      create table if not exists batches (
        id text primary key,
        connection_id text not null,
        created_at text not null,
        status text not null check (status in ('pending', 'confirmed', 'failed')),
        description text
      );
      create table if not exists snapshots (
        id integer primary key autoincrement,
        batch_id text not null references batches (id),
        table_schema text not null,
        table_name text not null,
        pk_values text not null,
        operation text not null check (operation in ('insert', 'update', 'delete')),
        before_image text,
        created_at text not null
      );
      create index if not exists snapshots_batch_idx on snapshots (batch_id);
    `);
    this.migrate();
  }

  /** Additive migrations for stores created by older versions. */
  private migrate(): void {
    const snapshotColumns = new Set<string>(
      (this.database.query("pragma table_info(snapshots)").all() as Array<{ name: string }>).map(r => r.name),
    );
    if (!snapshotColumns.has("after_image")) {
      this.database.run("alter table snapshots add column after_image text");
    }
    const batchColumns = new Set<string>(
      (this.database.query("pragma table_info(batches)").all() as Array<{ name: string }>).map(r => r.name),
    );
    if (!batchColumns.has("restored_at")) {
      this.database.run("alter table batches add column restored_at text");
    }
  }

  close(throwOnError = false): void {
    this.database.close(throwOnError);
  }

  beginBatch(connectionId: string, description?: string): string {
    if (!connectionId.trim()) throw new BackupStoreError("connectionId is required");
    const id = crypto.randomUUID();
    this.database
      .query("insert into batches (id, connection_id, created_at, status, description) values ($id, $cid, $at, 'pending', $desc)")
      .run({
        $id: id,
        $cid: connectionId,
        $at: new Date().toISOString(),
        $desc: description ?? null,
      });
    return id;
  }

  /**
   * Atomically attach before-images to a pending batch. Any invalid record
   * aborts the whole insert so a half-captured batch can never exist.
   * Returns the inserted snapshot ids so callers can enrich records later
   * (e.g. attaching update after-images) while the batch is still pending.
   */
  addSnapshots(batchId: string, records: readonly SnapshotInput[]): number[] {
    const batch = this.getBatch(batchId);
    if (!batch) throw new BackupStoreError(`batch ${batchId} not found`);
    if (batch.status !== "pending") {
      throw new BackupStoreError(`cannot add snapshots to ${batch.status} batch`);
    }
    if (records.length === 0) throw new BackupStoreError("addSnapshots requires at least one record");

    for (const r of records) {
      this.assertSnapshotShape(r);
    }

    const insert = this.database.query(
      `insert into snapshots
         (batch_id, table_schema, table_name, pk_values, operation, before_image, after_image, created_at)
       values ($batch, $schema, $table, $pk, $op, $img, $afterImg, $at)`,
    );

    const ids: number[] = [];
    const writeAll = this.database.transaction((rows: readonly SnapshotInput[]) => {
      const at = new Date().toISOString();
      for (const r of rows) {
        const result = insert.run({
          $batch: batchId,
          $schema: r.schema,
          $table: r.table,
          $pk: JSON.stringify(r.pkValues),
          $op: r.operation,
          $img: r.beforeImage === null ? null : JSON.stringify(r.beforeImage),
          $afterImg: r.afterImage == null ? null : JSON.stringify(r.afterImage),
          $at: at,
        });
        ids.push(Number(result.lastInsertRowid));
      }
    });
    writeAll(records);
    return ids;
  }

  /** Fill in an update snapshot's after-image; only allowed pre-confirmation. */
  attachAfterImage(batchId: string, snapshotId: number, image: Record<string, unknown>): void {
    const batch = this.getBatch(batchId);
    if (!batch || batch.status !== "pending") {
      throw new BackupStoreError("after-images can only be attached to pending batches");
    }
    this.database
      .query("update snapshots set after_image = $img where id = $id and batch_id = $batch")
      .run({ $img: JSON.stringify(image), $id: snapshotId, $batch: batchId });
  }

  /** Mark a pending batch as committed to Postgres (becomes restorable). */
  confirmBatch(batchId: string): void {
    this.transition(batchId, "pending", "confirmed");
  }

  /** Mark a pending batch as aborted. Failed batches are never restorable. */
  failBatch(batchId: string): void {
    this.transition(batchId, "pending", "failed");
  }

  getBatch(batchId: string): BatchRecord | null {
    const row = this.database
      .query(
        "select id, connection_id, created_at, status, description, restored_at from batches where id = $id",
      )
      .get({ $id: batchId }) as
      | {
          id: string;
          connection_id: string;
          created_at: string;
          status: string;
          description: string | null;
          restored_at: string | null;
        }
      | null;
    if (!row) return null;
    return {
      id: row.id,
      connectionId: row.connection_id,
      createdAt: row.created_at,
      status: parseStatus(row.status),
      description: row.description,
      restoredAt: row.restored_at,
    };
  }

  /** History/restore source of truth: confirmed batches only, never re-restorable. */
  listRestorableBatches(connectionId?: string): BatchRecord[] {
    const rows = (
      connectionId
        ? this.database
            .query(
              "select id, connection_id, created_at, status, description from batches where status = 'confirmed' and restored_at is null and connection_id = $cid order by created_at desc",
            )
            .all({ $cid: connectionId })
        : this.database
            .query(
              "select id, connection_id, created_at, status, description from batches where status = 'confirmed' and restored_at is null order by created_at desc",
            )
            .all()
    ) as Array<{ id: string; connection_id: string; created_at: string; status: string; description: string | null }>;

    return rows.map(row => ({
      id: row.id,
      connectionId: row.connection_id,
      createdAt: row.created_at,
      status: parseStatus(row.status),
      description: row.description,
      restoredAt: null,
    }));
  }

  /** Stamp a confirmed batch as rolled back so History stops offering it. */
  markRestored(batchId: string): void {
    const batch = this.getBatch(batchId);
    if (!batch) throw new BackupStoreError(`batch ${batchId} not found`);
    if (batch.status !== "confirmed") {
      throw new BackupStoreError(`only confirmed batches can be restored (batch is ${batch.status})`);
    }
    this.database
      .query("update batches set restored_at = $at where id = $id")
      .run({ $at: new Date().toISOString(), $id: batchId });
  }

  /**
   * Retention (Phase 3): drop batches older than `maxAgeDays` and/or keep
   * only the newest `maxBatches` per connection scope.
   */
  prune(options: { maxAgeDays?: number; maxBatches?: number; connectionId?: string } = {}): number {
    let removed = 0;

    if (options.maxAgeDays !== undefined) {
      if (!(options.maxAgeDays > 0)) throw new BackupStoreError("maxAgeDays must be positive");
      const cutoff = new Date(Date.now() - options.maxAgeDays * 86_400_000).toISOString();
      const stale = (
        options.connectionId
          ? this.database
              .query("select id from batches where created_at < $cutoff and connection_id = $cid")
              .all({ $cutoff: cutoff, $cid: options.connectionId })
          : this.database.query("select id from batches where created_at < $cutoff").all({ $cutoff: cutoff })
      ) as Array<{ id: string }>;
      removed += this.deleteBatches(stale.map(r => r.id));
    }

    if (options.maxBatches !== undefined) {
      if (!(options.maxBatches >= 0)) throw new BackupStoreError("maxBatches must be >= 0");
      const keepSql = options.connectionId
        ? "select id from batches where connection_id = $cid order by created_at desc limit $keep"
        : "select id from batches order by created_at desc limit $keep";
      const keepers = this.database.query(keepSql).all({
        ...(options.connectionId ? { $cid: options.connectionId } : {}),
        $keep: options.maxBatches,
      }) as Array<{ id: string }>;
      const keeperSet = new Set(keepers.map(r => r.id));
      const all = (
        options.connectionId
          ? this.database.query("select id from batches where connection_id = $cid").all({ $cid: options.connectionId })
          : this.database.query("select id from batches").all()
      ) as Array<{ id: string }>;
      removed += this.deleteBatches(all.filter(r => !keeperSet.has(r.id)).map(r => r.id));
    }
    return removed;
  }

  /** Manual clear: wipe every batch for a connection (or all). */
  clearAll(connectionId?: string): number {
    const rows = (
      connectionId
        ? this.database.query("select id from batches where connection_id = $cid").all({ $cid: connectionId })
        : this.database.query("select id from batches").all()
    ) as Array<{ id: string }>;
    return this.deleteBatches(rows.map(r => r.id));
  }

  private deleteBatches(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const removeSnapshots = this.database.query("delete from snapshots where batch_id = $id");
    const removeBatch = this.database.query("delete from batches where id = $id");
    const wipe = this.database.transaction((batchIds: readonly string[]) => {
      for (const id of batchIds) {
        removeSnapshots.run({ $id: id });
        removeBatch.run({ $id: id });
      }
    });
    wipe(ids);
    return ids.length;
  }

  getSnapshots(batchId: string): Array<SnapshotInput & { id: number }> {
    const rows = this.database
      .query(
        "select id, table_schema, table_name, pk_values, operation, before_image, after_image from snapshots where batch_id = $id order by id",
      )
      .all({ $id: batchId }) as Array<{
      id: number;
      table_schema: string;
      table_name: string;
      pk_values: string;
      operation: string;
      before_image: string | null;
      after_image: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      schema: row.table_schema,
      table: row.table_name,
      pkValues: JSON.parse(row.pk_values) as Array<string | number>,
      operation: parseOperation(row.operation),
      beforeImage: row.before_image === null ? null : (JSON.parse(row.before_image) as Record<string, unknown>),
      afterImage:
        row.after_image === null ? null : (JSON.parse(row.after_image) as Record<string, unknown>),
    }));
  }

  private transition(batchId: string, from: BatchStatus, to: BatchStatus): void {
    const result = this.database
      .query("update batches set status = $to where id = $id and status = $from")
      .run({ $to: to, $id: batchId, $from: from });
    if (result.changes === 0) {
      const current = this.getBatch(batchId);
      throw new BackupStoreError(
        current
          ? `cannot move batch from ${current.status} to ${to}`
          : `batch ${batchId} not found`,
      );
    }
  }

  private assertSnapshotShape(r: SnapshotInput): void {
    if (typeof r.schema !== "string" || r.schema.length === 0 || typeof r.table !== "string" || r.table.length === 0) {
      throw new BackupStoreError("snapshot requires schema and table");
    }
    if (!["insert", "update", "delete"].includes(r.operation)) {
      throw new BackupStoreError(`unknown snapshot operation ${String(r.operation)}`);
    }
    if (r.operation === "insert") {
      // The row did not exist before: never a before image. PK/after-image are
      // attached afterwards via RETURNING so undo can target the generated row.
      if (r.beforeImage !== null) {
        throw new BackupStoreError("insert snapshots must not carry a before image");
      }
      const hasPk = Array.isArray(r.pkValues) && r.pkValues.length > 0;
      const hasAfter = r.afterImage != null;
      if (hasPk !== hasAfter) {
        throw new BackupStoreError("insert snapshots need pk tuple and after image together");
      }
      return;
    }
    if (!Array.isArray(r.pkValues) || r.pkValues.length === 0) {
      throw new BackupStoreError(`${r.operation} snapshots require a non-empty pk tuple`);
    }
    if (r.beforeImage === null) {
      throw new BackupStoreError(`${r.operation} snapshots require a before image`);
    }
  }
}

function parseStatus(value: string): BatchStatus {
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new BackupStoreError(`corrupt batch status ${value}`);
  }
  return value as BatchStatus;
}

function parseOperation(value: string): SnapshotOperation {
  if (value !== "insert" && value !== "update" && value !== "delete") {
    throw new BackupStoreError(`corrupt snapshot operation ${value}`);
  }
  return value;
}
