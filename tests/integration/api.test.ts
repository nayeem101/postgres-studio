import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { createSeededTestDb } from "./helpers";
import { createServerApp } from "../../apps/server/src/server-app";

let db: Awaited<ReturnType<typeof createSeededTestDb>>;
let app: ReturnType<typeof createServerApp>;
let api: ReturnType<typeof treaty<ReturnType<typeof createServerApp>>>;

beforeAll(async () => {
  db = await createSeededTestDb();
  app = createServerApp({ databaseUrl: process.env.TEST_DATABASE_URL! });
  api = treaty(app);
});

afterAll(async () => {
  // never-listened instances have no server handle; onStop won't fire
  if ((app as unknown as { server?: unknown }).server) app.stop(true);
  await db.close();
});

describe("GET /api/tables", () => {
  test("lists relations across schemas with kinds", async () => {
    const { data, error } = await api.api.tables.get();
    expect(error).toBeNull();
    const keys = data!.tables.map(t => `${t.schema}.${t.name}`);
    expect(keys).toContain("app.tasks");
    expect(keys).toContain("public.orders");
    expect(data!.tables.find(t => t.name === "project_stats")?.kind).toBe("view");
  });
});

describe("GET /api/enums", () => {
  test("returns enum metadata", async () => {
    const { data, error } = await api.api.enums.get();
    expect(error).toBeNull();
    expect(data!.enums).toEqual([
      { schema: "app", name: "task_status", values: ["todo", "doing", "done"] },
    ]);
  });
});

describe("GET /api/schemas/:schema/tables/:table", () => {
  test("composite PK table detail carries columns, pk and incoming fks", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "orders" }).get();
    expect(res.error).toBeNull();
    const detail = res.data!;

    expect(detail.table).toEqual({ schema: "public", name: "orders", kind: "table" });
    expect(detail.primaryKey).toEqual(["shop_id", "order_no"]);
    expect(detail.columns.map(c => c.name)).toEqual(["shop_id", "order_no", "total"]);
    expect(detail.fks.incoming.map(f => `${f.childSchema}.${f.childTable}`)).toEqual([
      "public.order_items",
    ]);
    expect(detail.fks.outgoing).toEqual([]);
  });

  test("enum column surfaces udt name for the add-row form", async () => {
    const res = await api.api.schemas({ schema: "app" }).tables({ table: "tasks" }).get();
    const status = res.data!.columns.find(c => c.name === "status");
    expect(status).toMatchObject({ dataType: "USER-DEFINED", udtName: "task_status", hasDefault: true });
  });

  test("unknown relation returns 404 error payload", async () => {
    const res = await api.api.schemas({ schema: "public" }).tables({ table: "nope" }).get();
    expect(res.data).toBeNull();
    expect(res.error?.status).toBe(404);
    expect(JSON.stringify(res.error?.value)).toContain("not found");
  });

  test("unsafe identifiers are rejected by param validation (422)", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/schemas/public%3Bdrop/tables/orders"),
    );
    expect(response.status).toBe(422);
  });
});
