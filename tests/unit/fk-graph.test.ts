import { describe, expect, test } from "bun:test";
import {
  tableKey,
  topoRestoreOrder,
  walkReferences,
  type FkEdge,
  type TableRef,
} from "../../packages/db/src/fk-graph";

const T = (schema: string, name: string): TableRef => ({ schema, name });

/** Mirrors the seeded fixture graph. */
const fixtureEdges: FkEdge[] = [
  { from: T("public", "employees"), to: T("public", "employees") },
  { from: T("public", "order_items"), to: T("public", "orders") },
  { from: T("public", "addresses"), to: T("public", "customers") },
];

describe("walkReferences", () => {
  test("follows both directions one level", () => {
    const steps = walkReferences(fixtureEdges, T("public", "orders"));
    const dirs = steps.map(s => `${s.direction}:${tableKey(s.table)}`);
    expect(dirs).toContain("incoming:public.order_items");
  });

  test("self-FK does not recurse unbounded", () => {
    const steps = walkReferences([{ from: T("public", "employees"), to: T("public", "employees") }], T("public", "employees"), {
      maxDepth: 50,
    });
    expect(steps).toHaveLength(0);
  });

  test("mutual cycle between two tables terminates and dedupes", () => {
    const edges: FkEdge[] = [
      { from: T("public", "a"), to: T("public", "b") },
      { from: T("public", "b"), to: T("public", "a") },
    ];
    const steps = walkReferences(edges, T("public", "a"), { maxDepth: 10 });
    // a expands once: b(in) + b(out); each b direction expands at most once
    const expanded = new Set(steps.map(s => `${s.direction}|${tableKey(s.table)}`));
    expect(expanded.size).toBeLessThanOrEqual(4);
    expect(steps.every(s => s.depth <= 10)).toBe(true);
  });

  test("respects maxDepth cap", () => {
    const chain: FkEdge[] = [
      { from: T("public", "c1"), to: T("public", "c2") },
      { from: T("public", "c2"), to: T("public", "c3") },
      { from: T("public", "c3"), to: T("public", "c4") },
      { from: T("public", "c4"), to: T("public", "c5") },
    ];
    const steps = walkReferences(chain, T("public", "c1"), { maxDepth: 2 });
    expect(Math.max(...steps.map(s => s.depth), 0)).toBe(2);
    const tables = new Set(steps.map(s => tableKey(s.table)));
    expect(tables.has("public.c3")).toBe(true);
    expect(tables.has("public.c5")).toBe(false);
  });
});

describe("topoRestoreOrder", () => {
  test("parents restore before children", () => {
    const tables = [T("public", "order_items"), T("public", "orders"), T("public", "addresses"), T("public", "customers")];
    const order = topoRestoreOrder(tables, fixtureEdges).map(tableKey);
    expect(order.indexOf("public.orders")).toBeLessThan(order.indexOf("public.order_items"));
    expect(order.indexOf("public.customers")).toBeLessThan(order.indexOf("public.addresses"));
  });

  test("ignores self-FK edges when ordering", () => {
    const order = topoRestoreOrder([T("public", "employees")], fixtureEdges);
    expect(order.map(tableKey)).toEqual(["public.employees"]);
  });

  test("chains order transitively (grandparent → parent → child)", () => {
    const edges: FkEdge[] = [{ from: T("public", "b"), to: T("public", "a") }, { from: T("public", "c"), to: T("public", "b") }];
    const order = topoRestoreOrder([T("public", "c"), T("public", "b"), T("public", "a")], edges).map(tableKey);
    expect(order).toEqual(["public.a", "public.b", "public.c"]);
  });

  test("cycles fall back to deterministic append instead of hanging", () => {
    const edges: FkEdge[] = [
      { from: T("public", "x"), to: T("public", "y") },
      { from: T("public", "y"), to: T("public", "x") },
      { from: T("public", "z"), to: T("public", "y") },
    ];
    const order = topoRestoreOrder([T("public", "y"), T("public", "x"), T("public", "z")], edges).map(tableKey);
    expect(order).toHaveLength(3);
    expect(new Set(order).size).toBe(3);
  });

  test("rejects duplicate inputs", () => {
    expect(() => topoRestoreOrder([T("public", "a"), T("public", "a")], [])).toThrow(/duplicate/);
  });
});
