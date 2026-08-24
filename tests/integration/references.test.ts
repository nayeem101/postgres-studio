import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { treaty } from "@elysiajs/eden";
import { createSeededTestDb } from "./helpers";
import { createServerApp } from "../../apps/server/src/server-app";

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

import { BackupStore } from "../../apps/server/src/backup";

const outgoingFor = (schema: string, table: string) =>
  api.api.schemas({ schema }).tables({ table }).references.outgoing;
const incomingFor = (schema: string, table: string) =>
  api.api.schemas({ schema }).tables({ table }).references.incoming;

type RefClient = ReturnType<typeof outgoingFor>;

describe("outgoing references", () => {
  test("self-FK resolves to manager preview with display column", async () => {
    // Grace (id=2) reports to Ada (id=1)
    const res = await outgoingFor("public", "employees").post({
      pkValues: [2],
    });
    expect(res.error).toBeNull();
    expect(res.data!.outgoing).toHaveLength(1);
    const ref = res.data!.outgoing[0]!;
    expect(ref.parentTable).toBe("employees");
    expect(ref.preview).not.toBeNull();
    expect(ref.preview!.displayColumn).toBe("name");
    expect(ref.preview!.row).toMatchObject({ id: 1, name: "Ada Lovelace" });
  });

  test("NULL FK column yields unresolved preview", async () => {
    // Ada has no manager
    const res = await outgoingFor("public", "employees").post({
      pkValues: [1],
    });
    expect(res.data!.outgoing[0]!.preview).toBeNull();
  });

  test("composite-FK table without outgoing refs returns empty", async () => {
    const res = await outgoingFor("public", "orders").post({
      pkValues: [1, 100],
    });
    expect(res.error).toBeNull();
    expect(res.data!.outgoing).toEqual([]);
  });

  test("unknown row returns 404", async () => {
    const res = await outgoingFor("public", "employees").post({
      pkValues: [999],
    });
    expect(res.error?.status).toBe(404);
  });
});

describe("incoming references", () => {
  test("badge count equals COUNT(*) for that FK", async () => {
    const res = await incomingFor("public", "orders").post({
      pkValues: [1, 100],
    });
    expect(res.error).toBeNull();
    expect(res.data!.groups).toHaveLength(1);
    const group = res.data!.groups[0]!;
    expect(group.childTable).toBe("order_items");
    expect(group.totalCount).toBe(3);

    const [{ n }] = await db`
      select count(*)::int as n from public.order_items
      where shop_id = 1 and order_no = 100
    `;
    expect(group.totalCount).toBe(n);
  });

  test("rows paginate within a group via nextOffset", async () => {
    const first = await incomingFor("public", "customers").post({
      pkValues: [1],
      limit: 2,
    });
    const group = first.data!.groups.find(g => g.childTable === "addresses")!;
    expect(group.totalCount).toBe(3);
    expect(group.rows).toHaveLength(2);
    expect(group.nextOffset).toBe(2);

    const second = await incomingFor("public", "customers").post({
      pkValues: [1],
      limit: 2,
      offset: 2,
    });
    const secondGroup = second.data!.groups.find(g => g.childTable === "addresses")!;
    expect(secondGroup.rows).toHaveLength(1);
    expect(secondGroup.nextOffset).toBeNull();
  });

  test("self-referencing table lists its own reports", async () => {
    const res = await incomingFor("public", "employees").post({
      pkValues: [1], // Ada manages Grace + Alan
    });
    const selfGroup = res.data!.groups.find(g => g.constraintName.includes("manager"))!;
    expect(selfGroup.totalCount).toBe(2);
    expect(selfGroup.rows.map(r => r.name).sort()).toEqual(["Alan Turing", "Grace Hopper"]);
  });

  test("leaf rows report zero-count groups", async () => {
    const res = await incomingFor("app", "tasks").post({
      pkValues: [1],
    });
    expect(res.error).toBeNull();
    expect(res.data!.groups).toEqual([]);
  });

  test("pk arity mismatch is a 400", async () => {
    const res = await incomingFor("public", "orders").post({
      pkValues: [1],
    });
    expect(res.error?.status).toBe(400);
  });
});
