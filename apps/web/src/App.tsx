import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { DataGrid } from "./components/DataGrid";
import { DetailPanel } from "./components/DetailPanel";
import { FKDrawer, type DrawerTarget } from "./components/FKDrawer";
import { studioClient, type Row, type StudioClient } from "./api";

/** Hard cap so click-through can never recurse unbounded (Phase 2 guard). */
const MAX_DRAWER_DEPTH = 25;

export function App({ client = studioClient }: { client?: StudioClient }) {
  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [drawerStack, setDrawerStack] = useState<DrawerTarget[]>([]);

  function selectTable(selection: { schema: string; name: string }) {
    setSelected(selection);
    setDetailRow(null);
    setDrawerStack([]);
  }

  function navigateTo(target: DrawerTarget) {
    setDrawerStack(stack => {
      // Visited dedupe: returning to an earlier entry truncates forward
      // history (breadcrumb semantics) instead of growing the stack forever.
      const existingIndex = stack.findIndex(
        candidate =>
          candidate.schema === target.schema &&
          candidate.table === target.table &&
          JSON.stringify(candidate.pkValues) === JSON.stringify(target.pkValues),
      );
      if (existingIndex !== -1) return stack.slice(0, existingIndex + 1);
      const next = [...stack, target];
      return next.length > MAX_DRAWER_DEPTH ? next.slice(next.length - MAX_DRAWER_DEPTH) : next;
    });
    setDetailRow(null);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar client={client} selected={selected} onSelect={selectTable} />
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <div className="flex min-h-0 flex-1">
            <DataGrid
              key={`${selected.schema}.${selected.name}`}
              schema={selected.schema}
              table={selected.name}
              client={client}
              onRowSelect={setDetailRow}
              onOpenReferences={(row, pkValues) => {
                if (!selected) return;
                navigateTo({ schema: selected.schema, table: selected.name, pkValues });
              }}
            />
            {drawerStack.length > 0 ? (
              <FKDrawer
                target={drawerStack[drawerStack.length - 1]}
                client={client}
                onNavigate={navigateTo}
                onClose={() => setDrawerStack([])}
                canGoBack={drawerStack.length > 1}
                onBack={() => setDrawerStack(stack => stack.slice(0, -1))}
              />
            ) : detailRow ? (
              <DetailPanel
                schema={selected.schema}
                table={selected.name}
                row={detailRow}
                onClose={() => setDetailRow(null)}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select a table to browse its rows
          </div>
        )}
      </main>
    </div>
  );
}
