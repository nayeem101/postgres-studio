import { describe, expect, test } from "bun:test";
import { pickDisplayColumn } from "../../packages/db/src/references";

const col = (name: string, dataType = "text") => ({ name, dataType });

describe("pickDisplayColumn", () => {
  test("prefers human-readable names in priority order", () => {
    const columns = [col("id", "integer"), col("email"), col("name")];
    // name beats email
    expect(pickDisplayColumn(columns, ["id"])).toBe("name");
  });

  test("falls back to first textual non-pk column", () => {
    const columns = [col("id", "integer"), col("bio"), col("age", "integer")];
    expect(pickDisplayColumn(columns, ["id"])).toBe("bio");
  });

  test("ignores pk columns unless nothing else exists", () => {
    expect(pickDisplayColumn([col("shop_id", "integer"), col("order_no", "integer")], ["shop_id", "order_no"]))
      .toBe("shop_id");
  });

  test("case-insensitive preferred match and USER-DEFINED counts as textual", () => {
    expect(pickDisplayColumn([col("ID", "integer"), col("Code")], ["ID"])).toBe("Code");
    expect(pickDisplayColumn([col("mood", "USER-DEFINED"), col("n", "integer")], [])).toBe("mood");
  });

  test("empty column list yields null", () => {
    expect(pickDisplayColumn([], ["id"])).toBeNull();
  });
});
