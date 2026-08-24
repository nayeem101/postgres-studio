import { assertSafeIdent, quoteIdentifier } from "./identify";

/**
 * Mutation statement compilers (Phase 1 pending-save write path).
 * Pure functions: text assembly with allowlist-validated identifiers and
 * fully parameterized values. Execution happens through the caller's SQL
 * handle so transactions stay under server control.
 */

export interface CompiledQuery {
  text: string;
  params: unknown[];
}

export type CellValue = string | number | boolean | null;

function requireRelation(schema: string, table: string): void {
  assertSafeIdent(schema, "schema");
  assertSafeIdent(table, "table");
}

function requireColumn(column: string): string {
  return quoteIdentifier(assertSafeIdent(column, "column"));
}

function assertPk(pk: Record<string, CellValue>): void {
  const keys = Object.keys(pk);
  if (keys.length === 0) throw new Error("primary key values are required");
}

/** UPDATE … SET … WHERE pk = … */
export function compileUpdate(input: {
  schema: string;
  table: string;
  set: Record<string, CellValue>;
  pk: Record<string, CellValue>;
}): CompiledQuery {
  requireRelation(input.schema, input.table);
  assertPk(input.pk);
  const setKeys = Object.keys(input.set);
  if (setKeys.length === 0) throw new Error("update requires at least one SET column");

  const params: CellValue[] = [];
  const assignments = setKeys.map(column => {
    params.push(input.set[column]!);
    return `${requireColumn(column)} = $${params.length}`;
  });
  const predicate = Object.entries(input.pk).map(([column, value]) => {
    params.push(value!);
    return `${requireColumn(column)} = $${params.length}`;
  });

  const relation = `${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`;
  return {
    text: `update ${relation} set ${assignments.join(", ")} where ${predicate.join(" and ")}`,
    params,
  };
}

/** DELETE FROM … WHERE pk = … */
export function compileDelete(input: {
  schema: string;
  table: string;
  pk: Record<string, CellValue>;
}): CompiledQuery {
  requireRelation(input.schema, input.table);
  assertPk(input.pk);

  const params: CellValue[] = [];
  const predicate = Object.entries(input.pk).map(([column, value]) => {
    params.push(value!);
    return `${requireColumn(column)} = $${params.length}`;
  });

  const relation = `${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`;
  return {
    text: `delete from ${relation} where ${predicate.join(" and ")}`,
    params,
  };
}

/** INSERT INTO … (cols) VALUES (…) */
export function compileInsert(input: {
  schema: string;
  table: string;
  values: Record<string, CellValue>;
}): CompiledQuery {
  requireRelation(input.schema, input.table);
  const keys = Object.keys(input.values);
  if (keys.length === 0) throw new Error("insert requires at least one column");

  const params: CellValue[] = [];
  const parts = keys.map(column => {
    params.push(input.values[column]!);
    return { column: requireColumn(column), placeholder: `$${params.length}` };
  });
  const columns = parts.map(part => part.column);
  const placeholders = parts.map(part => part.placeholder).join(", ");

  const relation = `${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`;
  return {
    text: `insert into ${relation} (${columns.join(", ")}) values (${placeholders})`,
    params,
  };
}

/**
 * SELECT before-image rows for a list of PK tuples using one row-value IN
 * comparison: `where ("a","b") in (($1,$2),($3,$4))`. Single statement keeps
 * capture atomic with respect to concurrent edits between read and write.
 */
export function compileSelectByPkTuples(input: {
  schema: string;
  table: string;
  pkColumns: readonly string[];
  tuples: ReadonlyArray<readonly unknown[]>;
  /** Column subset to return; omit for *. */
  columns?: readonly string[];
}): CompiledQuery {
  requireRelation(input.schema, input.table);
  if (input.pkColumns.length === 0) throw new Error("pkColumns required");
  for (const c of input.pkColumns) assertSafeIdent(c, "pk column");
  if (input.tuples.length === 0) throw new Error("at least one pk tuple required");

  const width = input.pkColumns.length;
  const params: unknown[] = [];
  const rows = input.tuples.map(tuple => {
    if (tuple.length !== width) {
      throw new Error(`pk tuple arity mismatch: expected ${width}, got ${tuple.length}`);
    }
    const placeholders = tuple.map(value => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  const projection = input.columns ? input.columns.map(requireColumn).join(", ") : "*";
  const relation = `${quoteIdentifier(input.schema)}.${quoteIdentifier(input.table)}`;
  const keyTuple = `(${input.pkColumns.map(requireColumn).join(", ")})`;
  return {
    text: `select ${projection} from ${relation} where ${keyTuple} in (${rows.join(", ")})`,
    params,
  };
}
