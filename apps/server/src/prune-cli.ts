#!/usr/bin/env bun
/**
 * Retention CLI (Phase 3): prune or clear the local rollback store.
 *
 *   bun apps/server/src/prune-cli.ts --max-age-days 30 --keep 100
 *   bun apps/server/src/prune-cli.ts --clear --connection <connection-id>
 *
 * Only touches ~/.pg-studio/backups/<connection-id>.sqlite files — never the
 * Postgres database itself.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "./backup";

interface PruneArgs {
  maxAgeDays?: number;
  keep?: number;
  clear: boolean;
  connection?: string;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: bun apps/server/src/prune-cli.ts [--max-age-days N] [--keep N] [--clear] [--connection <id>]",
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): PruneArgs {
  const args: PruneArgs = { clear: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = arg!.includes("=") ? arg!.split("=")[1] : argv[++i];
      if (next === undefined) usage(`missing value for ${arg}`);
      return next;
    };
    if (arg === "--max-age-days") args.maxAgeDays = Number(value());
    else if (arg === "--keep") args.keep = Number(value());
    else if (arg === "--clear") args.clear = true;
    else if (arg === "--connection") args.connection = value();
    else if (arg?.startsWith("--")) usage(`unknown argument ${arg}`);
  }
  if (!args.clear && args.maxAgeDays === undefined && args.keep === undefined) {
    usage("nothing to do: pass --max-age-days, --keep, or --clear");
  }
  if (args.maxAgeDays !== undefined && (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays <= 0)) {
    usage("--max-age-days must be a positive number");
  }
  if (args.keep !== undefined && (!Number.isFinite(args.keep) || args.keep < 0)) {
    usage("--keep must be >= 0");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const backupsDir = join(homedir(), ".pg-studio", "backups");
let files: string[];
try {
  files = readdirSync(backupsDir).filter(f => f.endsWith(".sqlite"));
} catch {
  console.log("no rollback store directory; nothing to prune");
  process.exit(0);
}

const scoped = args.connection ? files.filter(f => f === `${args.connection}.sqlite`) : files;
if (scoped.length === 0) {
  console.log("no matching store files");
  process.exit(0);
}

let totalRemoved = 0;
for (const file of scoped) {
  const connectionId = file.replace(/\.sqlite$/, "");
  const store = BackupStore.open(join(backupsDir, file));
  try {
    store.init();
    const removed = args.clear
      ? store.clearAll(connectionId)
      : store.prune({
          ...(args.maxAgeDays !== undefined ? { maxAgeDays: args.maxAgeDays } : {}),
          ...(args.keep !== undefined ? { maxBatches: args.keep } : {}),
          connectionId,
        });
    totalRemoved += removed;
    console.log(`${connectionId}: removed ${removed} batch(es)`);
  } finally {
    store.close();
  }
}
console.log(`done — ${totalRemoved} batch(es) pruned`);

