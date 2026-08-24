import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Row, StudioClient } from "../api";

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
}

function cellText(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  return String(value);
}

/**
 * Virtualized grid fed by keyset pages. Only the visible DOM window mounts
 * rows regardless of how many pages were fetched.
 */
export function DataGrid({ schema, table, client, pageSize = 50 }: DataGridProps) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const [hasLayout, setHasLayout] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      </div>

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
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto">
          <div style={{ height: totalHeight, position: "relative" }}>
            {boundedWindow.map(virtualRow => {
              const row: Row | undefined = visibleRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={`${schema}.${table}-${virtualRow.key}`}
                  role="row"
                  className="absolute left-0 flex w-full border-b border-border px-2 text-sm hover:bg-muted"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {columns.map(column => (
                    <div
                      key={column}
                      role="gridcell"
                      title={cellText(row[column])}
                      className={`flex-1 truncate px-2 leading-[30px] ${
                        row[column] === null ? "italic text-muted-foreground" : ""
                      }`}
                    >
                      {cellText(row[column])}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
