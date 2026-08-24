import { describe, expect, test } from "bun:test";
import { compileRowsQuery } from "../../packages/db/src/rows";

describe("compileRowsQuery", () => {
  test("first page: no where clause, limit+1 fetch", () => {
    const q = compileRowsQuery({
      schema: "public",
      table: "employees",
      orderBy: ["id"],
      limit: 50,
    });
    expect(q.text).toBe('select * from "public"."employees" order by "id" ASC limit 51');
    expect(q.params).toEqual([]);
    expect(q.limit).toBe(50);
  });

  test("cursor page builds tuple comparison with bound params", () => {
    const q = compileRowsQuery({
      schema: "public",
      table: "orders",
      orderBy: ["shop_id", "order_no"],
      limit: 10,
      cursor: "WyJ1LXNlZCIsNDJd",
    });
    // decoded cursor values become $1..$n in key order
    expect(q.params.length).toBe(2);
    expect(q.text).toContain('where ("shop_id", "order_no") > ($1, $2)');
    expect(q.text).toContain('"shop_id" ASC, "order_no" ASC');
    expect(q.text.endsWith("limit 11")).toBe(true);
  });

  test("descending flips both sort and comparison operator", () => {
    const token = Buffer.from("[7]", "utf8").toString("base64url");
    const q = compileRowsQuery({
      schema: "public",
      table: "employees",
      orderBy: ["id"],
      descending: true,
      cursor: token,
      limit: 5,
    });
    expect(q.text).toContain('"id" DESC');
    expect(q.text).toContain('("id") < ($1)');
  });

  test("limit clamps to [1, 500]", () => {
    const tiny = compileRowsQuery({ schema: "s", table: "t", orderBy: ["c"], limit: 0 });
    expect(tiny.text.endsWith("limit 2")).toBe(true);
    const huge = compileRowsQuery({ schema: "s", table: "t", orderBy: ["c"], limit: 100_000 });
    expect(huge.text.endsWith("limit 501")).toBe(true);
  });

  test("injection attempts are rejected before SQL assembly", () => {
    expect(() =>
      compileRowsQuery({
        schema: "public; drop table x",
        table: "orders",
        orderBy: ["id"],
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      compileRowsQuery({
        schema: "public",
        table: "orders",
        orderBy: ["id) --"],
        limit: 10,
      }),
    ).toThrow();
  });

  test("cursor arity mismatch is rejected", () => {
    const singleKeyToken = Buffer.from("[1]", "utf8").toString("base64url");
    expect(() =>
      compileRowsQuery({
        schema: "public",
        table: "orders",
        orderBy: ["shop_id", "order_no"],
        cursor: singleKeyToken,
        limit: 10,
      }),
    ).toThrow(/does not match the sort key/);
  });

  test("empty or oversized order keys are rejected", () => {
    expect(() => compileRowsQuery({ schema: "s", table: "t", orderBy: [], limit: 5 })).toThrow();
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(c => `col${c}`);
    expect(() => compileRowsQuery({ schema: "s", table: "t", orderBy: nine, limit: 5 })).toThrow();
  });
});
