import { createServerApp, redactUrl } from "./server-app";

const databaseUrl = process.env.PG_STUDIO_DB_URL ?? process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Set PG_STUDIO_DB_URL (the database to browse) or TEST_DATABASE_URL before starting the server.",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);

const app = createServerApp({ databaseUrl }).listen(port);

console.log(`@pg-studio/server listening on http://localhost:${port} -> ${redactUrl(databaseUrl)}`);

export type App = typeof app;
