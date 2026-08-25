import type { SQL } from "bun";
import { quoteIdentifier } from "./identify";
import type { CellValue } from "./rows";

/**
 * Global search across tables (Phase 3 optional).
 *
 * Two-phase exact pagination: per-table match counts establish stable global
 * offsets, then only the tables intersecting the requested page are queried
 * for rows. Only textual columns (char/varchar/text/citext) are searched;
 * user input is escaped for LIKE so %/_ cannot widen the match.
 */

export interface SearchCandidate {
  schema: string;
  name: string;
  columns: Array<{ name: string; dataType: string }>;
}

export interface SearchResult {
  schema: string;
  table: string;
  pkColumns: string[];
  pkValues: CellValue[];
  matchedColumn: string;
  snippet: string;
}

export interface SearchPage {
  results: SearchResult[];
  total: number;
  nextOffset: number | null;
}

const isTextual = (dataType: string): boolean =>
  dataType.includes("char") || dataType.includes("text") || dataType === "citext";

/** Escape user input for a LIKE pattern with the default backslash escape. */
export function likePattern(input: string): string {
  return "%" + input.replace(/[\\%_]/g, ch => `\\${ch}`) + "%";
}

interface TablePlan {
  schema: string;
  name: string;
  searchable: string[];
  pkColumns: string[];
  count: number;
}

export async function searchAcrossTables(
  db: SQL,
  options: {
    query: string;
    offset?: number;
    limit?: number;
    candidates: readonly SearchCandidate[];
    primaryKeyOf: (schema: string, table: string) => string[];
  },
): Promise<SearchPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const pattern = likePattern(options.query);

  // Phase 1: cheap per-table counts to lay out stable global offsets.
  const plans: TablePlan[] = [];
  for (const candidate of [...options.candidates].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
  )) {
    const searchable = candidate.columns.filter(c => isTextual(c.dataType)).map(c => c.name);
    if (searchable.length === 0) continue;
    const pkColumns = options.primaryKeyOf(candidate.schema, candidate.name);
    if (pkColumns.length === 0) continue;

    const predicate = searchable.map(c => `${quoteIdentifier(c)} ilike $1 escape '\\'`).join(" or ");
    const [row] = await db.unsafe(
      `select count(*)::int as n from ${quoteIdentifier(candidate.schema)}.${quoteIdentifier(candidate.name)} where ${predicate}`,
      [pattern],
    );
    const count = Number((row as Record<string, unknown>).n);
    if (count > 0) plans.push({ schema: candidate.schema, name: candidate.name, searchable, pkColumns, count });
  }

  const total = plans.reduce((sum, plan) => sum + plan.count, 0);

  // Phase 2: fetch rows only from tables overlapping [offset, offset+limit).
  const results: SearchResult[] = [];
  let consumed = 0;
  for (const plan of plans) {
    const planStart = consumed;
    const planEnd = consumed + plan.count;
    consumed = planEnd;

    const overlapStart = Math.max(planStart, offset);
    const overlapEnd = Math.min(planEnd, offset + limit);
    if (overlapStart >= overlapEnd) {
      if (planStart >= offset + limit) break; // plans are ordered; nothing further overlaps
      continue;
    }
    const withinOffset = overlapStart - planStart;
    const withinLimit = overlapEnd - overlapStart;

    const predicate = plan.searchable.map(c => `${quoteIdentifier(c)} ilike $1 escape '\\'`).join(" or ");
    const orderBy = plan.pkColumns.map(c => quoteIdentifier(c)).join(", ");
    const rows = await db.unsafe(
      `select * from ${quoteIdentifier(plan.schema)}.${quoteIdentifier(plan.name)}
       where ${predicate}
       order by ${orderBy}
       limit ${withinLimit} offset ${withinOffset}`,
      [pattern],
    );

    for (const raw of rows as Array<Record<string, unknown>>) {
      const row = raw as Record<string, CellValue>;
      const matchedColumn =
        plan.searchable.find(column => {
          const value = row[column];
          return typeof value === "string" && value.toLowerCase().includes(options.query.toLowerCase());
        }) ?? plan.searchable[0];
      results.push({
        schema: plan.schema,
        table: plan.name,
        pkColumns: plan.pkColumns,
        pkValues: plan.pkColumns.map(c => row[c] ?? null),
        matchedColumn,
        snippet: String(row[matchedColumn] ?? "").slice(0, 120),
      });
    }
  }

  return { results, total, nextOffset: offset + limit < total ? offset + limit : null };
}
