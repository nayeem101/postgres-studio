/**
 * Pure FK graph helpers: traversal guard for the bidirectional drawer
 * (Phase 2) and topological ordering for batch restore (Phase 3).
 * No database access — operates on normalized FK metadata.
 */

export interface TableRef {
  schema: string;
  name: string;
}

export interface FkEdge {
  /** Referencing (child) side. */
  from: TableRef;
  /** Referenced (parent) side. */
  to: TableRef;
}

export const tableKey = (t: TableRef): string => `${t.schema}.${t.name}`;

const refCmp = (a: TableRef, b: TableRef): number =>
  a.schema === b.schema ? a.name.localeCompare(b.name) : a.schema.localeCompare(b.schema);

const edgeKey = (e: FkEdge): string => `${tableKey(e.from)}->${tableKey(e.to)}`;

export interface WalkStep {
  depth: number;
  direction: "outgoing" | "incoming";
  /** Edge used to arrive; `from`/`to` relative to the relation, not the walk. */
  via: FkEdge;
  table: TableRef;
}

export interface WalkOptions {
  /** Maximum relationship hops from the starting row/table. Default 3. */
  maxDepth?: number;
}

/**
 * Breadth-first walk over FK edges starting at `start`, following both
 * outgoing and incoming relations.
 *
 * Loop guards:
 *  - each (table, direction) pair is expanded at most once (visited dedupe),
 *    so self-FKs and mutual cycles cannot recurse unbounded;
 *  - hard stop after `maxDepth` levels (default 3).
 * Self-edges are never followed.
 */
export function walkReferences(edges: readonly FkEdge[], start: TableRef, options: WalkOptions = {}): WalkStep[] {
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 3));
  const startKey = tableKey(start);
  const steps: WalkStep[] = [];
  const expanded = new Set<string>();
  let frontier: Array<{ table: TableRef; depth: number }> = [{ table: start, depth: 0 }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Array<{ table: TableRef; depth: number }> = [];
    for (const node of frontier) {
      const nodeKey = tableKey(node.table);
      const related = edges
        .filter(
          e =>
            tableKey(e.from) !== tableKey(e.to) &&
            (tableKey(e.from) === nodeKey || tableKey(e.to) === nodeKey),
        )
        .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

      for (const edge of related) {
        const outgoing = tableKey(edge.from) === nodeKey;
        const dirFlag = outgoing ? "out" : "in";
        const target = outgoing ? edge.to : edge.from;
        const targetKey = tableKey(target);

        // Never expand back into the origin row's table in the same direction
        // it was already rooted at — prevents ping-ponging between two tables.
        if (!expanded.has(`${dirFlag}|${targetKey}`)) {
          expanded.add(`${dirFlag}|${targetKey}`);
          steps.push({ depth, direction: outgoing ? "outgoing" : "incoming", via: edge, table: target });
          next.push({ table: target, depth });
        }
      }
      expanded.add(`root|${nodeKey}`);
    }
    frontier = next;
  }
  return steps;
}

/**
 * Order tables for restoring rows: referenced (parent) tables before their
 * referencing (child) tables. Self-referential edges are ignored (row-level
 * ordering handles them); dependency cycles fall back to appending remaining
 * nodes in name order after the acyclic prefix.
 */
export function topoRestoreOrder(tables: readonly TableRef[], edges: readonly FkEdge[]): TableRef[] {
  const keySet = new Set(tables.map(tableKey));
  if (keySet.size !== tables.length) {
    throw new Error("topoRestoreOrder received duplicate tables");
  }

  // deps[child] = set of parents that must be restored first
  const deps = new Map<string, Set<string>>();
  for (const key of keySet) deps.set(key, new Set());
  for (const e of edges) {
    const child = tableKey(e.from);
    const parent = tableKey(e.to);
    if (child === parent || !keySet.has(child) || !keySet.has(parent)) continue;
    deps.get(child)?.add(parent);
  }

  const ordered: TableRef[] = [];
  const placed = new Set<string>();
  const pending = [...tables].sort(refCmp);

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i]!;
      const k = tableKey(t);
      const unmet = [...(deps.get(k) ?? [])].some(d => !placed.has(d));
      if (!unmet) {
        placed.add(k);
        ordered.push(t);
        pending.splice(i, 1);
        i--;
        progress = true;
      }
    }
  }
  for (const t of pending) {
    placed.add(tableKey(t));
    ordered.push(t);
  }
  return ordered;
}
