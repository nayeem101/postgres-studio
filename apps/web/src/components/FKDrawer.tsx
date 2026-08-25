import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { CellValue, IncomingGroup, InferredRelation, OutgoingReference, Row, StudioClient } from "../api";

export interface DrawerTarget {
  schema: string;
  table: string;
  pkValues: CellValue[];
}

export interface FKDrawerProps {
  target: DrawerTarget;
  client: StudioClient;
  /** Navigate the drawer to another row (click-through). */
  onNavigate: (target: DrawerTarget) => void;
  onClose: () => void;
  /** True when target sits deeper than position 0 in the history stack. */
  canGoBack?: boolean;
  onBack?: () => void;
}

/** Derive a child row's pk tuple given its table's pk columns. */
function pkFromRow(row: Record<string, CellValue>, pkColumns: string[]): CellValue[] {
  return pkColumns.map(column => row[column] ?? null);
}

function usePkColumns(client: StudioClient, schema: string | undefined, table: string | undefined) {
  return useQuery({
    queryKey: ["detail", schema, table],
    queryFn: () => client.getTableDetail(schema!, table!),
    enabled: Boolean(schema && table),
    staleTime: Infinity,
  });
}

/**
 * Bidirectional FK drawer for one row.
 * - Outgoing FKs resolve to parent-row previews (PK + display column).
 * - Incoming FKs show exact count badges and paginated child rows.
 * Click-through re-centers the drawer; history/back lives in the parent.
 */
export function FKDrawer({ target, client, onNavigate, onClose, canGoBack, onBack }: FKDrawerProps) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [showInferred, setShowInferred] = useState(false);

  const outgoingQuery = useQuery({
    queryKey: ["outgoing", target.schema, target.table, JSON.stringify(target.pkValues)],
    queryFn: () => client.outgoingReferences(target.schema, target.table, target.pkValues),
  });
  const incomingQuery = useQuery({
    queryKey: ["incoming", target.schema, target.table, JSON.stringify(target.pkValues)],
    queryFn: () => client.incomingReferences(target.schema, target.table, target.pkValues),
  });
  // Opt-in heuristics: never fetched unless the user asks for them.
  const inferredQuery = useQuery({
    queryKey: ["inferred", target.schema, target.table],
    queryFn: () => client.getInferredRelations(target.schema, target.table),
    enabled: showInferred,
    staleTime: Infinity,
  });

  const outgoing: OutgoingReference[] = outgoingQuery.data?.outgoing ?? [];
  const groups: IncomingGroup[] = (incomingQuery.data?.groups ?? []).filter(g => g.totalCount > 0);
  const inferred: InferredRelation[] = showInferred ? (inferredQuery.data ?? []) : [];

  return (
    <aside aria-label="fk drawer" className="w-96 shrink-0 overflow-y-auto border-l border-border p-3 text-sm">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          {target.schema}.{target.table}
        </h2>
        <span className="text-xs text-muted-foreground">({target.pkValues.join(", ")})</span>
        <div className="ml-auto flex items-center gap-1">
          {canGoBack ? (
            <button
              type="button"
              aria-label="Back"
              onClick={onBack}
              className="rounded border border-border px-2 py-0.5 hover:bg-muted"
            >
              ← Back
            </button>
          ) : null}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              aria-label="Show inferred relationships"
              checked={showInferred}
              onChange={event => setShowInferred(event.target.checked)}
            />
            Inferred
          </label>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={onClose}
            className="rounded border border-border px-2 py-0.5 hover:bg-muted"
          >
            ✕
          </button>
        </div>
      </header>

      {outgoingQuery.isError || incomingQuery.isError ? (
        <p role="alert" className="text-danger">
          Failed to load references
        </p>
      ) : null}

      <section aria-label="references">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          References (outgoing)
        </h3>
        {outgoing.length === 0 && !outgoingQuery.isPending ? (
          <p className="text-muted-foreground">No foreign keys</p>
        ) : null}
        <ul>
          {outgoing.map(ref => (
            <li key={ref.constraintName} className="mb-1 rounded border border-border p-2">
              <div className="text-xs text-muted-foreground">{ref.constraintName}</div>
              {ref.preview ? (
                <button
                  type="button"
                  onClick={() =>
                    onNavigate({
                      schema: ref.parentSchema,
                      table: ref.parentTable,
                      pkValues: pkFromRow(ref.preview!.row, ref.parentColumns),
                    })
                  }
                  className="text-left font-medium underline-offset-2 hover:underline"
                >
                  {String(ref.preview.row[ref.preview.displayColumn])}{" "}
                  <span className="font-normal text-muted-foreground">
                    → {ref.parentSchema}.{ref.parentTable}
                  </span>
                </button>
              ) : (
                <span className="italic text-muted-foreground">NULL reference</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="referenced by" className="mt-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Referenced by
        </h3>
        {groups.length === 0 && !incomingQuery.isPending ? (
          <p className="text-muted-foreground">Nothing references this row</p>
        ) : null}
        <ul>
          {groups.map(group => {
            const key = `${group.childSchema}.${group.childTable}:${group.constraintName}`;
            const isOpen = expandedGroup === key;
            return (
              <li key={key} className="mb-1 rounded border border-border">
                <button
                  type="button"
                  onClick={() => setExpandedGroup(isOpen ? null : key)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between p-2 text-left hover:bg-muted"
                >
                  <span>
                    {group.childSchema}.{group.childTable}
                    <span className="ml-2 text-xs text-muted-foreground">
                      via {group.childColumns.join(", ")}
                    </span>
                  </span>
                  <span
                    aria-label={`${group.totalCount} referencing rows`}
                    className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground"
                  >
                    {group.totalCount}
                  </span>
                </button>
                {isOpen ? (
                  <GroupRows group={group} parentPkValues={target.pkValues} client={client} onNavigate={onNavigate} />
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="inferred relationships" className="mt-4">
        {showInferred ? (
          <>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Inferred relationships
            </h3>
            {inferred.length === 0 && !inferredQuery.isPending ? (
              <p className="text-muted-foreground">No name-based candidates</p>
            ) : null}
            <ul>
              {inferred.map(relation => (
                <li
                  key={relation.column}
                  className="mb-1 rounded border border-dashed border-border p-2 italic"
                >
                  {relation.column} → {relation.parentSchema}.{relation.parentTable}{" "}
                  <span aria-label={`${relation.confidence} confidence`} className="text-xs not-italic text-muted-foreground">
                    (inferred, {relation.confidence})
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </aside>
  );
}

function GroupRows({
  group,
  parentPkValues,
  client,
  onNavigate,
}: {
  group: IncomingGroup;
  parentPkValues: CellValue[];
  client: StudioClient;
  onNavigate: FKDrawerProps["onNavigate"];
}) {
  const detailQuery = usePkColumns(client, group.childSchema, group.childTable);
  const childPkColumns = detailQuery.data?.primaryKey ?? [];

  const [extraRows, setExtraRows] = useState<Row[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(group.nextOffset);
  const [loading, setLoading] = useState(false);
  const rows: Row[] = [...group.rows, ...extraRows];

  async function loadMore() {
    if (nextOffset === null) return;
    setLoading(true);
    try {
      const res = await client.incomingReferences(
        group.childSchema,
        group.childTable,
        parentPkValues,
        nextOffset,
        Math.max(group.rows.length, 10),
      );
      const match = res.groups.find(candidate => candidate.constraintName === group.constraintName);
      if (match) {
        setExtraRows(current => [...current, ...match.rows]);
        setNextOffset(match.nextOffset);
      } else {
        setNextOffset(null);
      }
    } finally {
      setLoading(false);
    }
  }

  if (childPkColumns.length === 0 && detailQuery.isPending) {
    return <div className="border-t border-border p-2 text-xs text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="border-t border-border p-2">
      <ul className="mb-1">
        {rows.map((row, index) => (
          <li key={index}>
            <button
              type="button"
              className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-muted"
              onClick={() =>
                onNavigate({
                  schema: group.childSchema,
                  table: group.childTable,
                  pkValues: pkFromRow(row, childPkColumns),
                })
              }
              title={Object.entries(row)
                .map(([k, v]) => `${k}=${v}`)
                .join(" · ")}
            >
              {Object.values(row)
                .map(v => String(v))
                .join(" · ")}
            </button>
          </li>
        ))}
      </ul>
      {nextOffset !== null ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
          className="text-xs text-primary hover:underline"
        >
          {loading ? "Loading…" : `Load more (${group.totalCount - rows.length} left)`}
        </button>
      ) : null}
    </div>
  );
}
