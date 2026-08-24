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
export { listIncomingFks, listOutgoingFks, listTableFks } from "./fks";
export {
  listEnums,
  listIndexes,
  listPrimaryKeys,
  listUniqueConstraints,
  type EnumMeta,
  type IndexMeta,
  type PrimaryKeyMeta,
  type UniqueConstraintMeta,
} from "./schema-meta";
export {
  compileRowsQuery,
  jsonSafe,
  listRows,
  type CompiledQuery,
  type ListRowsOptions,
  type RowsPage,
} from "./rows";
export {
  compileDelete,
  compileInsert,
  compileSelectByPkTuples,
  compileUpdate,
} from "./mutations";
