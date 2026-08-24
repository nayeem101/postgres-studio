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
}

export interface BatchRecord {
  id: string;
  connectionId: string;
  createdAt: string;
  status: BatchStatus;
  description: string | null;
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
   */
  addSnapshots(batchId: string, records: readonly SnapshotInput[]): void {
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
         (batch_id, table_schema, table_name, pk_values, operation, before_image, created_at)
       values ($batch, $schema, $table, $pk, $op, $img, $at)`,
    );

    const writeAll = this.database.transaction((rows: readonly SnapshotInput[]) => {
      const at = new Date().toISOString();
      for (const r of rows) {
        insert.run({
          $batch: batchId,
          $schema: r.schema,
          $table: r.table,
          $pk: JSON.stringify(r.pkValues),
          $op: r.operation,
          $img: r.beforeImage === null ? null : JSON.stringify(r.beforeImage),
          $at: at,
        });
      }
    });
    writeAll(records);
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
      .query("select id, connection_id, created_at, status, description from batches where id = $id")
      .get({ $id: batchId }) as
      | { id: string; connection_id: string; created_at: string; status: string; description: string | null }
      | null;
    if (!row) return null;
    return {
      id: row.id,
      connectionId: row.connection_id,
      createdAt: row.created_at,
      status: parseStatus(row.status),
      description: row.description,
    };
  }

  /** History/restore source of truth: confirmed batches only. */
  listRestorableBatches(connectionId?: string): BatchRecord[] {
    const rows = (
      connectionId
        ? this.database
            .query(
              "select id, connection_id, created_at, status, description from batches where status = 'confirmed' and connection_id = $cid order by created_at desc",
            )
            .all({ $cid: connectionId })
        : this.database
            .query(
              "select id, connection_id, created_at, status, description from batches where status = 'confirmed' order by created_at desc",
            )
            .all()
    ) as Array<{ id: string; connection_id: string; created_at: string; status: string; description: string | null }>;

    return rows.map(row => ({
      id: row.id,
      connectionId: row.connection_id,
      createdAt: row.created_at,
      status: parseStatus(row.status),
      description: row.description,
    }));
  }

  getSnapshots(batchId: string): Array<SnapshotInput & { id: number }> {
    const rows = this.database
      .query(
        "select id, table_schema, table_name, pk_values, operation, before_image from snapshots where batch_id = $id order by id",
      )
      .all({ $id: batchId }) as Array<{
      id: number;
      table_schema: string;
      table_name: string;
      pk_values: string;
      operation: string;
      before_image: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      schema: row.table_schema,
      table: row.table_name,
      pkValues: JSON.parse(row.pk_values) as Array<string | number>,
      operation: parseOperation(row.operation),
      beforeImage: row.before_image === null ? null : (JSON.parse(row.before_image) as Record<string, unknown>),
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
      // The row does not exist yet: no PK, no before image.
      if (r.pkValues.length !== 0) {
        throw new BackupStoreError("insert snapshots must not carry a pk tuple");
      }
      if (r.beforeImage !== null) {
        throw new BackupStoreError("insert snapshots must not carry a before image");
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
