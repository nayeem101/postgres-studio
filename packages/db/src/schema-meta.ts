import type { SQL } from "bun";


/**
 * Deeper catalog metadata (Phase 1): primary keys, unique constraints,
 * indexes, and enum types. Full-catalog listings; callers filter.
 * All fragments are built fresh per call; no caller input is interpolated.
 */

export interface PrimaryKeyMeta {
  schema: string;
  table: string;
  /** Columns in key ordinal order — matters for composite PKs. */
  columns: string[];
}

export interface UniqueConstraintMeta {
  schema: string;
  table: string;
  name: string;
  columns: string[];
}

export interface IndexMeta {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  isUnique: boolean;
  isPartial: boolean;
}

export interface EnumMeta {
  schema: string;
  name: string;
  values: string[];
}

/** Primary keys across all schemas; composite keys keep column order. */
export async function listPrimaryKeys(db: SQL): Promise<PrimaryKeyMeta[]> {
  const rows = await db`
    select
      ns.nspname                                      as schema,
      tbl.relname                                     as table,
      array_agg(col.attname order by keys.ord)        as columns
    from pg_index i
    join pg_class tbl on tbl.oid = i.indrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    cross join lateral unnest(i.indkey) with ordinality as keys(attnum, ord)
    join pg_attribute col
      on col.attrelid = i.indrelid and col.attnum = keys.attnum
    where i.indisprimary
      and ns.nspname not in ('pg_catalog', 'information_schema')
    group by ns.nspname, tbl.relname, tbl.oid
    order by ns.nspname, tbl.relname
  `;
  return rows.map(r => ({
    schema: r.schema as string,
    table: r.table as string,
    columns: r.columns as string[],
  }));
}

/** UNIQUE constraints (not merely unique indexes) across all schemas. */
export async function listUniqueConstraints(db: SQL): Promise<UniqueConstraintMeta[]> {
  const rows = await db`
    select
      con.conname                                     as name,
      ns.nspname                                      as schema,
      tbl.relname                                     as table,
      array_agg(col.attname order by keys.ord)        as columns
    from pg_constraint con
    join pg_class tbl on tbl.oid = con.conrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    cross join lateral unnest(con.conkey) with ordinality as keys(attnum, ord)
    join pg_attribute col
      on col.attrelid = con.conrelid and col.attnum = keys.attnum
    where con.contype = 'u'
      and ns.nspname not in ('pg_catalog', 'information_schema')
    group by con.conname, ns.nspname, tbl.relname, tbl.oid
    order by ns.nspname, tbl.relname, con.conname
  `;
  return rows.map(r => ({
    schema: r.schema as string,
    table: r.table as string,
    name: r.name as string,
    columns: r.columns as string[],
  }));
}

/** All indexes (including PK/unique backing indexes) across user schemas. */
export async function listIndexes(db: SQL): Promise<IndexMeta[]> {
  const rows = await db`
    select
      idx_ns.nspname                                  as schema,
      tbl.relname                                     as table,
      idx.relname                                     as name,
      i.indisunique                                   as "isUnique",
      (i.indpred is not null)                         as "isPartial",
      array_agg(col.attname order by keys.ord)        as columns
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_namespace idx_ns on idx_ns.oid = idx.relnamespace
    join pg_class tbl on tbl.oid = i.indrelid
    cross join lateral unnest(i.indkey) with ordinality as keys(attnum, ord)
    join pg_attribute col
      on col.attrelid = i.indrelid and col.attnum = keys.attnum
    where idx_ns.nspname not in ('pg_catalog', 'information_schema')
    group by idx_ns.nspname, tbl.relname, idx.relname, i.indisunique, i.indpred, idx.oid
    order by idx_ns.nspname, tbl.relname, idx.relname
  `;
  return rows.map(r => ({
    schema: r.schema as string,
    table: r.table as string,
    name: r.name as string,
    columns: r.columns as string[],
    isUnique: r.isUnique === true,
    isPartial: r.isPartial === true,
  }));
}

/** Enum types with values in declaration order. */
export async function listEnums(db: SQL): Promise<EnumMeta[]> {
  const rows = await db`
    select
      n.nspname                                       as schema,
      t.typname                                       as name,
      array_agg(e.enumlabel order by e.enumsortorder) as values
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where t.typtype = 'e'
      and n.nspname not in ('pg_catalog', 'information_schema')
    group by n.nspname, t.typname, t.oid
    order by n.nspname, t.typname
  `;
  return rows.map(r => ({
    schema: r.schema as string,
    name: r.name as string,
    values: r.values as string[],
  }));
}
