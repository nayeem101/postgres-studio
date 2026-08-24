import { SQL, sql } from "bun";
import { quoteIdentifier } from "./identify";
import { normalizeColumn, normalizeTable, type ColumnMeta, type TableMeta } from "./normalize";

/**
 * Catalog introspection (Phase 0). All user-controlled strings are bound
 * parameters; identifiers are only ever interpolated after quoteIdentifier.
 */

/** List user tables and views across all non-system schemas. */
export async function listTables(db: SQL): Promise<TableMeta[]> {
  const rows = await db`
    select t.table_schema as schema,
           t.table_name   as name,
           case t.table_type
             when 'BASE TABLE' then 'table'
             when 'VIEW' then 'view'
             else t.table_type::text
           end as kind
    from information_schema.tables t
    where t.table_schema not in ${sql(["pg_catalog", "information_schema"])}
      and t.table_schema not like ${"pg\\_temp%"} escape '\\'
      and t.table_schema not like ${"pg\\_toast%"} escape '\\'
    order by t.table_schema, t.table_name
  `;
  return rows.map(normalizeTable);
}

/** Columns of one relation, in ordinal order. */
export async function listColumns(db: SQL, schema: string, table: string): Promise<ColumnMeta[]> {
  // Defense-in-depth: these are bind parameters below, but validate anyway so
  // misuse throws before reaching Postgres.
  quoteIdentifier(schema);
  quoteIdentifier(table);
  const rows = await db`
    select c.column_name       as name,
           c.table_schema      as schema,
           c.table_name        as "table",
           c.ordinal_position  as position,
           c.data_type         as "dataType",
           c.udt_name          as "udtName",
           c.is_nullable       as nullable,
           (c.column_default is not null or c.is_identity = 'YES') as "hasDefault",
           c.column_default    as "default"
    from information_schema.columns c
    where c.table_schema = ${schema}
      and c.table_name = ${table}
    order by c.ordinal_position
  `;
  return rows.map(normalizeColumn);
}
