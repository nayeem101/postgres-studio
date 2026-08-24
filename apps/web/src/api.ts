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

export interface TableDetail {
  primaryKey: string[];
  columns: Array<{
    name: string;
    nullable: boolean;
    hasDefault: boolean;
    udtName: string;
    dataType: string;
  }>;
}

export type CellValue = string | number | boolean | null;

export interface SavePayload {
  updates: Array<{ pkValues: CellValue[]; set: Record<string, CellValue> }>;
  deletes: Array<{ pkValues: CellValue[] }>;
  inserts: Array<{ values: Record<string, CellValue> }>;
}

export interface SaveResult {
  batchId: string;
}

export interface OutgoingReference {
  constraintName: string;
  parentSchema: string;
  parentTable: string;
  parentColumns: string[];
  preview: { row: Row; displayColumn: string } | null;
}

export interface IncomingGroup {
  constraintName: string;
  childSchema: string;
  childTable: string;
  childColumns: string[];
  totalCount: number;
  rows: Row[];
  nextOffset: number | null;
}

/** Narrow surface the UI consumes — swap to a fake in component tests. */
export interface StudioClient {
  listTables(): Promise<TableMeta[]>;
  listRows(schema: string, table: string, query: RowsQuery): Promise<RowsPage>;
  getTableDetail(schema: string, table: string): Promise<TableDetail>;
  listEnums(): Promise<Array<{ name: string; values: string[] }>>;
  saveRows(schema: string, table: string, payload: SavePayload): Promise<SaveResult>;
  outgoingReferences(
    schema: string,
    table: string,
    pkValues: CellValue[],
  ): Promise<{ outgoing: OutgoingReference[] }>;
  incomingReferences(
    schema: string,
    table: string,
    pkValues: CellValue[],
    offset?: number,
    limit?: number,
  ): Promise<{ groups: IncomingGroup[] }>;
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
  async getTableDetail(schema, table) {
    const res = await api.api.schemas({ schema }).tables({ table }).get();
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return {
      primaryKey: res.data.primaryKey,
      columns: res.data.columns.map(c => ({
        name: c.name,
        nullable: c.nullable,
        hasDefault: c.hasDefault,
        udtName: c.udtName,
        dataType: c.dataType,
      })),
    };
  },
  async listEnums() {
    const res = await api.api.enums.get();
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return res.data.enums.map(e => ({ name: e.name, values: e.values }));
  },
  async saveRows(schema, table, payload) {
    const res = await api.api.schemas({ schema }).tables({ table }).save.post(payload);
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return { batchId: res.data.batchId };
  },
  async outgoingReferences(schema, table, pkValues) {
    const res = await api.api.schemas({ schema }).tables({ table }).references.outgoing.post({
      pkValues: [...pkValues],
    });
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return res.data;
  },
  async incomingReferences(schema, table, pkValues, offset = 0, limit = 10) {
    const res = await api.api.schemas({ schema }).tables({ table }).references.incoming.post({
      pkValues: [...pkValues],
      offset,
      limit,
    });
    if (res.error || !res.data) throw new Error(res.error ? String(res.error.status) : "empty response");
    return res.data;
  },
};
