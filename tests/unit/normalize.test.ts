import { describe, expect, test } from "bun:test";
import { MetadataError, normalizeColumn, normalizeFk, normalizeTable } from "../../packages/db/src/normalize";

const columnRow = {
  schema: "public",
  table: "order_items",
  name: "quantity",
  position: 5,
  dataType: "integer",
  udtName: "int4",
  nullable: false,
  default: null,
};

describe("normalizeTable", () => {
  test("maps information_schema-style rows", () => {
    expect(normalizeTable({ schema: "public", name: "orders", kind: "table" })).toEqual({
      schema: "public",
      name: "orders",
      kind: "table",
    });
    expect(normalizeTable({ schema: "app", name: "v_stats", kind: "view" }).kind).toBe("view");
  });

  test("accepts pg_class relkind codes", () => {
    expect(normalizeTable({ schema: "s", name: "t", relkind: "r" }).kind).toBe("table");
    expect(normalizeTable({ schema: "s", name: "v", relkind: "v" }).kind).toBe("view");
  });

  test.each([[{ schema: "s", name: "t", kind: "materialized view" }], [{ schema: "", name: "t", kind: "r" }]])(
    "rejects unsupported rows %p",
    row => {
      expect(() => normalizeTable(row)).toThrow(MetadataError);
    },
  );
});

describe("normalizeColumn", () => {
  test("maps a full catalog row", () => {
    expect(normalizeColumn(columnRow)).toEqual({
      schema: "public",
      table: "order_items",
      name: "quantity",
      position: 5,
      dataType: "integer",
      udtName: "int4",
      nullable: false,
      hasDefault: false,
      default: null,
    });
  });

  test("coerces is_nullable YES/NO strings", () => {
    expect(normalizeColumn({ ...columnRow, nullable: "YES" }).nullable).toBe(true);
    expect(normalizeColumn({ ...columnRow, nullable: "NO" }).nullable).toBe(false);
  });

  test("falls back to information_schema key when nullable absent", () => {
    const { nullable: _omitted, ...rest } = columnRow;
    expect(normalizeColumn({ ...rest, is_nullable: "YES" }).nullable).toBe(true);
    expect(normalizeColumn({ ...rest, is_nullable: "NO" }).nullable).toBe(false);
  });

  test("marks hasDefault when a default expression exists", () => {
    const col = normalizeColumn({
      ...columnRow,
      default: "nextval('order_items_id_seq'::regclass)",
    });
    expect(col.hasDefault).toBe(true);
    expect(col.default).toContain("nextval");
  });

  test("explicit hasDefault flag wins over default text (identity columns)", () => {
    const col = normalizeColumn({ ...columnRow, hasDefault: true, default: null });
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBeNull();
  });

  test.each([
    ["YES", true],
    ["NO", false],
    [true, true],
    [false, false],
  ])("hasDefault accepts %p → %p", (flag, expected) => {
    expect(normalizeColumn({ ...columnRow, hasDefault: flag }).hasDefault).toBe(expected);
  });

  test("hasDefault rejects garbage", () => {
    expect(() => normalizeColumn({ ...columnRow, hasDefault: "MAYBE" })).toThrow(MetadataError);
  });

  test("coerces string ordinal positions (pg drivers vary)", () => {
    const col = normalizeColumn({ ...columnRow, position: "3" });
    expect(col.position).toBe(3);
  });

  test.each([
    [{ ...columnRow, position: 0 }],
    [{ ...columnRow, position: -1 }],
    [{ ...columnRow, position: "abc" }],
    [{ ...columnRow, nullable: "MAYBE" }],
    [{ ...columnRow, name: "" }],
    [{ ...columnRow, dataType: null }],
  ])("fails loudly on catalog drift %p", row => {
    expect(() => normalizeColumn(row)).toThrow(MetadataError);
  });
});

describe("normalizeFk", () => {
  const fkRow = {
    name: "order_items_orders_fk",
    childSchema: "public",
    childTable: "order_items",
    childColumns: ["shop_id", "order_no"],
    parentSchema: "public",
    parentTable: "orders",
    parentColumns: ["shop_id", "order_no"],
    onDelete: "c",
    onUpdate: "a",
  };

  test("expands action codes and keeps composite columns ordered", () => {
    expect(normalizeFk(fkRow)).toMatchObject({
      onDelete: "CASCADE",
      onUpdate: "NO ACTION",
      childColumns: ["shop_id", "order_no"],
      parentColumns: ["shop_id", "order_no"],
    });
  });

  test.each([
    ["a", "NO ACTION"],
    ["r", "RESTRICT"],
    ["n", "SET NULL"],
    ["d", "SET DEFAULT"],
  ])("action code %s → %s", (code, label) => {
    expect(normalizeFk({ ...fkRow, onDelete: code }).onDelete).toBe(label);
  });

  test.each([
    [{ ...fkRow, onDelete: "x" }],
    [{ ...fkRow, childColumns: [] }],
    [{ ...fkRow, childColumns: ["a", 1] }],
    [{ ...fkRow, childColumns: ["a", "b", "c"] }],
    [{ ...fkRow, parentTable: "" }],
  ])("rejects malformed fk rows %p", row => {
    expect(() => normalizeFk(row)).toThrow(MetadataError);
  });
});
