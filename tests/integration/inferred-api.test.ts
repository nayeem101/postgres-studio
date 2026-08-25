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

const inferredFor = async (schema: string, table: string) => {
  const res = await api.api.schemas({ schema }).tables({ table }).inferred.get();
  if (res.error || !res.data) throw new Error(`inferred failed: ${JSON.stringify(res.error)}`);
  return res.data.inferred;
};

describe("GET .../inferred", () => {
  test("dangling _id column infers its plural parent as strong", async () => {
    const inferred = await inferredFor("public", "orders");
    // delivery_address_id has NO real FK; customer-facing columns are absent
    // and shop_id matches nothing. manager-style real FKs stay excluded.
    expect(inferred).toEqual([
      { column: "delivery_address_id", parentSchema: "public", parentTable: "addresses", confidence: "strong" },
    ]);
  });

  test("columns covered by real FK constraints are never re-inferred", async () => {
    expect(await inferredFor("public", "employees")).toEqual([]);
  });

  test("tables without _id columns yield an empty list", async () => {
    expect(await inferredFor("app", "projects")).toEqual([]);
  });
});
