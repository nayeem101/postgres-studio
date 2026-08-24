import { describe, expect, test } from "bun:test";
import { IdentifierError, assertSafeIdent, quoteIdentifier, quoteQualified } from "../../packages/db/src/identify";

describe("assertSafeIdent", () => {
  test("accepts plain identifiers", () => {
    expect(assertSafeIdent("orders")).toBe("orders");
    expect(assertSafeIdent("_private")).toBe("_private");
    expect(assertSafeIdent("col1$x")).toBe("col1$x");
  });

  test.each([
    [""],
    ["123abc"],
    ["has space"],
    ['quote"inside'],
    ["semi;colon"],
    ["drop--table"],
    ["schema.table"],
    ["null\0byte"],
    [null],
    [42],
  ])("rejects %p", input => {
    expect(() => assertSafeIdent(input)).toThrow(IdentifierError);
  });

  test("rejects names over 63 chars (NAMEDATALEN)", () => {
    const long = "a".repeat(64);
    expect(() => assertSafeIdent(long)).toThrow(/63/);
    expect(assertSafeIdent("a".repeat(63))).toBe("a".repeat(63));
  });
});

describe("quoteIdentifier", () => {
  test("wraps catalog-sourced names in double quotes", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
  });

  test("doubles embedded quotes safely", () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
  });

  test("allows reserved-looking and spaced catalog names", () => {
    expect(quoteIdentifier("select")).toBe('"select"');
    expect(quoteIdentifier("my table")).toBe('"my table"');
  });

  test.each([[""], ["nul\0byte"], ["x".repeat(64)], [undefined]])("rejects %p", input => {
    expect(() => quoteIdentifier(input)).toThrow(IdentifierError);
  });
});

describe("quoteQualified", () => {
  test("joins quoted schema and table", () => {
    expect(quoteQualified("public", "order_items")).toBe('"public"."order_items"');
  });

  test("quotes each part independently", () => {
    expect(quoteQualified('od"d"schema', 't"; drop table x')).toBe(
      '"od""d""schema"."t""; drop table x"',
    );
  });
});
