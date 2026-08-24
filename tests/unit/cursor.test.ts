import { describe, expect, test } from "bun:test";
import { CursorError, decodeCursor, encodeCursor } from "../../packages/db/src/cursor";

describe("cursor codec", () => {
  test("round-trips mixed primitive tuples", () => {
    const cases: Array<Array<string | number | boolean | null>> = [
      [1],
      ["2024-01-01T00:00:00Z", 42],
      ["abc", null],
      [true, false],
      [],
      ["unicode ✓ emoji 🎉"],
    ];
    for (const values of cases) {
      expect(decodeCursor(encodeCursor(values))).toEqual(values);
    }
  });

  test("produces URL-safe tokens (no + / =)", () => {
    const token = encodeCursor(["~~~???", "\n\t\"", -1.5e10]);
    expect(token).not.toMatch(/[+/=]/);
  });

  test("large int64 keys stay strings and survive round-trip", () => {
    const big = "9223372036854775807";
    expect(decodeCursor(encodeCursor([big]))).toEqual([big]);
  });

  test("rejects malformed base64url payloads", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(CursorError);
  });

  test("rejects non-array JSON payloads", () => {
    const bad = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/array/);
  });

  test.each([
    [[{ x: 1 }]],
    [[[1]]],
    [[undefined as unknown as null]],
    [["ok", { deep: true }]],
  ])("rejects non-primitive entry %p", values => {
    expect(() => encodeCursor(values as never)).toThrow(CursorError);
  });

  test("rejects empty or non-string tokens", () => {
    expect(() => decodeCursor("")).toThrow(CursorError);
    expect(() => decodeCursor(undefined as unknown as string)).toThrow(CursorError);
  });
});
