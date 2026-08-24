import { treaty } from "@elysiajs/eden";
import type { App } from "@pg-studio/api";

/**
 * Typed client over the Elysia server. Same-origin in both dev (vite proxy)
 * and production (server serves the built SPA), so location.host is enough.
 */
export const api = treaty<App>(
  typeof window !== "undefined" && window.location?.host ? window.location.host : "localhost:3000",
);

export interface TableMeta {
  schema: string;
  name: string;
  kind: "table" | "view";
}

export type Row = Record<string, string | number | boolean | null>;

export interface RowsPage {
  rows: Row[];
  nextCursor: string | null;
}

export interface RowsQuery {
  limit?: string;
  cursor?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

/** Narrow surface the UI consumes — swap to a fake in component tests. */
export interface StudioClient {
  listTables(): Promise<TableMeta[]>;
  listRows(schema: string, table: string, query: RowsQuery): Promise<RowsPage>;
}

export const studioClient: StudioClient = {
  async listTables() {
    const { data, error } = await api.api.tables.get();
    if (error || !data) throw new Error(error ? String(error.status) : "empty response");
    return data.tables.map(t => ({ schema: t.schema, name: t.name, kind: t.kind }));
  },
  async listRows(schema, table, query) {
    const res = await api.api.schemas({ schema }).tables({ table }).rows.get({ query });
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return { rows: res.data.rows as Row[], nextCursor: res.data.nextCursor };
  },
};
