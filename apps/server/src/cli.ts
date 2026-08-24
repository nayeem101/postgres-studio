#!/usr/bin/env bun
import { SQL } from "bun";
import { listColumns, listTables } from "@pg-studio/db";

interface CliArgs {
  url?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--url") {
      args.url = argv[++i];
      if (!args.url) usage("missing value for --url");
    } else if (arg?.startsWith("--url=")) {
      args.url = arg.slice("--url=".length);
    } else {
      usage(`unknown argument ${arg}`);
    }
  }
  return args;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error("usage: pg-studio-spike --url <postgres-url> [--json]");
  process.exit(2);
}

/** Redact the password before any string containing the URL can be printed. */
function redact(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

const { url, json } = parseArgs(process.argv.slice(2));
const target = url ?? process.env.TEST_DATABASE_URL;
if (!target) usage("--url is required when TEST_DATABASE_URL is not set");

if (!/^postgres(ql)?:\/\//.test(target)) {
  usage(`only postgres:// URLs are supported, got ${redact(target)}`);
}

console.error(`connecting to ${redact(target)} ...`);
const db = new SQL(target);
try {
  const tables = await listTables(db);
  if (json) {
    const payload = [];
    for (const table of tables) {
      payload.push({ ...table, columns: await listColumns(db, table.schema, table.name) });
    }
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const table of tables) {
      console.log(`${table.schema}.${table.name} (${table.kind})`);
      for (const column of await listColumns(db, table.schema, table.name)) {
        const flags = [
          column.nullable ? "NULL" : "NOT NULL",
          column.hasDefault ? `DEFAULT ${column.default ?? "(identity)"}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`  ${column.name.padEnd(24)} ${column.dataType}${flags ? ` ${flags}` : ""}`);
      }
    }
    console.error(`\n${tables.length} relation(s)`);
  }
} catch (error) {
  console.error(`failed: ${(error as Error).message}`);
  process.exit(1);
} finally {
  await db.close();
}
