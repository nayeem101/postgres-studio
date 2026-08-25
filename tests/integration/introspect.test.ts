import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { listColumns, listTables } from "../../packages/db/src/catalog";
import { createSeededTestDb } from "./helpers";

let db: SQL;

beforeAll(async () => {
  db = await createSeededTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("listTables", () => {
  test("returns seeded relations across schemas", async () => {
    const tables = await listTables(db);
    const keys = tables.map(t => `${t.schema}.${t.name}`);
    expect(new Set(keys)).toEqual(
      new Set([
        "app.project_stats",
        "app.projects",
        "app.tasks",
        "public.addresses",
        "public.customers",
        "public.employees",
        "public.links",
        "public.order_items",
        "public.orders",
      ]),
    );
  });

  test("views are distinguished from base tables", async () => {
    const tables = await listTables(db);
    const stats = tables.find(t => t.name === "project_stats");
    expect(stats).toMatchObject({ schema: "app", kind: "view" });
    expect(tables.find(t => t.name === "orders")).toMatchObject({ schema: "public", kind: "table" });
  });

  test("excludes system schemas", async () => {
    const tables = await listTables(db);
    expect(tables.some(t => t.schema === "pg_catalog" || t.schema === "information_schema")).toBe(false);
  });
});

describe("listColumns", () => {
  test("employees columns include nullable self-FK with position order", async () => {
    const columns = await listColumns(db, "public", "employees");
    expect(columns.map(c => c.name)).toEqual(["id", "name", "manager_id"]);

    const [id, name, managerId] = columns;
    expect(id).toMatchObject({ dataType: "integer", udtName: "int4", nullable: false });
    expect(id?.hasDefault).toBe(true);
    expect(name).toMatchObject({ dataType: "text", nullable: false });
    expect(managerId).toMatchObject({ dataType: "integer", nullable: true, hasDefault: false });
  });

  test("composite PK columns carry correct nullability", async () => {
    const columns = await listColumns(db, "public", "orders");
    expect(Object.fromEntries(columns.map(c => [c.name, c.nullable]))).toEqual({
      shop_id: false,
      order_no: false,
      total: false,
      delivery_address_id: true,
    });
  });

  test("numeric default normalizes with hasDefault", async () => {
    const [total] = await listColumns(db, "public", "orders").then(cols =>
      cols.filter(c => c.name === "total"),
    );
    expect(total?.hasDefault).toBe(true);
    expect(total?.default).toBe("0");
  });

  test("empty result for unknown table (no throw)", async () => {
    const columns = await listColumns(db, "public", "does_not_exist");
    expect(columns).toEqual([]);
  });
});
