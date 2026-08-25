import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CellValue, Row } from "../api";
import type { StudioClient } from "../api";
import { AddRowForm } from "./AddRowForm";

const ROW_HEIGHT = 32;
/** When no real layout exists (tests / hidden mount), render a bounded window. */
const NO_LAYOUT_WINDOW = 40;
const SCROLL_THRESHOLD_PX = 200;

export interface SortState {
  column: string;
  dir: "asc" | "desc";
}

export interface DataGridProps {
  schema: string;
  table: string;
  client: StudioClient;
  pageSize?: number;
  /** Fires when the user clicks a row (row detail panel). */
  onRowSelect?: (row: Row) => void;
  /** Fires when the user opens the FK drawer for a row. */
  onOpenReferences?: (row: Row, pkValues: CellValue[]) => void;
  /** Opens the connection-wide history panel. */
  onOpenHistory?: () => void;
}

interface StagedUpdate {
  pkValues: CellValue[];
  set: Record<string, CellValue>;
}

function cellText(value: CellValue): string {
  if (value === null) return "NULL";
  return String(value);
}

/**
 * Virtualized grid fed by keyset pages. Only the visible DOM window mounts
 * rows regardless of how many pages were fetched. Edits/deletes are STAGED
 * locally and only sent by the explicit Save action (pending-changes model).
 */
export function DataGrid({
  schema,
  table,
  client,
  pageSize = 50,
  onRowSelect,
  onOpenReferences,
  onOpenHistory,
}: DataGridProps) {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const [hasLayout, setHasLayout] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [stagedUpdates, setStagedUpdates] = useState<Map<string, StagedUpdate>>(new Map());
  const [stagedDeletes, setStagedDeletes] = useState<Map<string, CellValue[]>>(new Map());
  const [stagedInserts, setStagedInserts] = useState<Array<Record<string, CellValue>>>([]);
  const [editing, setEditing] = useState<{ key: string; column: string; draft: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteImpact, setDeleteImpact] = useState<Array<{ childTable: string; total: number }> | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["detail", schema, table],
    queryFn: () => client.getTableDetail(schema, table),
  });
  const enumsQuery = useQuery({
    queryKey: ["enums"],
    queryFn: () => client.listEnums(),
    staleTime: Infinity,
  });

  const primaryKey = detailQuery.data?.primaryKey ?? [];
  const editable = primaryKey.length > 0;
  const nullableColumns = useMemo(
    () => new Set((detailQuery.data?.columns ?? []).filter(c => c.nullable).map(c => c.name)),
    [detailQuery.data],
  );

  const query = useInfiniteQuery({
    queryKey: ["rows", schema, table, sort?.column ?? null, sort?.dir ?? "asc", pageSize],
    queryFn: ({ pageParam }) =>
      client.listRows(schema, table, {
        limit: String(pageSize),
        ...(pageParam ? { cursor: pageParam } : {}),
        ...(sort ? { sort: sort.column, dir: sort.dir } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });

  const flatRows = useMemo(() => query.data?.pages.flatMap(page => page.rows) ?? [], [query.data]);

  const columns = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of flatRows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          names.push(key);
        }
      }
    }
    return names;
  }, [flatRows]);

  const needle = search.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    if (!needle) return flatRows;
    return flatRows.filter(row =>
      columns.some(column => String(row[column] ?? "").toLowerCase().includes(needle)),
    );
  }, [flatRows, columns, needle]);

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setHasLayout(element.clientHeight > ROW_HEIGHT * 2);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const nearEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - SCROLL_THRESHOLD_PX;
    if (nearEnd && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }

  function toggleSort(column: string) {
    setSort(current =>
      current?.column === column
        ? current.dir === "asc"
          ? { column, dir: "desc" }
          : null
        : { column, dir: "asc" },
    );
  }

  const pkOf = (row: Row): CellValue[] => primaryKey.map(column => row[column]);
  const keyOf = (row: Row): string => JSON.stringify(pkOf(row));

  function stageEdit(rowKey: string, row: Row, column: string, rawText: string) {
    const original = row[column];
    let value: CellValue;
    if (rawText === "" && nullableColumns.has(column)) value = null;
    else if (typeof original === "number" && rawText !== "" && !Number.isNaN(Number(rawText)))
      value = Number(rawText);
    else value = rawText;

    setStagedUpdates(current => {
      const next = new Map(current);
      const existing = next.get(rowKey);
      next.set(rowKey, {
        pkValues: existing?.pkValues ?? pkOf(row),
        set: { ...(existing?.set ?? {}), [column]: value },
      });
      return next;
    });
  }

  function toggleDelete(row: Row) {
    const key = keyOf(row);
    setStagedDeletes(current => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, pkOf(row));
      return next;
    });
  }

  async function onSave() {
    // Phase 3: deleting rows that other rows reference must be confirmed
    // with exact FK impact counts before anything is sent.
    if (stagedDeletes.size > 0 && !confirmOpen) {
      setConfirmOpen(true);
      const impact = new Map<string, number>();
      for (const pkValues of stagedDeletes.values()) {
        try {
          const res = await client.incomingReferences(schema, table, pkValues);
          for (const group of res.groups) {
            if (group.totalCount > 0) {
              impact.set(group.childTable, (impact.get(group.childTable) ?? 0) + group.totalCount);
            }
          }
        } catch {
          // Count lookup is advisory; the save itself remains guarded server-side.
        }
      }
      setDeleteImpact([...impact.entries()].map(([childTable, total]) => ({ childTable, total })));
      return;
    }
    await performSave();
  }

  async function performSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await client.saveRows(schema, table, {
        updates: [...stagedUpdates.values()],
        deletes: [...stagedDeletes.values()].map(pkValues => ({ pkValues })),
        inserts: stagedInserts.map(values => ({ values })),
      });
      setStagedUpdates(new Map());
      setStagedDeletes(new Map());
      setStagedInserts([]);
      setDeleteImpact(null);
      await query.refetch();
    } catch (error) {
      // Optimistic rollback: pending overlay stays; nothing is silently lost.
      setSaveError(`Save failed — pending changes kept. ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function discardAll() {
    setStagedUpdates(new Map());
    setStagedDeletes(new Map());
    setStagedInserts([]);
    setSaveError(null);
    setConfirmOpen(false);
    setDeleteImpact(null);
  }

  if (query.isPending) {
    return <div role="status">Loading rows…</div>;
  }
  if (query.isError) {
    return (
      <div role="alert" className="p-4 text-danger">
        Failed to load rows: {String(query.error.message)}
      </div>
    );
  }

  const virtualItems = hasLayout ? rowVirtualizer.getVirtualItems() : null;
  const boundedWindow =
    virtualItems ??
    visibleRows.slice(0, NO_LAYOUT_WINDOW).map((_, index) => ({
      index,
      start: index * ROW_HEIGHT,
      size: ROW_HEIGHT,
      key: index,
    }));
  const totalHeight = hasLayout
    ? rowVirtualizer.getTotalSize()
    : Math.min(visibleRows.length, NO_LAYOUT_WINDOW) * ROW_HEIGHT;

  const pendingCount = stagedUpdates.size + stagedDeletes.size + stagedInserts.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold">
          {schema}.{table}
        </h1>
        <input
          type="search"
          aria-label="Search rows"
          placeholder="Search loaded rows…"
          value={search}
          onChange={event => setSearch(event.target.value)}
          className="ml-auto w-64 rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
        />
        <span aria-live="polite" className="whitespace-nowrap text-xs text-muted-foreground">
          {visibleRows.length === flatRows.length
            ? `${flatRows.length} rows loaded`
            : `${visibleRows.length} of ${flatRows.length} rows`}
          {query.isFetching ? " · updating…" : ""}
        </span>
        {editable ? (
          <button
            type="button"
            aria-label="Add row"
            onClick={() => setShowAddForm(current => !current)}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            + Row
          </button>
        ) : null}
        {onOpenHistory ? (
          <button
            type="button"
            aria-label="Open history"
            onClick={onOpenHistory}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            History
          </button>
        ) : null}
      </div>

      {pendingCount > 0 || saveError ? (
        <div role="status" className="flex items-center gap-3 border-b border-border bg-muted px-3 py-1 text-sm">
          <span>
            Pending: {stagedUpdates.size} edit(s), {stagedDeletes.size} delete(s),{" "}
            {stagedInserts.length} insert(s)
          </span>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="rounded bg-primary px-3 py-0.5 text-primary-foreground disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={discardAll} className="rounded border border-border px-3 py-0.5">
            Discard
          </button>
          {saveError ? (
            <span role="alert" className="text-danger">
              {saveError}
            </span>
          ) : null}
        </div>
      ) : null}

      {confirmOpen ? (
        <div
          role="alertdialog"
          aria-label="Confirm delete"
          className="border-b border-border bg-muted px-3 py-2 text-sm"
        >
          <p className="font-medium">
            Delete {stagedDeletes.size} row(s) from {schema}.{table}?
          </p>
          {deleteImpact && deleteImpact.length > 0 ? (
            <ul className="mt-1 text-xs text-muted-foreground">
              {deleteImpact.map(entry => (
                <li key={entry.childTable}>
                  {entry.total} row(s) in <span className="font-semibold">{entry.childTable}</span> reference the
                  selection
                </li>
              ))}
            </ul>
          ) : deleteImpact ? (
            <p className="mt-1 text-xs text-muted-foreground">No loaded rows reference the selection.</p>
          ) : (
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              Counting referencing rows…
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              aria-label="Confirm deletes and save"
              disabled={saving || deleteImpact === null}
              onClick={() => {
                setConfirmOpen(false);
                void performSave();
              }}
              className="rounded bg-primary px-3 py-0.5 text-primary-foreground disabled:opacity-50"
            >
              Confirm &amp; save
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded border border-border px-3 py-0.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showAddForm && detailQuery.data ? (
        <AddRowForm
          detail={detailQuery.data}
          enums={enumsQuery.data ?? []}
          onStage={values => setStagedInserts(current => [...current, values])}
          onClose={() => setShowAddForm(false)}
        />
      ) : null}

      <div role="grid" aria-rowcount={visibleRows.length} className="min-h-0 flex-1">
        <div
          role="row"
          className="sticky top-0 z-10 flex border-b border-border bg-muted px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {columns.map(column => (
            <button
              key={column}
              type="button"
              role="columnheader"
              onClick={() => toggleSort(column)}
              aria-sort={
                sort?.column === column ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
              }
              className="flex-1 truncate px-2 py-1 text-left hover:text-foreground"
            >
              {column}
              {sort?.column === column ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
            </button>
          ))}
          {editable ? <span className="w-14 shrink-0" aria-hidden /> : null}
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto">
          <div style={{ height: totalHeight, position: "relative" }}>
            {boundedWindow.map(virtualRow => {
              const row: Row | undefined = visibleRows[virtualRow.index];
              if (!row) return null;
              const key = editable ? keyOf(row) : `${virtualRow.index}`;
              const isDeleted = stagedDeletes.has(key);
              const edited = stagedUpdates.get(key);
              return (
                <div
                  key={`${schema}.${table}-${virtualRow.key}`}
                  role="row"
                  tabIndex={onRowSelect ? 0 : undefined}
                  onClick={onRowSelect ? () => onRowSelect(row) : undefined}
                  onKeyDown={
                    onRowSelect
                      ? event => {
                          if (event.key === "Enter") onRowSelect(row);
                        }
                      : undefined
                  }
                  className={`absolute left-0 flex w-full border-b border-border px-2 text-sm hover:bg-muted ${
                    onRowSelect ? "cursor-pointer" : ""
                  } ${isDeleted ? "text-muted-foreground line-through opacity-60" : ""}`}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {columns.map(column => {
                    const isEditing =
                      editing?.key === key && editing.column === column && !isDeleted;
                    const staged = edited && column in edited.set ? edited.set[column] : undefined;
                    const display = staged !== undefined ? staged : row[column];
                    return (
                      <div
                        key={column}
                        role="gridcell"
                        title={cellText(display)}
                        onDoubleClick={
                          editable && !isDeleted
                            ? () => setEditing({ key, column, draft: cellText(display) })
                            : undefined
                        }
                        className={`flex-1 truncate px-2 leading-[30px] ${
                          display === null ? "italic text-muted-foreground" : ""
                        } ${staged !== undefined ? "font-semibold text-primary" : ""}`}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            aria-label={`edit ${column}`}
                            value={editing.draft}
                            onChange={event =>
                              setEditing({ ...editing, draft: event.target.value })
                            }
                            onKeyDown={event => {
                              if (event.key === "Enter") {
                                stageEdit(key, row, column, editing.draft);
                                setEditing(null);
                              } else if (event.key === "Escape") {
                                setEditing(null);
                              }
                            }}
                            onBlur={() => setEditing(null)}
                            className="w-full rounded border border-primary bg-background px-1"
                          />
                        ) : (
                          cellText(display)
                        )}
                      </div>
                    );
                  })}
                  {editable ? (
                    <span className="flex w-14 shrink-0 items-center justify-end gap-1">
                      {onOpenReferences ? (
                        <button
                          type="button"
                          aria-label={`References ${key}`}
                          title="Open FK references"
                          onClick={event => {
                            event.stopPropagation();
                            onOpenReferences(row, pkOf(row));
                          }}
                          className="text-center text-muted-foreground hover:text-primary"
                        >
                          ⛓
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Delete ${primaryKey.map(c => row[c]).join(",")}`}
                        onClick={event => {
                          event.stopPropagation();
                          toggleDelete(row);
                        }}
                        className="text-center text-muted-foreground hover:text-danger"
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
