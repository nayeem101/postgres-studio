/**
 * Identifier validation and quoting.
 *
 * Two layers (AGENTS.md non-negotiable #5):
 *  - `assertSafeIdent` — strict allowlist for names that arrive from outside
 *    the process (URL paths, query params) before they ever reach a catalog.
 *  - `quoteIdentifier` — escaping for names sourced from pg_catalog; still
 *    rejects NUL bytes and oversized input, doubles embedded quotes.
 */

const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** PostgreSQL NAMEDATALEN (64) minus terminating NUL. */
const MAX_IDENT_LENGTH = 63;

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentifierError";
  }
}

function assertBasic(name: unknown, label: string): string {
  if (typeof name !== "string") {
    throw new IdentifierError(`${label} must be a string`);
  }
  if (name.length === 0) {
    throw new IdentifierError(`${label} must not be empty`);
  }
  if (name.includes("\0")) {
    throw new IdentifierError(`${label} must not contain NUL bytes`);
  }
  if (name.length > MAX_IDENT_LENGTH) {
    throw new IdentifierError(`${label} exceeds ${MAX_IDENT_LENGTH} characters: ${name.length}`);
  }
  return name;
}

/** Strict allowlist check. Use for untrusted input before catalog lookups. */
export function assertSafeIdent(name: unknown, label = "identifier"): string {
  const value = assertBasic(name, label);
  if (!SAFE_IDENT_RE.test(value)) {
    throw new IdentifierError(`${label} is not a safe identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Quote an identifier for safe interpolation into SQL text.
 * Accepts any catalog-sourced name (including ones needing quotes);
 * rejects NUL and >63-char names outright.
 */
export function quoteIdentifier(name: unknown, label = "identifier"): string {
  const value = assertBasic(name, label);
  return `"${value.replaceAll('"', '""')}"`;
}

/** Quote and join a schema-qualified relation name, e.g. `"public"."orders"`. */
export function quoteQualified(schema: unknown, table: unknown): string {
  return `${quoteIdentifier(schema, "schema")}.${quoteIdentifier(table, "table")}`;
}
