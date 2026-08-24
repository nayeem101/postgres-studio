import type { SQL } from "bun";
import { assertSafeIdent, quoteIdentifier } from "./identify";
import { decodeCursor, encodeCursor } from "./cursor";

/**
 * Keyset-paginated row reads (Phase 1 grid). Ordering keys default to the
 * primary key. The WHERE predicate is a row-value comparison against the
 * decoded cursor tuple, so every page is a fresh index seek — never OFFSET.
 *
 * Keyset caveat (v1): order columns must be NOT NULL (PKs satisfy this);
 * nullable sort keys need NULLS-handling before the UI exposes them.
 */

export interface ListRowsOptions {
  schema: string;
  table: string;
  /** Order columns, most significant first. Must be NOT NULL columns. */
  orderBy: string[];
  descending?: boolean;
  /** Opaque token from a previous page (`page.nextCursor`). */
  cursor?: string;
  limit: number;
}

/** JSON-clean cell value produced by jsonSafe. */
export type CellValue = string | number | boolean | null;

export interface RowsPage {
  rows: Array<Record<string, CellValue>>;
  /** Token for the following page; null when the result set is exhausted. */
  nextCursor: string | null;
}

export interface CompiledQuery {
  text: string;
  params: unknown[];
}

const MAX_LIMIT = 500;

/** Dates become ISO strings so payloads stay JSON-clean across the wire. */
export function jsonSafe(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export function compileRowsQuery(options: ListRowsOptions): CompiledQuery & { limit: number } {
  const { schema, table } = options;
  assertSafeIdent(schema, "schema");
  assertSafeIdent(table, "table");

  const orderBy = options.orderBy;
  if (!Array.isArray(orderBy) || orderBy.length === 0 || orderBy.length > 8) {
    throw new Error("orderBy requires between 1 and 8 columns");
  }
  for (const column of orderBy) assertSafeIdent(column, "order column");

  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), MAX_LIMIT);
  const dir = options.descending ? "DESC" : "ASC";
  const op = options.descending ? "<" : ">";

  // Identifiers are allowlist-validated AND double-quote escaped before they
  // touch this string; all runtime values go through bound parameters.
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const keyTuple = `(${orderBy.map(c => quoteIdentifier(c)).join(", ")})`;
  const orderList = orderBy.map(c => `${quoteIdentifier(c)} ${dir}`).join(", ");

  const cursorValues = options.cursor ? decodeCursor(options.cursor) : null;
  if (cursorValues && cursorValues.length !== orderBy.length) {
    throw new Error("cursor does not match the sort key");
  }

  let text = `select * from ${relation}`;
  const params: unknown[] = [];
  if (cursorValues) {
    const placeholders = cursorValues.map((_, i) => `$${i + 1}`).join(", ");
    text += ` where ${keyTuple} ${op} (${placeholders})`;
    params.push(...cursorValues);
  }
  text += ` order by ${orderList} limit ${limit + 1}`;

  return { text, params, limit };
}

/** Execute one keyset page. Caller owns validation policy for `orderBy`. */
export async function listRows(db: SQL, options: ListRowsOptions): Promise<RowsPage> {
  const { text, params, limit } = compileRowsQuery(options);
  // Multi-statement-free single SELECT with bound params via unsafe():
  // the only safe path when the identifier list is dynamic.
  const fetched = await db.unsafe(text, params);

  const rows = fetched.map((row: Record<string, unknown>) => {
    const clean: Record<string, CellValue> = {};
    for (const [key, value] of Object.entries(row)) {
      const safe = jsonSafe(value);
      clean[key] =
        safe === null || typeof safe === "string" || typeof safe === "number" || typeof safe === "boolean"
          ? safe
          : String(safe);
    }
    return clean;
  });

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    // NOTE: trimmed above; last kept row seeds the next page.
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor(
      options.orderBy.map(column => {
        const value = last[column];
        if (value === undefined || value === null || typeof value === "object") {
          throw new Error(`sort column "${column}" produced a value unusable for keyset paging`);
        }
        return value as string | number | boolean;
      }),
    );
  }

  return { rows, nextCursor };
}
