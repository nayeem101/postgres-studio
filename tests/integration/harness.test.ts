import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createSeededTestDb } from "./helpers";

let db: SQL;

beforeAll(async () => {
  db = await createSeededTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("integration harness", () => {
  test("seed applies cleanly and tables are present", async () => {
    const rows = await db`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    expect(rows.map(r => r.table_name)).toEqual([
      "addresses",
      "customers",
      "employees",
      "order_items",
      "orders",
    ]);
  });

  test("row counts match the fixture", async () => {
    const counts = await db`
      select
        (select count(*)::int from public.employees) as employees,
        (select count(*)::int from public.orders) as orders,
        (select count(*)::int from public.order_items) as order_items,
        (select count(*)::int from public.customers) as customers,
        (select count(*)::int from public.addresses) as addresses
    `;
    expect(counts[0]).toEqual({
      employees: 4,
      orders: 3,
      order_items: 5,
      customers: 2,
      addresses: 3,
    });
  });

  test("self-FK data reads back (Grace reports to Ada)", async () => {
    const [grace] = await db`
      select m.name as manager_name
      from public.employees e
      join public.employees m on m.id = e.manager_id
      where e.name = 'Grace Hopper'
    `;
    expect(grace?.manager_name).toBe("Ada Lovelace");
  });

  test("composite-FK data reads back", async () => {
    const items = await db`
      select oi.product
      from public.order_items oi
      join public.orders o on o.shop_id = oi.shop_id and o.order_no = oi.order_no
      where o.shop_id = 2 and o.order_no = 100
      order by oi.id
    `;
    expect(items.map(i => i.product)).toEqual(["monitor", "cable"]);
  });

  test("composite FK rejects orphan insert", async () => {
    expect(
      db`insert into public.order_items (shop_id, order_no, product) values (9, 9, 'ghost')`.execute(),
    ).rejects.toThrow();
  });

  test("cascade delete removes child rows", async () => {
    await db`delete from public.customers where id = 1`;
    const remaining = await db`select count(*)::int as n from public.addresses`;
    expect(remaining[0].n).toBe(1);
  });
});
