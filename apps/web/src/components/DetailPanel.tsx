import type { Row } from "../api";

export interface DetailPanelProps {
  schema: string;
  table: string;
  row: Row;
  onClose: () => void;
}

/** Shows every column of the selected row, in stored order. */
export function DetailPanel({ schema, table, row, onClose }: DetailPanelProps) {
  const entries = Object.entries(row);

  return (
    <aside aria-label="row detail" className="w-80 shrink-0 overflow-y-auto border-l border-border">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">
          {schema}.{table}
        </h2>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </header>
      <dl className="p-3 text-sm">
        {entries.map(([column, value]) => (
          <div key={column} className="mb-2 grid grid-cols-[38%_62%] gap-2">
            <dt className="truncate font-medium text-muted-foreground" title={column}>
              {column}
            </dt>
            <dd className={value === null ? "italic text-muted-foreground" : "break-words"}>
              {value === null ? "NULL" : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
