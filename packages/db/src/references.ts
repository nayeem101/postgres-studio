import type { SQL } from "bun";
import { quoteIdentifier } from "./identify";
import { compileSelectByPkTuples } from "./mutations";
import { listIncomingFks, listOutgoingFks } from "./fks";
import type { CellValue } from "./rows";

/**
 * Row-level reference resolution for the bidirectional FK drawer.
 * Outgoing: resolve the parent row each FK points at, with a human display
 * column. Incoming: per-FK child counts plus a page of child rows so badges
 * match COUNT(*) exactly.
 */

export interface ColumnInfo {
  name: string;
  dataType: string;
}

const PREFERRED_DISPLAY = [
  "name",
  "title",
  "label",
  "email",
  "code",
  "username",
  "slug",
];

/**
 * Pick the column shown as the drawer's preview label: first preferred
 * name match, else first text-ish non-PK column, else the PK itself.
 */
export function pickDisplayColumn(
  columns: readonly ColumnInfo[],
  pkColumns: readonly string[],
): string | null {
  if (columns.length === 0) return null;
  const pk = new Set(pkColumns);
  const candidates = columns.filter(c => !pk.has(c.name));
  const pool = candidates.length > 0 ? candidates : columns;

  for (const preferred of PREFERRED_DISPLAY) {
    const hit = pool.find(c => c.name.toLowerCase() === preferred);
    if (hit) return hit.name;
  }
  const textual = pool.find(
    c =>
      c.dataType.includes("char") ||
      c.dataType.includes("text") ||
      c.dataType === "USER-DEFINED",
  );
  return (textual ?? pool[0]).name;
}

export interface OutgoingReference {
  constraintName: string;
  parentSchema: string;
  parentTable: string;
  /** Resolved parent preview; null when any FK column is NULL or dangling. */
  preview: {
    row: Record<string, CellValue>;
    displayColumn: string;
  } | null;
}

export interface ResolveOptions {
  schema: string;
  table: string;
  pkColumns: readonly string[];
  /** The currently viewed row (all its columns). */
  row: Record<string, CellValue>;
  displayColumns?: ReadonlyMap<string, readonly string[]>;
}

/** Resolve every outgoing FK of one row to its parent-row preview. */
export async function resolveOutgoingReferences(db: SQL, options: ResolveOptions): Promise<OutgoingReference[]> {
  const fks = await listOutgoingFks(db, options.schema, options.table);
  const results: OutgoingReference[] = [];

  for (const fk of fks) {
    const values = fk.childColumns.map(column => options.row[column] ?? null);
    if (values.some(v => v === null)) {
      results.push({
        constraintName: fk.name,
        parentSchema: fk.parentSchema,
        parentTable: fk.parentTable,
        preview: null,
      });
      continue;
    }
    const compiled = compileSelectByPkTuples({
      schema: fk.parentSchema,
      table: fk.parentTable,
      pkColumns: fk.parentColumns,
      tuples: [values],
    });
    const rows = await db.unsafe(compiled.text, compiled.params);
    if (rows.length === 0) {
      results.push({
        constraintName: fk.name,
        parentSchema: fk.parentSchema,
        parentTable: fk.parentTable,
        preview: null,
      });
      continue;
    }
    const parentRow = rows[0] as Record<string, CellValue>;
    const parentColumnInfos = Object.entries(parentRow).map(([name, value]) => ({
      name,
      // Type signal only — display picking cares about char/text-ness.
      dataType: typeof value === "string" ? "text" : typeof value === "number" ? "integer" : "unknown",
    }));
    const displayColumn =
      options.displayColumns?.get(`${fk.parentSchema}.${fk.parentTable}`)?.[0] ??
      pickDisplayColumn(parentColumnInfos, fk.parentColumns);

    results.push({
      constraintName: fk.name,
      parentSchema: fk.parentSchema,
      parentTable: fk.parentTable,
      preview: { row: parentRow, displayColumn },
    });
  }
  return results;
}

export interface IncomingGroup {
  constraintName: string;
  childSchema: string;
  childTable: string;
  childColumns: string[];
  /** Exact count of children referencing this parent row (badge source). */
  totalCount: number;
  rows: Array<Record<string, CellValue>>;
  nextOffset: number | null;
}

export interface IncomingOptions extends ResolveOptions {
  offset?: number;
  limit?: number;
}

/** Per-incoming-FK child groups with exact counts and a page of rows. */
export async function resolveIncomingReferences(db: SQL, options: IncomingOptions): Promise<IncomingGroup[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const fks = await listIncomingFks(db, options.schema, options.table);
  const pkValues = options.pkColumns.map(column => options.row[column] ?? null);

  const groups: IncomingGroup[] = [];
  for (const fk of fks) {
    const predicate = fk.childColumns
      .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
      .join(" and ");
    const params: CellValue[] = [...pkValues];

    const countResult = await db.unsafe(
      `select count(*)::int as n from ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)} where ${predicate}`,
      params,
    );
    const totalCount = Number((countResult[0] as { n: number }).n);
    if (totalCount === 0) {
      groups.push({
        constraintName: fk.name,
        childSchema: fk.childSchema,
        childTable: fk.childTable,
        childColumns: fk.childColumns,
        totalCount: 0,
        rows: [],
        nextOffset: null,
      });
      continue;
    }

    const pageParams: CellValue[] = [...pkValues];
    const rows = await db.unsafe(
      `select * from ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)} where ${predicate} order by ${quoteIdentifier(fk.childColumns[0])} limit ${limit} offset ${offset}`,
      pageParams,
    );    const fetched = rows.length;
    const nextOffset = offset + fetched < totalCount ? offset + fetched : null;
    groups.push({
      constraintName: fk.name,
      childSchema: fk.childSchema,
      childTable: fk.childTable,
      childColumns: fk.childColumns,
      totalCount,
      rows: rows as Array<Record<string, CellValue>>,
      nextOffset,
    });
  }
  return groups.sort((a, b) => a.constraintName.localeCompare(b.constraintName));
}
