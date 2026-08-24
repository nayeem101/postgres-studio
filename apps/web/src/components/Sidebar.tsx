import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { StudioClient, TableMeta } from "../api";

interface SidebarProps {
  client: StudioClient;
  selected: { schema: string; name: string } | null;
  onSelect: (selection: { schema: string; name: string }) => void;
}

export function Sidebar({ client, selected, onSelect }: SidebarProps) {
  const tablesQuery = useQuery({
    queryKey: ["tables"],
    queryFn: () => client.listTables(),
  });

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
    </nav>
  );
}
