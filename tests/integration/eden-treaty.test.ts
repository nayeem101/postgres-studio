import { describe, expect, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { spikeApp } from "../../apps/server/src/spike-app";

/** In-memory treaty client: no port, full type inference. */
const api = treaty(spikeApp);

describe("treaty round-trip", () => {
  test("GET with path param returns typed data", async () => {
    const { data, error } = await api.spike.hello({ name: "ada" }).get();
    expect(error).toBeNull();
    expect(data?.message).toBe("hello, ada");
  });

  test("POST with typed body echoes values", async () => {
    const { data, error } = await api.spike.echo.post({ name: "orders", limit: 25 });
    expect(error).toBeNull();
    expect(data).toEqual({ name: "orders", limit: 25 });
  });

  test("optional field defaults to null in response", async () => {
    const { data, error } = await api.spike.echo.post({ name: "orders" });
    expect(error).toBeNull();
    expect(data?.limit).toBeNull();
  });

  test("validation failures surface as error with status", async () => {
    const { data, error } = await api.spike.echo.post({ name: "" });
    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });
});
