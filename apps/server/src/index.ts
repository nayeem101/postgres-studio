#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServerApp, redactUrl } from "./server-app";
import { openBrowser } from "./open";

interface ServerArgs {
  port?: number;
  url?: string;
  noOpen: boolean;
}

function parseArgs(argv: readonly string[]): ServerArgs {
  const args: ServerArgs = { noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i]);
    if (arg === "--no-open") args.noOpen = true;
    else if (arg === "--port" || arg === "-p" || arg.startsWith("--port=")) {
      const port = Number(value());
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`invalid --port value`);
        process.exit(2);
      }
      args.port = port;
    } else if (arg === "--url" || arg.startsWith("--url=")) {
      const url = value();
      if (!url) usage("missing value for --url");
      args.url = url;
    } else if (!arg.startsWith("-")) {
      // Positional connection string, prisma-studio style:
      //   pg-studio [postgres://user:pass@host:5432/db]
      args.url ??= arg;
    } else {
      usage(`unknown argument ${arg}`);
    }
  }
  return args;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: bun apps/server/src/index.ts [--port N] [--no-open] [--url postgres://… | <url>]",
  );
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));

const databaseUrl = args.url ?? process.env.PG_STUDIO_DB_URL ?? process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Set PG_STUDIO_DB_URL (the database to browse) or TEST_DATABASE_URL before starting the server.",
  );
  process.exit(1);
}

// Serve the built SPA when it has been produced by `bun run build:web`
// (`bun run studio` guarantees this before starting).
const webDist = resolve(import.meta.dir, "../../web/dist");
const staticDir = existsSync(webDist) ? webDist : undefined;

const port = args.port ?? Number(process.env.PORT ?? 3000);

let app: ReturnType<typeof createServerApp>;
try {
  app = createServerApp({ databaseUrl, staticDir }).listen(port);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    console.error(`port ${port} is already in use — pass --port or set PORT`);
    process.exit(1);
  }
  throw error;
}

const url = `http://localhost:${port}`;

console.log(
  `@pg-studio/server listening on ${url} -> ${redactUrl(databaseUrl)}${
    staticDir ? " (serving built SPA)" : " (API only — run `bun run build:web` for the UI)"
  }`,
);

export type App = typeof app;

// Prisma-studio behavior: one command opens the UI in your browser.
const autoOpen =
  Boolean(staticDir) &&
  !args.noOpen &&
  !process.env.CI &&
  !["1", "true"].includes((process.env.PG_STUDIO_NO_OPEN ?? "").toLowerCase());

if (autoOpen && url) openBrowser(url);
