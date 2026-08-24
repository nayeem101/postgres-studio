/**
 * Isolated Postgres driver + catalog introspection + mutation SQL.
 * Swap Bun.sql here later without touching route handlers.
 */
export function notImplemented(surface: string): never {
  throw new Error(`[packages/db] ${surface} is not implemented (Phase 0+)`);
}
