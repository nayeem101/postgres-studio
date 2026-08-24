/**
 * Isolated Postgres driver + catalog introspection + mutation SQL.
 * Swap Bun.sql here later without touching route handlers.
 * Pure helpers below are unit-tested without a database (Phase 0).
 */
export { IdentifierError, assertSafeIdent, quoteIdentifier, quoteQualified } from "./identify";
export { CursorError, decodeCursor, encodeCursor, type CursorValue } from "./cursor";
export {
  MetadataError,
  normalizeColumn,
  normalizeFk,
  normalizeTable,
  type ColumnMeta,
  type FkAction,
  type FkConstraintMeta,
  type TableMeta,
} from "./normalize";
export {
  tableKey,
  topoRestoreOrder,
  walkReferences,
  type FkEdge,
  type TableRef,
  type WalkOptions,
  type WalkStep,
} from "./fk-graph";
export { listColumns, listTables } from "./catalog";
