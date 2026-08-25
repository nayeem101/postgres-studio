import { describe, expect, test } from "bun:test";
import { inferRelations } from "../../packages/db/src/inferred";

const tables = [
  { schema: "public", name: "customers" },
  { schema: "public", name: "companies" },
  { schema: "public", name: "order_items" },
  { schema: "app", name: "projects" },
];

const run = (
  columns: string[],
  realFks: string[][] = [],
) =>
  inferRelations({
    schema: "public",
    table: "orders",
    columns: columns.map(name => ({ name })),
    tables,
    realFkChildColumns: realFks,
  });

describe("inferRelations", () => {
  test("exact singular/plural matches are strong", () => {
    expect(run(["customer_id"])).toEqual([
      { column: "customer_id", parentSchema: "public", parentTable: "customers", confidence: "strong" },
    ]);
    expect(run(["company_id"])).toEqual([
      { column: "company_id", parentSchema: "public", parentTable: "companies", confidence: "strong" },
    ]);
  });

  test("substring fallback is weak", () => {
    expect(run(["item_id"])).toEqual([
      { column: "item_id", parentSchema: "public", parentTable: "order_items", confidence: "weak" },
    ]);
  });

  test("columns with no plausible parent produce nothing", () => {
    expect(run(["note_id", "id", "total"])).toEqual([]);
  });

  test("real-FK-covered columns are excluded", () => {
    expect(run(["customer_id"], [["customer_id"]])).toEqual([]);
  });

  test("a table does not infer a self-edge from its own name", () => {
    const result = inferRelations({
      schema: "public",
      table: "customers",
      columns: [{ name: "customer_id" }],
      tables,
      realFkChildColumns: [],
    });
    expect(result).toEqual([]);
  });
});
