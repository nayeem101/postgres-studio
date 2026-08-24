import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServerApp, redactUrl } from "./server-app";

const databaseUrl = process.env.PG_STUDIO_DB_URL ?? process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Set PG_STUDIO_DB_URL (the database to browse) or TEST_DATABASE_URL before starting the server.",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);

// Serve the built SPA when it has been produced by `bun run build:web`.
const webDist = resolve(import.meta.dir, "../../web/dist");
const staticDir = existsSync(webDist) ? webDist : undefined;

const app = createServerApp({ databaseUrl, staticDir }).listen(port);

console.log(
  `@pg-studio/server listening on http://localhost:${port} -> ${redactUrl(databaseUrl)}${
    staticDir ? " (serving built SPA)" : ""
  }`,
);

export type App = typeof app;
