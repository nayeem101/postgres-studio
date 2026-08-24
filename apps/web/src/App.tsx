import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { DataGrid } from "./components/DataGrid";
import { studioClient, type StudioClient } from "./api";

export function App({ client = studioClient }: { client?: StudioClient }) {
  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar client={client} selected={selected} onSelect={setSelected} />
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <DataGrid
            key={`${selected.schema}.${selected.name}`}
            schema={selected.schema}
            table={selected.name}
            client={client}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select a table to browse its rows
          </div>
        )}
      </main>
    </div>
  );
}
