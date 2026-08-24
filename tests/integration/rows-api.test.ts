import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { createSeededTestDb } from "./helpers";
import { createServerApp } from "../../apps/server/src/server-app";

let db: Awaited<ReturnType<typeof createSeededTestDb>>;
let app: ReturnType<typeof createServerApp>;
let api: ReturnType<typeof treaty<ReturnType<typeof createServerApp>>>;

beforeAll(async () => {
  db = await createSeededTestDb();
  app = createServerApp({ databaseUrl: process.env.TEST_DATABASE_URL! });
  api = treaty(app);
});

afterAll(async () => {
  // never-listened instances have no server handle; onStop won't fire
  if ((app as unknown as { server?: unknown }).server) app.stop(true);
  await db.close();
});

describe("GET /api/schemas/:schema/tables/:table/rows", () => {
  test("first page defaults to PK ascending with nextCursor", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { limit: "2" },
    });
    expect(res.error).toBeNull();
    expect(res.data!.rows.map(r => [r.shop_id, r.order_no])).toEqual([
      [1, 100],
      [1, 101],
    ]);
    expect(res.data!.nextCursor).toBeTruthy();
    // numeric columns arrive as strings (driver behavior), totals included
    expect(res.data!.rows[0]).toMatchObject({ total: "150.00" });
  });

  test("following the cursor yields the remaining page and then exhaustion", async () => {
    const first = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { limit: "2" },
    });
    const second = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { limit: "2", cursor: first.data!.nextCursor! },
    });
    expect(second.error).toBeNull();
    expect(second.data!.rows.map(r => [r.shop_id, r.order_no])).toEqual([[2, 100]]);
    expect(second.data!.nextCursor).toBeNull();
  });

  test("no overlap between consecutive pages (keyset, not offset)", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).rows.get({
        query: { limit: "2", ...(cursor ? { cursor } : {}) },
      });
      expect(res.error).toBeNull();
      for (const row of res.data!.rows) seen.add(String(row.id));
      if (!res.data!.nextCursor) break;
      cursor = res.data!.nextCursor;
    }
    // 4 employees across pages of 2 — every row exactly once
    expect(seen.size).toBe(4);
  });

  test("descending direction starts from the end of the key order", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { dir: "desc", limit: "1" },
    });
    expect(res.error).toBeNull();
    expect(res.data!.rows[0]).toMatchObject({ shop_id: 2, order_no: 100 });
  });

  test("enum column serializes its label", async () => {
    const res = await api.api.schemas({ schema: "app" }).tables({ table: "tasks" }).rows.get({
      query: { sort: "id", limit: "50" },
    });
    const statuses = res.data!.rows.map(r => r.status).sort();
    expect(statuses).toEqual(["doing", "done", "todo"]);
  });

  test("unknown sort column is a 400", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { sort: "not_a_column" },
    });
    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(400);
  });

  test("tampered cursor token is a 400", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).rows.get({
      query: { cursor: "!!!garbage!!!" },
    });
    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(400);
  });
});
