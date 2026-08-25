import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { treaty } from "@elysiajs/eden";
import { createSeededTestDb } from "./helpers";
import { createServerApp } from "../../apps/server/src/server-app";
import { BackupStore } from "../../apps/server/src/backup";

let db: SQL;
let app: ReturnType<typeof createServerApp>;
let api: ReturnType<typeof treaty<ReturnType<typeof createServerApp>>>;

beforeAll(async () => {
  db = await createSeededTestDb();
  const { Database } = await import("bun:sqlite");
  const store = new BackupStore(new Database(":memory:"));
  store.init();
  app = createServerApp({ databaseUrl: process.env.TEST_DATABASE_URL!, backupStore: store });
  api = treaty(app);
});

afterAll(async () => {
  if ((app as unknown as { server?: unknown }).server) app.stop(true);
  await db.close();
});

const scalar = async (query: string): Promise<number> => {
  const rows = await db.unsafe(query);
  return Number((rows[0] as Record<string, unknown>).n);
};

const restorableIds = async () => {
  const res = await api.api.history.batches.get();
  return (res.data?.batches ?? []).map(b => b.id);
};

describe("cascade-aware capture", () => {
  test("deleting a customer snapshots its cascaded addresses and restores them", async () => {
    const beforeAddresses = await scalar("select count(*)::int as n from public.addresses");

    const save = await api.api.schemas({ schema: "public" }).tables({ table: "customers" }).save.post({
      updates: [],
      inserts: [],
      deletes: [{ pkValues: [1] }],
    });
    expect(save.error).toBeNull();
    expect(save.data!.appliedDeletes).toBe(1);
    // Customer 1 owns three of the four seeded addresses.
    expect(save.data!.cascadedDeletes).toBe(3);

    const midAddresses = await scalar("select count(*)::int as n from public.addresses");
    expect(midAddresses).toBe(beforeAddresses - 3);

    const batchId = save.data!.batchId;
    const snapshotsRes = await api.api.history.batches({ batchId }).snapshots.get();
    const deletedTables = snapshotsRes.data!.snapshots.filter(s => s.operation === "delete");
    expect(deletedTables.map(s => s.table).sort()).toEqual([
      "addresses",
      "addresses",
      "addresses",
      "customers",
    ]);
    // Before-images carry full rows for undo.
    const addressSnapshot = deletedTables.find(s => s.table === "addresses")!;
    expect(addressSnapshot.beforeImage).toMatchObject({ customer_id: 1 });

    const restore = await api.api.history.batches({ batchId }).restore.post();
    expect(restore.error).toBeNull();
    expect(restore.data!.restoredDeletes).toBe(4); // customer + 3 addresses

    expect(await scalar("select count(*)::int as n from public.addresses")).toBe(beforeAddresses);
    expect(await scalar("select count(*)::int as n from public.customers where id = 1")).toBe(1);
  });

  test("restoring consumes the batch so History empties", async () => {
    expect(await restorableIds()).toHaveLength(0);
  });

  test("leaf delete captures nothing extra (NO ACTION edges ignored)", async () => {
    const save = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save.post({
      updates: [],
      inserts: [],
      deletes: [{ pkValues: [3] }], // Alan: no reports, no cascade children
    });
    expect(save.error).toBeNull();
    expect(save.data!.cascadedDeletes).toBe(0);

    // Leave no restorable residue for later assertions.
    await api.api.history.batches({ batchId: save.data!.batchId }).restore.post();
    expect(await restorableIds()).toHaveLength(0);
  });
});

describe("insert undo via RETURNING", () => {
  test("restoring an insert batch removes the generated row", async () => {
    const before = await scalar("select count(*)::int as n from public.employees");

    const save = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save.post({
      updates: [],
      deletes: [],
      inserts: [{ values: { id: 50, name: "Temp Person", manager_id: null } }],
    });
    expect(save.error).toBeNull();
    expect(await scalar("select count(*)::int as n from public.employees")).toBe(before + 1);

    const batchId = save.data!.batchId;
    const snaps = await api.api.history.batches({ batchId }).snapshots.get();
    const insertSnap = snaps.data!.snapshots.find(s => s.operation === "insert")!;
    expect(insertSnap.pkValues).toEqual([50]);
    expect(insertSnap.afterImage).toMatchObject({ id: 50, name: "Temp Person" });

    const restore = await api.api.history.batches({ batchId }).restore.post();
    expect(restore.data!.restoredInserts).toBe(1);
    expect(await scalar("select count(*)::int as n from public.employees")).toBe(before);
  });
});

describe("update undo", () => {
  test("restore rewinds edited cells to their before-image", async () => {
    const save = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).save.post({
      inserts: [],
      deletes: [],
      updates: [{ pkValues: [1, 100], set: { total: 999.99 } }],
    });
    expect(save.error).toBeNull();

    const restore = await api.api.history.batches({ batchId: save.data!.batchId }).restore.post();
    expect(restore.data!.restoredUpdates).toBe(1);

    const [row] = await db`select total::text as t from public.orders where shop_id = 1 and order_no = 100`;
    expect(Number((row as Record<string, unknown>).t)).toBe(150);
  });
});

describe("failed writes are never restorable", () => {
  test("constraint violation marks batch failed and History hides it", async () => {
    expect(await restorableIds()).toHaveLength(0);

    const badSave = await api.api.schemas({ schema: "public" }).tables({ table: "order_items" }).save.post({
      updates: [],
      deletes: [],
      inserts: [{ values: { id: 90, shop_id: 9, order_no: 999, product: "ghost", quantity: 1 } }],
    });
    expect(badSave.error?.status).toBe(500);

    expect(await restorableIds()).toHaveLength(0);

    const snapshotsRes = await api.api.history.batches({ batchId: "does-not-exist" }).snapshots.get();
    expect(snapshotsRes.error?.status).toBe(404);
  });
});

describe("double restore is rejected", () => {
  test("second restore returns 409", async () => {
    const save = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save.post({
      updates: [],
      deletes: [],
      inserts: [{ values: { id: 51, name: "Once Only" } }],
    });
    const batchId = save.data!.batchId;

    const first = await api.api.history.batches({ batchId }).restore.post();
    expect(first.error).toBeNull();
    const second = await api.api.history.batches({ batchId }).restore.post();
    expect(second.error?.status).toBe(409);
  });
});

describe("schema drift aborts restore", () => {
  test("dropped captured column surfaces a 409, never a silent drop", async () => {
    const save = await api.api.schemas({ schema: "public" }).tables({ table: "order_items" }).save.post({
      updates: [],
      deletes: [],
      inserts: [{ values: { shop_id: 1, order_no: 101, product: "drift probe", quantity: 1 } }],
    });
    expect(save.error).toBeNull();

    // Simulate drift AFTER capture: the snapshot's before/after images now
    // reference a column the live table no longer has.
    await db`alter table public.order_items drop column product`;

    const restore = await api.api.history.batches({ batchId: save.data!.batchId }).restore.post();
    expect(restore.error?.status).toBe(409);
    expect((restore.error as unknown as { value: { error: string } }).value.error).toContain("product");
  });
});
