/**
 * Normalization of raw pg_catalog / information_schema rows into studio types.
 * Pure transforms so catalog shape drift fails loudly and unit-testably.
 */

export interface TableMeta {
  schema: string;
  name: string;
  kind: "table" | "view";
}

export interface ColumnMeta {
  schema: string;
  table: string;
  name: string;
  position: number;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
  default: string | null;
}

/** FK delete/update action codes as stored in pg_constraint.confdeltype/confupdtype. */
export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface FkConstraintMeta {
  name: string;
  childSchema: string;
  childTable: string;
  childColumns: string[];
  parentSchema: string;
  parentTable: string;
  parentColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
}

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MetadataError(`catalog row field "${key}" must be a non-empty string`);
  }
  return value;
}

function num(row: Row, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MetadataError(`catalog row field "${key}" must be a positive integer`);
  }
  return parsed;
}

function optStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MetadataError(`catalog row field "${key}" must be a string or null`);
  return value;
}

function action(code: unknown, field: string): FkAction {
  switch (code) {
    case "a": return "NO ACTION";
    case "r": return "RESTRICT";
    case "c": return "CASCADE";
    case "n": return "SET NULL";
    case "d": return "SET DEFAULT";
    default: throw new MetadataError(`unknown ${field} code ${JSON.stringify(code)}`);
  }
}

export function normalizeTable(row: Row): TableMeta {
  const relkind = row.kind ?? row.relkind;
  let kind: TableMeta["kind"];
  if (relkind === "table" || relkind === "r") kind = "table";
  else if (relkind === "view" || relkind === "v") kind = "view";
  else throw new MetadataError(`unsupported relation kind ${JSON.stringify(relkind)}`);
  return { schema: str(row, "schema"), name: str(row, "name"), kind };
}

export function normalizeColumn(row: Row): ColumnMeta {
  const isNullableRaw = row.nullable ?? row.is_nullable;
  if (isNullableRaw !== "YES" && isNullableRaw !== "NO" && isNullableRaw !== true && isNullableRaw !== false) {
    throw new MetadataError(`catalog row field "is_nullable" must be YES/NO`);
  }
  const nullable = isNullableRaw === "YES" || isNullableRaw === true;
  const def = optStr(row, "default");
  return {
    schema: str(row, "schema"),
    table: str(row, "table"),
    name: str(row, "name"),
    position: num(row, "position"),
    dataType: str(row, "dataType"),
    udtName: str(row, "udtName"),
    nullable,
    hasDefault: def !== null,
    default: def,
  };
}

export function normalizeFk(row: Row): FkConstraintMeta {
  const childColumns = strArray(row, "childColumns");
  const parentColumns = strArray(row, "parentColumns");
  if (childColumns.length === 0 || parentColumns.length === 0) {
    throw new MetadataError("foreign key must reference at least one column");
  }
  if (childColumns.length !== parentColumns.length) {
    throw new MetadataError(
      `foreign key column count mismatch: ${childColumns.length} child vs ${parentColumns.length} parent`,
    );
  }
  return {
    name: str(row, "name"),
    childSchema: str(row, "childSchema"),
    childTable: str(row, "childTable"),
    childColumns,
    parentSchema: str(row, "parentSchema"),
    parentTable: str(row, "parentTable"),
    parentColumns,
    onDelete: action(row.onDelete, "onDelete"),
    onUpdate: action(row.onUpdate, "onUpdate"),
  };
}

function strArray(row: Row, key: string): string[] {
  const value = row[key];
  if (
    !Array.isArray(value) ||
    (value as unknown[]).some(v => typeof v !== "string" || v.length === 0)
  ) {
    throw new MetadataError(`catalog row field "${key}" must be an array of non-empty strings`);
  }
  return value as string[];
}
