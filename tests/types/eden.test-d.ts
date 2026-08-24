import { describe, expectTypeOf, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import type { App } from "@pg-studio/api";

/**
 * Compile-time assertions for the typed client (verified by tsc --noEmit,
 * not by bun test). Mirrors the Phase 0 acceptance: "typed client compiles".
 */
describe("treaty types", () => {
  const api = treaty<App>("http://localhost");

  test("hello path param is required and typed", () => {
    // @ts-expect-error path params are mandatory
    void api.spike.hello().get;
    void api.spike.hello({ name: "x" }).get();
  });

  test("hello data carries the response schema", async () => {
    const { data } = await api.spike.hello({ name: "x" }).get();
    expectTypeOf(data?.message).toEqualTypeOf<string | undefined>();
  });

  test("echo body requires name and accepts optional limit", () => {
    void api.spike.echo.post({ name: "a" });
    void api.spike.echo.post({ name: "a", limit: 5 });
    // @ts-expect-error limit must be a number
    void api.spike.echo.post({ name: "a", limit: "many" });
  });

  test("echo data mirrors the response schema", async () => {
    const { data } = await api.spike.echo.post({ name: "a", limit: 5 });
    expectTypeOf(data?.name).toEqualTypeOf<string | undefined>();
    expectTypeOf(data?.limit).toEqualTypeOf<number | null | undefined>();
  });
});
