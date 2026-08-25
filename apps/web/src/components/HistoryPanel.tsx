import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CellRecord, StudioClient } from "../api";

/**
 * History panel (Phase 3): confirmed batches with before/after diffs and
 * one-click rollback. Restoring a batch is a single Postgres transaction
 * server-side; failed batches never appear here (server-filtered).
 */
export function HistoryPanel({ client, onClose }: { client: StudioClient; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const batchesQuery = useQuery({
    queryKey: ["history"],
    queryFn: () => client.listHistory(),
  });

  const snapshotsQuery = useQuery({
    queryKey: ["history", selectedBatch],
    queryFn: () => client.getBatchSnapshots(selectedBatch!),
    enabled: selectedBatch !== null,
  });

  const restoreMutation = useMutation({
    mutationFn: (batchId: string) => client.restoreBatch(batchId),
    onSuccess: result => {
      setNotice(
        `Restored ${result.restoredDeletes} delete(s), ${result.restoredInserts} insert(s), ${result.restoredUpdates} update(s).`,
      );
      setSelectedBatch(null);
      void queryClient.invalidateQueries({ queryKey: ["history"] });
      void queryClient.invalidateQueries({ queryKey: ["rows"] });
    },
    onError: error => setNotice(`Restore failed: ${(error as Error).message}`),
  });

  return (
    <aside aria-label="history panel" className="w-96 shrink-0 overflow-y-auto border-l border-border p-3 text-sm">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">History</h2>
        <button
          type="button"
          aria-label="Close history"
          onClick={onClose}
          className="ml-auto rounded border border-border px-2 py-0.5 hover:bg-muted"
        >
          ✕
        </button>
      </header>

      {notice ? (
        <p role="status" className="mb-2 rounded border border-border p-2 text-xs">
          {notice}
        </p>
      ) : null}

      {batchesQuery.isPending ? (
        <p role="status">Loading batches…</p>
      ) : batchesQuery.isError ? (
        <p role="alert" className="text-danger">
          Failed to load history
        </p>
      ) : (batchesQuery.data ?? []).length === 0 ? (
        <p className="text-muted-foreground">No restorable changes yet.</p>
      ) : (
        <ul>
          {(batchesQuery.data ?? []).map(batch => (
            <li key={batch.id} className="mb-1 rounded border border-border">
              <button
                type="button"
                onClick={() => setSelectedBatch(selectedBatch === batch.id ? null : batch.id)}
                aria-expanded={selectedBatch === batch.id}
                className="flex w-full items-center justify-between p-2 text-left hover:bg-muted"
              >
                <span className="truncate">
                  {batch.description ?? "changes"}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {new Date(batch.createdAt).toLocaleTimeString()}
                  </span>
                </span>
              </button>
              {selectedBatch === batch.id ? (
                <div className="border-t border-border p-2">
                  <SnapshotDiff snapshots={snapshotsQuery.data?.snapshots ?? []} />
                  <button
                    type="button"
                    disabled={restoreMutation.isPending}
                    aria-label={`Restore batch ${batch.id}`}
                    onClick={() => restoreMutation.mutate(batch.id)}
                    className="mt-2 w-full rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
                  >
                    {restoreMutation.isPending ? "Restoring…" : "Restore batch"}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function SnapshotDiff({ snapshots }: { snapshots: Array<import("../api").SnapshotView> }) {
  if (snapshots.length === 0) return <p role="status">Loading snapshot…</p>;
  return (
    <ul className="text-xs">
      {snapshots.map(snapshot => {
        const changedColumns = diffColumns(snapshot.beforeImage, snapshot.afterImage);
        return (
          <li key={snapshot.id} className="mb-1 rounded bg-muted p-1">
            <span className="font-semibold uppercase">{snapshot.operation}</span>{" "}
            {snapshot.schema}.{snapshot.table}
            <span className="ml-1 text-muted-foreground">
              ({snapshot.pkValues.length > 0 ? snapshot.pkValues.join(", ") : "generated"})
            </span>
            {changedColumns.length > 0 ? (
              <div className="ml-2 text-muted-foreground">
                {changedColumns.map(column => (
                  <div key={column}>
                    {column}: {String(snapshot.beforeImage?.[column] ?? "∅")} →{" "}
                    {String(snapshot.afterImage?.[column] ?? "∅")}
                  </div>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function diffColumns(before: CellRecord | null, after: CellRecord | null): string[] {
  if (!before || !after) return [];
  return Object.keys(before).filter(
    column =>
      column in after &&
      JSON.stringify(before[column]) !== JSON.stringify(after[column]),
  );
}
