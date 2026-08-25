import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { CellValue, StudioClient, TableMeta } from "../api";

interface SidebarProps {
  client: StudioClient;
  selected: { schema: string; name: string } | null;
  onSelect: (selection: { schema: string; name: string }) => void;
  /** Opens the FK drawer centered on a search hit. */
  onOpenRow?: (schema: string, table: string, pkValues: CellValue[]) => void;
}

export function Sidebar({ client, selected, onSelect, onOpenRow }: SidebarProps) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [newConnectionUrl, setNewConnectionUrl] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const tablesQuery = useQuery({
    queryKey: ["tables"],
    queryFn: () => client.listTables(),
  });

  const searchQuery_ = useQuery({
    queryKey: ["global-search", submittedQuery],
    queryFn: () => client.globalSearch(submittedQuery),
    enabled: submittedQuery.trim().length > 0,
  });

  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => client.listConnections(),
    staleTime: Infinity,
  });

  async function switchTo(target: { url?: string; connectionId?: string }) {
    setConnectionError(null);
    try {
      await client.switchConnection(target);
      // Every cached table/row/history result belongs to the OLD connection.
      queryClient.removeQueries({ predicate: query => query.queryKey[0] !== "connections" });
      await queryClient.refetchQueries({ queryKey: ["connections"] });
      await queryClient.refetchQueries({ queryKey: ["tables"] });
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  }

  function switchToUrlById(id: string) {
    void switchTo({ connectionId: id });
  }

  const grouped = useMemo(() => {
    const map = new Map<string, TableMeta[]>();
    for (const t of tablesQuery.data ?? []) {
      const list = map.get(t.schema) ?? [];
      list.push(t);
      map.set(t.schema, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tablesQuery.data]);

  if (tablesQuery.isPending) {
    return <nav aria-label="tables" className="w-56 shrink-0 border-r border-border p-3 text-sm text-muted-foreground">Loading tables…</nav>;
  }

  if (tablesQuery.isError) {
    return (
      <nav aria-label="tables" className="w-56 shrink-0 border-r border-border p-3 text-sm text-danger" role="alert">
        Failed to load tables
      </nav>
    );
  }

  return (
    <nav aria-label="tables" className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
      <form
        role="search"
        onSubmit={event => {
          event.preventDefault();
          setSubmittedQuery(searchQuery.trim());
        }}
        className="mb-3"
      >
        <input
          type="search"
          aria-label="Search all tables"
          placeholder="Search across tables…"
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
        />
      </form>
      {submittedQuery ? (
        <section aria-label="search results" className="mb-3">
          <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Results {searchQuery_.data ? `(${searchQuery_.data.total})` : ""}
          </h2>
          {searchQuery_.isPending ? (
            <p role="status" className="px-2 text-xs text-muted-foreground">Searching…</p>
          ) : searchQuery_.isError ? (
            <p role="alert" className="px-2 text-xs text-danger">Search failed</p>
          ) : (searchQuery_.data?.results ?? []).length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No matches</p>
          ) : (
            <ul>
              {(searchQuery_.data?.results ?? []).map(result => (
                <li key={`${result.schema}.${result.table}:${result.pkValues.join(",")}`}>
                  <button
                    type="button"
                    onClick={() => onOpenRow?.(result.schema, result.table, result.pkValues)}
                    className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                    title={`${result.schema}.${result.table} · ${result.matchedColumn}`}
                  >
                    <span className="font-medium">{result.table}</span>
                    <span className="ml-1 text-muted-foreground">{result.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {grouped.map(([schema, relations]) => (
        <section key={schema} className="mb-3">
          <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {schema}
          </h2>
          <ul>
            {relations.map(relation => {
              const isActive = selected?.schema === relation.schema && selected?.name === relation.name;
              return (
                <li key={`${relation.schema}.${relation.name}`}>
                  <button
                    type="button"
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelect({ schema: relation.schema, name: relation.name })}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                      isActive ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <span className="truncate">{relation.name}</span>
                    {relation.kind === "view" ? (
                      <span className="ml-2 shrink-0 text-[10px] uppercase text-muted-foreground">view</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section aria-label="connection" className="mt-4 border-t border-border pt-2">
        <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connection
        </h2>
        {connectionsQuery.data ? (
          <>
            <p className="px-2 pb-1 font-mono text-[10px] text-muted-foreground" title={connectionsQuery.data.current.url}>
              {connectionsQuery.data.current.url}
            </p>
            {connectionsQuery.data.recents.length > 1 ? (
              <select
                aria-label="Recent connections"
                value={connectionsQuery.data.current.id}
                onChange={event => void switchToUrlById(event.target.value)}
                className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-border bg-background px-1 py-0.5 text-xs"
              >
                {connectionsQuery.data.recents.map(recent => (
                  <option key={recent.id} value={recent.id}>
                    {recent.url}
                  </option>
                ))}
              </select>
            ) : null}
          </>
        ) : null}
        <form
          onSubmit={event => {
            event.preventDefault();
            const url = newConnectionUrl.trim();
            if (url) {
              setNewConnectionUrl("");
              void switchTo({ url });
            }
          }}
          className="flex gap-1 px-2"
        >
          <input
            aria-label="New connection URL"
            placeholder="postgres://…"
            value={newConnectionUrl}
            onChange={event => setNewConnectionUrl(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs outline-none focus:border-primary"
          />
          <button
            type="submit"
            aria-label="Connect"
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            Go
          </button>
        </form>
        {connectionError ? (
          <p role="alert" className="px-2 pt-1 text-xs text-danger">
            {connectionError}
          </p>
        ) : null}
      </section>
    </nav>
  );
}
