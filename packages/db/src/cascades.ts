import type { SQL } from "bun";
import { quoteIdentifier } from "./identify";
import { listIncomingFks } from "./fks";
import { listPrimaryKeys, type PrimaryKeyMeta } from "./schema-meta";
import type { FkConstraintMeta } from "./normalize";
import type { CellValue } from "./rows";

/**
 * Cascade-aware before-image capture (Phase 3).
 *
 * When a parent row is deleted, Postgres silently cascades (or nulls) child
 * rows. Rollback fidelity requires snapshotting those children BEFORE the
 * delete runs. This walker expands CASCADE deletes and SET NULL/SET DEFAULT
 * updates breadth-first with cycle guards for self/mutual references.
 */

export interface CascadeRow {
  schema: string;
  table: string;
  pkColumns: string[];
  /** Full row state captured pre-mutation. */
  row: Record<string, CellValue>;
  /** Why this row was touched: children die (cascade) or lose their reference. */
  effect: "cascade" | "set-null";
  viaConstraint: string;
  depth: number;
}

export interface CascadeCollection {
  rows: CascadeRow[];
  /** Tables skipped because they lack a primary key (cannot be restored). */
  skippedTables: string[];
}

export interface CascadeOptions {
  rootSchema: string;
  rootTable: string;
  rootPkColumns: string[];
  rootTuples: readonly CellValue[][];
  maxDepth?: number;
}

interface Frontier {
  schema: string;
  table: string;
  pkColumns: string[];
  tuples: CellValue[][];
  depth: number;
}

const tableKeyOf = (schema: string, table: string) => `${schema}.${table}`;

export async function collectCascadingRows(
  db: SQL,
  options: CascadeOptions,
): Promise<CascadeCollection> {
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 8));
  const [allPks, rootIncoming] = await Promise.all([
    listPrimaryKeys(db),
    incomingFor(db, options.rootSchema, options.rootTable),
  ]);

  const pkByTable = new Map<string, PrimaryKeyMeta>();
  for (const pk of allPks) pkByTable.set(tableKeyOf(pk.schema, pk.table), pk);

  const incomingCache = new Map<string, FkConstraintMeta[]>([
    [tableKeyOf(options.rootSchema, options.rootTable), rootIncoming],
  ]);
  const incomingForCached = async (schema: string, table: string) => {
    const key = tableKeyOf(schema, table);
    let fks = incomingCache.get(key);
    if (!fks) {
      fks = await incomingFor(db, schema, table);
      incomingCache.set(key, fks);
    }
    return fks;
  };

  const collected = new Map<string, CascadeRow>();
  const skippedTables = new Set<string>();
  // Visited guard: one expansion per (table, pk tuple) — self-FK cycles and
  // mutual cascades terminate instead of walking forever.
  const expanded = new Set<string>();

  let frontier: Frontier[] =
    options.rootTuples.length === 0
      ? []
      : [
          {
            schema: options.rootSchema,
            table: options.rootTable,
            pkColumns: options.rootPkColumns,
            tuples: [...options.rootTuples],
            depth: 0,
          },
        ];

  while (frontier.length > 0 && frontier[0].depth < maxDepth) {
    const next: Frontier[] = [];
    for (const node of frontier) {
      const cascades = (await incomingForCached(node.schema, node.table)).filter(
        fk => fk.parentSchema === node.schema && fk.parentTable === node.table,
      );

      for (const fk of cascades.filter(fk => fk.onDelete === "CASCADE")) {
        const childPk = pkByTable.get(tableKeyOf(fk.childSchema, fk.childTable));
        if (!childPk) {
          skippedTables.add(tableKeyOf(fk.childSchema, fk.childTable));
          continue;
        }
        const childRows = await selectChildren(db, node, fk);
        const fresh: CellValue[][] = [];
        for (const row of childRows) {
          const pkValues = childPk.columns.map(c => row[c] ?? null);
          const key = `${tableKeyOf(fk.childSchema, fk.childTable)}:${JSON.stringify(pkValues)}`;
          if (expanded.has(key)) continue;
          expanded.add(key);
          collected.set(key, {
            schema: fk.childSchema,
            table: fk.childTable,
            pkColumns: childPk.columns,
            row,
            effect: "cascade",
            viaConstraint: fk.name,
            depth: node.depth + 1,
          });
          fresh.push(pkValues);
        }
        if (fresh.length > 0 && fk.childTable !== fk.parentTable) {
          next.push({
            schema: fk.childSchema,
            table: fk.childTable,
            pkColumns: childPk.columns,
            tuples: fresh,
            depth: node.depth + 1,
          });
        }
      }

      for (const fk of cascades.filter(
        candidate => candidate.onDelete === "SET NULL" || candidate.onDelete === "SET DEFAULT",
      )) {
        // Children survive but lose/replace their reference value; capture the
        // full before-image so restore can rewrite the column.
        const childPk = pkByTable.get(tableKeyOf(fk.childSchema, fk.childTable));
        if (!childPk) {
          skippedTables.add(tableKeyOf(fk.childSchema, fk.childTable));
          continue;
        }
        const childRows = await selectChildren(db, node, fk);
        for (const row of childRows) {
          const pkValues = childPk.columns.map(c => row[c] ?? null);
          const key = `${tableKeyOf(fk.childSchema, fk.childTable)}:${JSON.stringify(pkValues)}`;
          if (expanded.has(key)) continue;
          expanded.add(key);
          collected.set(key, {
            schema: fk.childSchema,
            table: fk.childTable,
            pkColumns: childPk.columns,
            row,
            effect: "set-null",
            viaConstraint: fk.name,
            depth: node.depth + 1,
          });
        }
      }
    }
    frontier = next;
  }

  return {
    rows: [...collected.values()].sort(
      (a, b) =>
        a.depth - b.depth ||
        tableKeyOf(a.schema, a.table).localeCompare(tableKeyOf(b.schema, b.table)) ||
        JSON.stringify(a.row).localeCompare(JSON.stringify(b.row)),
    ),
    skippedTables: [...skippedTables].sort(),
  };
}

async function incomingFor(db: SQL, schema: string, table: string): Promise<FkConstraintMeta[]> {
  return listIncomingFks(db, schema, table);
}

/** Child rows referencing any tuple on the current frontier, via one FK. */
async function selectChildren(db: SQL, node: Frontier, fk: FkConstraintMeta): Promise<Array<Record<string, CellValue>>> {
  const parentColumnPosition = new Map<string, number>();
  fk.parentColumns.forEach((column, index) => parentColumnPosition.set(column, index));

  const childSelectList = fk.childColumns.map(c => quoteIdentifier(c)).join(", ");
  const params: CellValue[] = [];
  const tupleLiterals = node.tuples.map(tuple =>
    `(${fk.parentColumns
      .map(parentColumn => {
        const value = tuple[parentColumnPosition.get(parentColumn)!];
        params.push(value ?? null);
        return `$${params.length}`;
      })
      .join(", ")})`,
  );

  const result = await db.unsafe(
    `select * from ${quoteIdentifier(fk.childSchema)}.${quoteIdentifier(fk.childTable)}
     where (${childSelectList}) in (${tupleLiterals.join(", ")})`,
    params,
  );
  return result as Array<Record<string, CellValue>>;
}
