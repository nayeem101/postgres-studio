import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { listIncomingFks, listOutgoingFks, listTableFks } from "../../packages/db/src/fks";
import { createSeededTestDb } from "./helpers";

let db: SQL;

beforeAll(async () => {
  db = await createSeededTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("outgoing FKs", () => {
  test("employees exposes its self-FK with SET NULL delete", async () => {
    const fks = await listOutgoingFks(db, "public", "employees");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      childSchema: "public",
      childTable: "employees",
      childColumns: ["manager_id"],
      parentSchema: "public",
      parentTable: "employees",
      parentColumns: ["id"],
      onDelete: "SET NULL",
    });
  });

  test("order_items exposes the composite FK in column order", async () => {
    const fks = await listOutgoingFks(db, "public", "order_items");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      childColumns: ["shop_id", "order_no"],
      parentColumns: ["shop_id", "order_no"],
      parentTable: "orders",
      onDelete: "CASCADE",
    });
  });

  test("tables without outgoing FKs return empty", async () => {
    expect(await listOutgoingFks(db, "public", "customers")).toEqual([]);
    expect(await listOutgoingFks(db, "public", "orders")).toEqual([]);
  });
});

describe("incoming FKs", () => {
  test("orders is referenced by order_items only", async () => {
    const fks = await listIncomingFks(db, "public", "orders");
    expect(fks.map(f => `${f.childSchema}.${f.childTable}`)).toEqual(["public.order_items"]);
  });

  test("employees is referenced by itself (self-FK shows incoming)", async () => {
    const fks = await listIncomingFks(db, "public", "employees");
    expect(fks.map(f => f.childTable)).toEqual(["employees"]);
  });

  test("leaf tables have no incoming FKs", async () => {
    expect(await listIncomingFks(db, "public", "addresses")).toEqual([]);
    expect(await listIncomingFks(db, "public", "order_items")).toEqual([]);
  });
});

describe("both directions", () => {
  test("customers sees addresses downstream and nothing upstream", async () => {
    const { outgoing, incoming } = await listTableFks(db, "public", "customers");
    expect(outgoing).toEqual([]);
    expect(incoming.map(f => `${f.childTable}.${f.childColumns.join("+")}`)).toEqual([
      "addresses.customer_id",
    ]);
  });
});
