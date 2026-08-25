#!/usr/bin/env bun
/**
 * One-command launcher (prisma-studio style):
 *
 *   bun run studio [--port N] [--no-open] [postgres://…]
 *
 * Builds the SPA if it isn't built yet, then hands off to the server, which
 * serves UI + API and opens the browser. All flags are forwarded untouched.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const distIndex = resolve(repoRoot, "apps/web/dist/index.html");

if (!existsSync(distIndex)) {
  console.log("First run: building the web UI…");
  const build = Bun.spawnSync(["bun", "run", "build:web"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) {
    console.error("frontend build failed — fix the error above and retry");
    process.exit(build.exitCode ?? 1);
  }
}

// Flags/env are interpreted by ./index.ts; nothing is consumed here.
await import("./index");
