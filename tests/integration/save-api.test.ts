import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { treaty } from "@elysiajs/eden";
import { BackupStore } from "../../apps/server/src/backup";
import { connectionIdFromUrl, createServerApp } from "../../apps/server/src/server-app";
import { createSeededTestDb } from "./helpers";

let db: SQL;
let app: ReturnType<typeof createServerApp>;
let api: ReturnType<typeof treaty<ReturnType<typeof createServerApp>>>;
let store: BackupStore;

beforeAll(async () => {
  db = await createSeededTestDb();
  store = new BackupStore(new (await import("bun:sqlite")).Database(":memory:"));
  store.init();
  app = createServerApp({
    databaseUrl: process.env.TEST_DATABASE_URL!,
    backupStore: store,
  });
  api = treaty(app);
});

afterAll(async () => {
  if ((app as unknown as { server?: unknown }).server) app.stop(true);
  await db.close();
});

const ordersSave = () => api.api.schemas({ schema: "public" }).tables({ table: "orders" }).save;
const employeesSave = () =>
  api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save;
const customersSave = () =>
  api.api.schemas({ schema: "public" }).tables({ table: "customers" }).save;

describe("POST .../save", () => {
  test("successful update commits and records a restorable before-image", async () => {
    const res = await ordersSave().post({
      updates: [{ pkValues: [1, 100], set: { total: "123.45" } }],
      deletes: [],
      inserts: [],
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ appliedUpdates: 1, skipped: 0 });

    const check = await db`
      select total::text as total from public.orders where shop_id = 1 and order_no = 100
    `;
    expect(check[0]?.total).toBe("123.45");

    const batch = store.getBatch(res.data!.batchId)!;
    expect(batch.status).toBe("confirmed");
    expect(store.listRestorableBatches().map(b => b.id)).toContain(batch.id);

    const snapshots = store.getSnapshots(batch.id);
    expect(snapshots[0]?.beforeImage).toMatchObject({ total: "150.00" });
  });

  test("failed write marks the batch failed; DB unchanged; not restorable", async () => {
    const before = await db`select count(*)::int as n from public.employees`;

    const res = await employeesSave().post({
      // name is NOT NULL — Postgres must reject the whole transaction
      updates: [{ pkValues: [2], set: { name: null } }],
      deletes: [],
      inserts: [],
    });

    expect(res.error?.status).toBe(500);
    const failedBatchId = (res.error!.value as { batchId: string }).batchId;
    expect(store.getBatch(failedBatchId)?.status).toBe("failed");
    expect(store.listRestorableBatches().map(b => b.id)).not.toContain(failedBatchId);

    const after = await db`select count(*)::int as n from public.employees`;
    expect(after[0]?.n).toBe(before[0]?.n);
    const grace = await db`select name from public.employees where id = 2`;
    expect(grace[0]?.name).toBe("Grace Hopper");
  });

  test("delete cascades through FKs while snapshots capture the parent", async () => {
    const addressesBefore = await db`select count(*)::int as n from public.addresses`;
    expect(addressesBefore[0]?.n).toBe(3);

    const res = await customersSave().post({
      updates: [],
      deletes: [{ pkValues: [1] }],
      inserts: [],
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ appliedDeletes: 1 });

    const addressesAfter = await db`select count(*)::int as n from public.addresses`;
    expect(addressesAfter[0]?.n).toBe(1);

    const snapshots = store.getSnapshots(res.data!.batchId);
    expect(snapshots[0]).toMatchObject({ operation: "delete", table: "customers" });
    expect(snapshots[0]?.beforeImage).toMatchObject({ id: 1, email: "ada@example.com" });
  });

  test("insert path applies new rows with insert snapshots", async () => {
    const res = await employeesSave().post({
      updates: [],
      deletes: [],
      inserts: [{ values: { name: "Katherine Johnson", manager_id: 1 } }],
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ appliedInserts: 1 });

    const rows = await db`select name from public.employees where name = 'Katherine Johnson'`;
    expect(rows).toHaveLength(1);

    const snapshots = store.getSnapshots(res.data!.batchId);
    expect(snapshots[0]).toMatchObject({ operation: "insert", beforeImage: null });
  });

  test("unknown column is rejected before any snapshot exists", async () => {
    const batchesBefore = store.listRestorableBatches().length;
    const res = await ordersSave().post({
      updates: [{ pkValues: [1, 100], set: { nope: 1 } }],
      deletes: [],
      inserts: [],
    });
    expect(res.error?.status).toBe(400);
    expect(JSON.stringify(res.error!.value)).toContain("unknown column");
    expect(store.listRestorableBatches().length).toBe(batchesBefore);
  });

  test("empty payload and pk-arity mismatch are 400s", async () => {
    const empty = await ordersSave().post({ updates: [], deletes: [], inserts: [] });
    expect(empty.error?.status).toBe(400);

    const arity = await ordersSave().post({
      updates: [{ pkValues: [1], set: { total: "1.00" } }],
      deletes: [],
      inserts: [],
    });
    expect(arity.error?.status).toBe(400);
  });

  test("connection id derivation is stable and secret-free", () => {
    const a = connectionIdFromUrl("postgres://user:hunter2@host/db");
    const b = connectionIdFromUrl("postgres://user:hunter2@host/db");
    const c = connectionIdFromUrl("postgres://user:other@host/db");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).not.toContain("hunter2");
  });
});
