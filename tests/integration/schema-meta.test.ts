import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  listEnums,
  listIndexes,
  listPrimaryKeys,
  listUniqueConstraints,
} from "../../packages/db/src/schema-meta";
import { createSeededTestDb } from "./helpers";

let db: SQL;

beforeAll(async () => {
  db = await createSeededTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("listPrimaryKeys", () => {
  test("composite PK keeps column order", async () => {
    const pks = await listPrimaryKeys(db);
    const orders = pks.find(pk => pk.schema === "public" && pk.table === "orders");
    expect(orders?.columns).toEqual(["shop_id", "order_no"]);
  });

  test("single-column PKs are listed for every table", async () => {
    const pks = await listPrimaryKeys(db);
    expect(pks.find(pk => pk.table === "employees")?.columns).toEqual(["id"]);
    expect(pks.find(pk => pk.table === "links")?.columns).toEqual(["id"]);
    expect(pks.find(pk => pk.schema === "app" && pk.table === "tasks")?.columns).toEqual(["id"]);
    // views have no PK
    expect(pks.some(pk => pk.table === "project_stats")).toBe(false);
  });
});

describe("listUniqueConstraints", () => {
  test("finds single-column unique constraints in both schemas", async () => {
    const uniques = await listUniqueConstraints(db);
    expect(uniques.find(u => u.table === "customers")).toMatchObject({
      schema: "public",
      columns: ["email"],
    });
    expect(uniques.find(u => u.schema === "app" && u.table === "projects")).toMatchObject({
      columns: ["code"],
      name: "projects_code_key",
    });
  });
});

describe("listIndexes", () => {
  test("secondary index is listed as non-unique", async () => {
    const indexes = await listIndexes(db);
    const secondary = indexes.find(i => i.name === "tasks_project_idx");
    expect(secondary).toMatchObject({
      schema: "app",
      table: "tasks",
      columns: ["project_id"],
      isUnique: false,
      isPartial: false,
    });
  });

  test("partial index flag is detected", async () => {
    const indexes = await listIndexes(db);
    const partial = indexes.find(i => i.name === "tasks_open_idx");
    expect(partial).toBeDefined();
    expect(partial?.isPartial).toBe(true);
    expect(partial?.isUnique).toBe(false);
  });

  test("unique and PK backing indexes carry isUnique", async () => {
    const indexes = await listIndexes(db);
    expect(indexes.find(i => i.name === "orders_pkey")).toMatchObject({ isUnique: true });
    expect(indexes.find(i => i.name === "customers_email_key")).toMatchObject({ isUnique: true });
  });
});

describe("listEnums", () => {
  test("enum values keep declaration order", async () => {
    const enums = await listEnums(db);
    expect(enums).toHaveLength(1);
    expect(enums[0]).toEqual({
      schema: "app",
      name: "task_status",
      values: ["todo", "doing", "done"],
    });
  });

  test("status column reports enum udt name", async () => {
    const { listColumns } = await import("../../packages/db/src/catalog");
    const cols = await listColumns(db, "app", "tasks");
    const status = cols.find(c => c.name === "status");
    expect(status).toMatchObject({ dataType: "USER-DEFINED", udtName: "task_status" });
  });
});
