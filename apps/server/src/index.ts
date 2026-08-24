import { Elysia } from "elysia";
import { spikeApp } from "./spike-app";

const port = Number(process.env.PORT ?? 3000);

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .use(spikeApp)
  .listen(port);

console.log(`@pg-studio/server listening on http://localhost:${port}`);

export type App = typeof app;
