/**
 * Keyset-pagination cursor codec.
 *
 * Cursors are opaque base64url tokens wrapping an ordered tuple of column
 * values. Values must be JSON-safe primitives (string | number | boolean |
 * null) — exactly what the Postgres driver returns for sortable key columns.
 */

export type CursorValue = string | number | boolean | null;

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

function assertPrimitive(value: unknown, index: number): CursorValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new CursorError(`cursor entry ${index} is not a primitive (got ${typeof value})`);
}

/** Encode an ordered keyset tuple into a URL-safe opaque token. */
export function encodeCursor(values: readonly CursorValue[]): string {
  if (!Array.isArray(values)) {
    throw new CursorError("cursor payload must be an array");
  }
  const checked = values.map(assertPrimitive);
  return Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
}

/** Decode a token produced by `encodeCursor`. Throws `CursorError` on any tampering. */
export function decodeCursor(cursor: string): CursorValue[] {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new CursorError("cursor must be a non-empty string");
  }
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new CursorError("cursor is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CursorError("cursor payload is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CursorError("cursor payload must be an array");
  }
  return parsed.map(assertPrimitive);
}
