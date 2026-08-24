import { describe, expect, test } from "bun:test";
import { spikeApp } from "../../apps/server/src/spike-app";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /spike/hello/:name", () => {
  test("valid path param returns 200 with message", async () => {
    const res = await spikeApp.handle(new Request("http://localhost/spike/hello/ada"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "hello, ada" });
  });
});

describe("POST /spike/echo", () => {
  test("valid body returns 200 with echoed values and default limit null", async () => {
    const res = await spikeApp.handle(new Request("http://localhost/spike/echo", json({ name: "orders" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "orders", limit: null });
  });

  test("limit passes through when provided", async () => {
    const res = await spikeApp.handle(
      new Request("http://localhost/spike/echo", json({ name: "orders", limit: 25 })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "orders", limit: 25 });
  });

  test("missing name is a validation error (422)", async () => {
    const res = await spikeApp.handle(new Request("http://localhost/spike/echo", json({ limit: 5 })));
    expect(res.status).toBe(422);
    const payload = await res.json();
    expect(JSON.stringify(payload)).toContain("validation");
  });

  test("wrong type for name is a validation error (422)", async () => {
    const res = await spikeApp.handle(new Request("http://localhost/spike/echo", json({ name: 42 })));
    expect(res.status).toBe(422);
  });

  test("limit out of range is a validation error (422)", async () => {
    const res = await spikeApp.handle(
      new Request("http://localhost/spike/echo", json({ name: "x", limit: 1000 })),
    );
    expect(res.status).toBe(422);
  });

  test("malformed JSON body is rejected", async () => {
    const res = await spikeApp.handle(
      new Request("http://localhost/spike/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
