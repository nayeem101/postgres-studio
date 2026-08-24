# Postgres Studio

Local web Postgres data studio: spreadsheet browsing, bidirectional FK drawer, per-edit rollback. See [docs/postgres-studio-feasibility-and-plan.md](docs/postgres-studio-feasibility-and-plan.md).

## Status

Bootstrap only. Track work in [docs/progress.md](docs/progress.md). Agent loop: [docs/agent-workflow.md](docs/agent-workflow.md).

## Layout

```
apps/server     Elysia + CLI + bun:sqlite rollback
apps/web        Vite React SPA
packages/api    Eden Treaty app types
packages/db     Bun.sql + introspection
packages/config shared tsconfig
tests/fixtures  seeded Postgres (self-FK, composite FK, cascade)
```

## Commands (after Phase 0)

```
bun install
cp .env.example .env   # set TEST_DATABASE_URL
bun run dev
bun test
bun run seed:test-db
```

Agents use `$TEST_DATABASE_URL` only.

## Agents

Root [`AGENTS.md`](AGENTS.md) is the source of truth for Cursor, VS Code Copilot, and OpenCode. Do not add a divergent `CLAUDE.md`.
