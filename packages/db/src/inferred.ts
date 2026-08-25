/**
 * Name-heuristic relationship inference (Phase 2, opt-in).
 * Pure function over catalog metadata — never touches the database.
 * Columns already covered by real FK constraints are excluded by the caller.
 */

export interface InferredColumn {
  name: string;
}

export interface InferredTable {
  schema: string;
  name: string;
}

export interface InferredRelation {
  column: string;
  parentSchema: string;
  parentTable: string;
  /** strong: exact/pluralized table-name match. weak: suffix match. */
  confidence: "strong" | "weak";
}

function singularCandidates(base: string): string[] {
  const candidates = [base];
  if (base.endsWith("ies")) candidates.push(`${base.slice(0, -3)}y`); // companies -> company
  if (base.endsWith("ses")) candidates.push(base.slice(0, -2)); // statuses -> status
  if (base.endsWith("s")) candidates.push(base.slice(0, -1)); // customers -> customer
  return candidates;
}

export function inferRelations(input: {
  schema: string;
  table: string;
  columns: readonly InferredColumn[];
  tables: readonly InferredTable[];
  /** Child-column groups already covered by REAL foreign keys. */
  realFkChildColumns: ReadonlyArray<readonly string[]>;
}): InferredRelation[] {
  const coveredByRealFk = new Set(input.realFkChildColumns.flat());
  const relations: InferredRelation[] = [];

  for (const column of input.columns) {
    if (!column.name.endsWith("_id")) continue;
    if (coveredByRealFk.has(column.name)) continue;

    const base = column.name.slice(0, -3); // strip "_id"
    // Also consider the trailing segment so prefixed columns like
    // delivery_address_id still resolve to `addresses`.
    const bases = [base];
    const lastSegment = base.split("_").at(-1);
    if (lastSegment && lastSegment !== base) bases.push(lastSegment);

    let best: { table: InferredTable; confidence: "strong" | "weak" } | null = null;

    for (const table of input.tables) {
      const names = singularCandidates(table.name);
      // A table never "references" itself through inference of its own name.
      if (table.schema === input.schema && table.name === input.table && bases.some(candidate => names.includes(candidate))) {
        continue;
      }
      if (bases.some(candidate => names.includes(candidate))) {
        best = { table, confidence: "strong" };
        break;
      }
      if (!best && table.name.includes(base)) {
        best = { table, confidence: "weak" };
      }
    }

    if (best) {
      relations.push({
        column: column.name,
        parentSchema: best.table.schema,
        parentTable: best.table.name,
        confidence: best.confidence,
      });
    }
  }
  return relations;
}
