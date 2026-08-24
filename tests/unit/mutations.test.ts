import { describe, expect, test } from "bun:test";
import {
  compileDelete,
  compileInsert,
  compileSelectByPkTuples,
  compileUpdate,
} from "../../packages/db/src/mutations";

describe("compileUpdate", () => {
  test("single and composite pk predicates with ordered params", () => {
    const single = compileUpdate({
      schema: "public",
      table: "employees",
      set: { name: "Grace H.", manager_id: null },
      pk: { id: 2 },
    });
    expect(single.text).toBe(
      'update "public"."employees" set "name" = $1, "manager_id" = $2 where "id" = $3',
    );
    expect(single.params).toEqual(["Grace H.", null, 2]);

    const composite = compileUpdate({
      schema: "public",
      table: "orders",
      set: { total: "123.45" },
      pk: { shop_id: 1, order_no: 100 },
    });
    expect(composite.text).toBe(
      'update "public"."orders" set "total" = $1 where "shop_id" = $2 and "order_no" = $3',
    );
    expect(composite.params).toEqual(["123.45", 1, 100]);
  });

  test.each([[{ schema: "s;drop", table: "t", set: { a: 1 }, pk: { id: 1 } }], [
    { schema: "s", table: "t", set: { "a) --": 1 }, pk: { id: 1 } },
  ]])("rejects unsafe identifiers %p", input => {
    expect(() => compileUpdate(input as Parameters<typeof compileUpdate>[0])).toThrow();
  });

  test("rejects empty SET or missing pk", () => {
    expect(() =>
      compileUpdate({ schema: "s", table: "t", set: {}, pk: { id: 1 } }),
    ).toThrow(/SET column/);
    expect(() =>
      compileUpdate({ schema: "s", table: "t", set: { a: 1 }, pk: {} }),
    ).toThrow(/primary key/);
  });
});

describe("compileDelete", () => {
  test("builds parameterized predicate", () => {
    const q = compileDelete({ schema: "app", table: "tasks", pk: { id: 7 } });
    expect(q.text).toBe('delete from "app"."tasks" where "id" = $1');
    expect(q.params).toEqual([7]);
  });
});

describe("compileInsert", () => {
  test("column list matches value placeholders", () => {
    const q = compileInsert({
      schema: "public",
      table: "links",
      values: { project_id: 1, url: "https://example.com" },
    });
    expect(q.text).toBe(
      'insert into "public"."links" ("project_id", "url") values ($1, $2)',
    );
    expect(q.params).toEqual([1, "https://example.com"]);
  });

  test("rejects empty values", () => {
    expect(() => compileInsert({ schema: "s", table: "t", values: {} })).toThrow();
  });
});

describe("compileSelectByPkTuples", () => {
  test("row-value IN over composite tuples", () => {
    const q = compileSelectByPkTuples({
      schema: "public",
      table: "orders",
      pkColumns: ["shop_id", "order_no"],
      tuples: [
        [1, 100],
        [2, 100],
      ],
    });
    expect(q.text).toBe(
      'select * from "public"."orders" where ("shop_id", "order_no") in (($1, $2), ($3, $4))',
    );
    expect(q.params).toEqual([1, 100, 2, 100]);
  });

  test("supports column projection and rejects arity mismatch", () => {
    const projected = compileSelectByPkTuples({
      schema: "public",
      table: "employees",
      pkColumns: ["id"],
      tuples: [[5]],
      columns: ["id", "name"],
    });
    expect(projected.text).toContain('select "id", "name" from');
    expect(() =>
      compileSelectByPkTuples({
        schema: "public",
        table: "orders",
        pkColumns: ["shop_id", "order_no"],
        tuples: [[1]],
      }),
    ).toThrow(/arity/);
  });
});
