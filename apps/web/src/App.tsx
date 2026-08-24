import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { DataGrid } from "./components/DataGrid";
import { DetailPanel } from "./components/DetailPanel";
import { studioClient, type Row, type StudioClient } from "./api";

export function App({ client = studioClient }: { client?: StudioClient }) {
  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);
  const [detailRow, setDetailRow] = useState<Row | null>(null);

  function selectTable(selection: { schema: string; name: string }) {
    setSelected(selection);
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
            />
            {detailRow ? (
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
