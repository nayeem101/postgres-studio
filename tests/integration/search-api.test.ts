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

const search = async (q: string, extra: { offset?: number; limit?: number } = {}) => {
  const res = await api.api.search.get({ query: { q, ...extra } });
  if (res.error || !res.data) throw new Error(`search failed: ${JSON.stringify(res.error)}`);
  return res.data;
};

describe("GET /api/search", () => {
  test("finds matches across tables with pk tuples for navigation", async () => {
    const page = await search("Ada");
    expect(page.total).toBeGreaterThanOrEqual(1);
    const hit = page.results.find(r => r.table === "employees")!;
    expect(hit).toBeDefined();
    expect(hit.pkColumns).toEqual(["id"]);
    expect(hit.pkValues).toEqual([1]);
    expect(hit.matchedColumn).toBe("name");
    expect(hit.snippet).toContain("Ada");
  });

  test("matches text columns in any schema (multi-schema fixture)", async () => {
    const page = await search("Analytical");
    expect(page.total).toBe(1);
    expect(page.results[0]).toMatchObject({ schema: "public", table: "addresses" });
  });

  test("LIKE wildcards in the query are escaped", async () => {
    // "%%" would match everything unescaped; escaped it matches nothing.
    const page = await search("%%");
    expect(page.total).toBe(0);
    expect(await search("%")).toEqual({ results: [], total: 0, nextOffset: null });
  });

  test("paginates exactly across table boundaries", async () => {
    const all = await search("a", { limit: 100 }); // 'a' appears nearly everywhere
    expect(all.total).toBeGreaterThan(2);

    const first = await search("a", { limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.nextOffset).toBe(2);

    const second = await search("a", { limit: 2, offset: 2 });
    expect(second.results).toHaveLength(2);
    const firstKeys = first.results.map(r => `${r.schema}.${r.table}:${r.pkValues.join(",")}`);
    const secondKeys = second.results.map(r => `${r.schema}.${r.table}:${r.pkValues.join(",")}`);
    expect(firstKeys.some(key => secondKeys.includes(key))).toBe(false);
  });

  test("views are not searched", async () => {
    const page = await search("planning"); // app.project_stats view content
    expect(page.results.find(r => r.table === "project_stats")).toBeUndefined();
  });

  test("empty query is a 400", async () => {
    const res = await api.api.search.get({ query: { q: " " } });
    expect(res.error?.status).toBe(400);
  });
});
