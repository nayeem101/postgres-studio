import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BackupStore, BackupStoreError, type SnapshotInput } from "../../apps/server/src/backup";

let database: Database;
let store: BackupStore;

const updateSnapshot = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  schema: "public",
  table: "orders",
  pkValues: [1, 100],
  operation: "update",
  beforeImage: { shop_id: 1, order_no: 100, total: "150.00" },
  ...overrides,
});

beforeEach(() => {
  database = new Database(":memory:");
  store = new BackupStore(database);
  store.init();
});

afterEach(() => {
  store.close(true);
});

describe("batch lifecycle", () => {
  test("pending -> confirmed makes the batch the only restorable kind", () => {
    const id = store.beginBatch("conn-1", "edit orders");
    expect(store.getBatch(id)?.status).toBe("pending");

    store.addSnapshots(id, [updateSnapshot()]);
    store.confirmBatch(id);

    expect(store.getBatch(id)?.status).toBe("confirmed");
    expect(store.listRestorableBatches().map(b => b.id)).toContain(id);
  });

  test("failed batches never appear restorable", () => {
    const id = store.beginBatch("conn-1");
    store.addSnapshots(id, [updateSnapshot()]);
    store.failBatch(id);

    expect(store.getBatch(id)?.status).toBe("failed");
    expect(store.listRestorableBatches()).toEqual([]);
  });

  test("terminal states reject further transitions", () => {
    const confirmed = store.beginBatch("conn-1");
    store.confirmBatch(confirmed);
    expect(() => store.failBatch(confirmed)).toThrow(BackupStoreError);
    expect(() => store.confirmBatch(confirmed)).toThrow(BackupStoreError);

    const failed = store.beginBatch("conn-1");
    store.failBatch(failed);
    expect(() => store.confirmBatch(failed)).toThrow(BackupStoreError);
  });

  test("transitions on unknown batches are rejected", () => {
    expect(() => store.confirmBatch("no-such-batch")).toThrow(/not found/);
  });

  test("restorable list filters by connection and sorts newest first", async () => {
    const a = store.beginBatch("conn-1", "first");
    await new Promise(resolve => setTimeout(resolve, 5));
    const b = store.beginBatch("conn-2", "second");
    store.confirmBatch(a);
    store.confirmBatch(b);

    const all = store.listRestorableBatches();
    expect(all.map(x => x.id)).toEqual([b, a]);
    expect(store.listRestorableBatches("conn-2").map(x => x.id)).toEqual([b]);
  });
});

describe("snapshot capture rules", () => {
  test("update/delete require before images; insert forbids pk and image", () => {
    const id = store.beginBatch("conn-1");
    expect(() => store.addSnapshots(id, [updateSnapshot({ beforeImage: null })])).toThrow(
      /require a before image/,
    );
    expect(() =>
      store.addSnapshots(id, [
        { schema: "public", table: "orders", pkValues: [1], operation: "insert", beforeImage: null },
      ]),
    ).toThrow(/must not carry a pk/);
    expect(() =>
      store.addSnapshots(id, [
        { schema: "public", table: "orders", pkValues: [], operation: "insert", beforeImage: { x: 1 } },
      ]),
    ).toThrow(/must not carry a before image/);
  });

  test("capture is atomic: one bad record rolls back the whole batch payload", () => {
    const id = store.beginBatch("conn-1");
    expect(() =>
      store.addSnapshots(id, [
        updateSnapshot({ pkValues: [1] }),
        updateSnapshot({ pkValues: [] }), // invalid
      ]),
    ).toThrow(BackupStoreError);
    expect(store.getSnapshots(id)).toHaveLength(0);
  });

  test("cannot attach snapshots to a settled batch", () => {
    const id = store.beginBatch("conn-1");
    store.confirmBatch(id);
    expect(() => store.addSnapshots(id, [updateSnapshot()])).toThrow(/confirmed batch/);
  });

  test("snapshots round-trip composite PKs and JSON images intact", () => {
    const id = store.beginBatch("conn-1");
    store.addSnapshots(id, [
      updateSnapshot(),
      {
        schema: "public",
        table: "employees",
        pkValues: ["7"],
        operation: "delete",
        beforeImage: { id: 7, name: "Ada", manager_id: null },
      },
      { schema: "app", table: "tasks", pkValues: [], operation: "insert", beforeImage: null },
    ]);

    const snapshots = store.getSnapshots(id);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.pkValues).toEqual([1, 100]);
    expect(snapshots[0]?.beforeImage).toEqual({ shop_id: 1, order_no: 100, total: "150.00" });
    expect(snapshots[1]?.beforeImage).toMatchObject({ name: "Ada", manager_id: null });
    expect(snapshots[2]?.operation).toBe("insert");
  });
});
