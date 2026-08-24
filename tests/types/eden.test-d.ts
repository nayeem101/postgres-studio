import { describe, expectTypeOf, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import type { App } from "@pg-studio/api";

/**
 * Compile-time assertions for the typed client (verified by tsc --noEmit,
 * not by bun test). Mirrors the Phase 1 acceptance: web drives off
 * `typeof app`, never hand-written API types.
 */
describe("treaty types", () => {
  const api = treaty<App>("http://localhost");

  test("tables list carries literal kinds", async () => {
    const { data } = await api.api.tables.get();
    expectTypeOf(data?.tables.at(0)?.kind).toEqualTypeOf<"table" | "view" | undefined>();
    expectTypeOf(data?.tables.at(0)?.schema).toEqualTypeOf<string | undefined>();
  });

  test("table detail path params are mandatory", () => {
    void api.api.schemas({ schema: "public" }).tables({ table: "orders" }).get();
    // @ts-expect-error schema param cannot be omitted
    void api.api.schemas().tables;
  });

  test("detail payload exposes primary key columns", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).get();
    expectTypeOf(res.data?.primaryKey).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(res.error?.status).toEqualTypeOf<404 | 422 | undefined>();
  });

  test("fk direction payloads are typed", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).get();
    expectTypeOf(res.data?.fks.incoming.at(0)?.onDelete).toEqualTypeOf<
      "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT" | undefined
    >();
  });
});
