import { type SQL, sql } from "bun";
import { quoteIdentifier } from "./identify";
import { normalizeFk, type FkConstraintMeta } from "./normalize";

/**
 * Foreign-key introspection in both directions (Phase 0 spike for the
 * bidirectional drawer). Constraint metadata comes from pg_constraint;
 * every caller-supplied value is a bind parameter.
 */

/** Fresh fragment per call so prepared-statement caching never shares state. */
function fkSelect() {
  return sql`
    select
      con.conname                                                    as name,
      child_ns.nspname                                               as "childSchema",
      child_tbl.relname                                              as "childTable",
      array_agg(child_col.attname order by child_keys.ord)           as "childColumns",
      parent_ns.nspname                                              as "parentSchema",
      parent_tbl.relname                                             as "parentTable",
      array_agg(parent_col.attname order by parent_keys.ord)         as "parentColumns",
      con.confdeltype::text                                          as "onDelete",
      con.confupdtype::text                                          as "onUpdate"
    from pg_constraint con
    join pg_class child_tbl on child_tbl.oid = con.conrelid
    join pg_namespace child_ns on child_ns.oid = child_tbl.relnamespace
    join pg_class parent_tbl on parent_tbl.oid = con.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent_tbl.relnamespace
    -- pair child/parent key columns positionally so composite FKs align
    cross join lateral unnest(con.conkey) with ordinality as child_keys(attnum, ord)
    join lateral unnest(con.confkey) with ordinality as parent_keys(attnum, ord)
      on parent_keys.ord = child_keys.ord
    join pg_attribute child_col
      on child_col.attrelid = con.conrelid and child_col.attnum = child_keys.attnum
    join pg_attribute parent_col
      on parent_col.attrelid = con.confrelid and parent_col.attnum = parent_keys.attnum
    where con.contype = 'f'
  `;
}

const groupBy = () => sql`
  group by con.conname, child_ns.nspname, child_tbl.relname,
           parent_ns.nspname, parent_tbl.relname, con.confdeltype, con.confupdtype
  order by con.conname
`;

function assertRelation(schema: string, table: string): void {
  // Bound parameters below already prevent injection; validation surfaces
  // misuse earlier with clearer errors.
  quoteIdentifier(schema);
  quoteIdentifier(table);
}

/** FKs declared on `schema.table` pointing away from it (its references). */
export async function listOutgoingFks(db: SQL, schema: string, table: string): Promise<FkConstraintMeta[]> {
  assertRelation(schema, table);
  const rows = await db`${fkSelect()}
    and child_ns.nspname = ${schema}
    and child_tbl.relname = ${table}
    ${groupBy()}`;
  return rows.map(normalizeFk);
}

/** FKs declared elsewhere referencing `schema.table` ("referenced by"). */
export async function listIncomingFks(db: SQL, schema: string, table: string): Promise<FkConstraintMeta[]> {
  assertRelation(schema, table);
  const rows = await db`${fkSelect()}
    and parent_ns.nspname = ${schema}
    and parent_tbl.relname = ${table}
    ${groupBy()}`;
  return rows.map(normalizeFk);
}

/** Both directions in one call. */
export async function listTableFks(
  db: SQL,
  schema: string,
  table: string,
): Promise<{ outgoing: FkConstraintMeta[]; incoming: FkConstraintMeta[] }> {
  const [outgoing, incoming] = await Promise.all([
    listOutgoingFks(db, schema, table),
    listIncomingFks(db, schema, table),
  ]);
  return { outgoing, incoming };
}
