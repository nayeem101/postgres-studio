# Postgres Studio — agent contract

This repo is a local web Postgres data studio: Bun + Elysia backend, React SPA frontend, types shared via Eden Treaty. Read this file first. Do not maintain a separate `CLAUDE.md` with different content.

## Product

- Spreadsheet-like browsing of any Postgres database from a connection string (no ORM).
- Bidirectional FK drawer: outgoing references and incoming “referenced by” rows.
- Per-mutation local rollback via `bun:sqlite` before-image snapshots — not `pg_dump`.

Full design: [docs/postgres-studio-feasibility-and-plan.md](docs/postgres-studio-feasibility-and-plan.md). Work from [docs/progress.md](docs/progress.md) and [docs/agent-workflow.md](docs/agent-workflow.md). Skills: [docs/agent-skills.md](docs/agent-skills.md).

## Layout

| Path | Role |
|---|---|
| `apps/server` | Elysia HTTP, CLI, serves built SPA in production |
| `apps/web` | Vite + React SPA (grid, row detail, FK drawer, history) |
| `packages/api` | App type export for Eden Treaty (`typeof app`) |
| `packages/db` | Isolated Postgres driver + introspection + mutation SQL |
| `packages/config` | Shared TypeScript / tooling config |
| `tests/fixtures` | Seeded schemas (self-FK, composite FK, cascade) |
| `tests/integration` | End-to-end checks against `$TEST_DATABASE_URL` |

## Non-negotiables

1. **Parameterized SQL only.** Use `Bun.sql` tagged templates (or equivalent bound params). Never concatenate user/table identifiers without a catalog-validated allowlist.
2. **No ORM.** Introspect `pg_catalog` / `information_schema`. Driver lives only in `packages/db` so swapping `Bun.sql` → `postgres.js`/`pg` is a one-module change.
3. **Snapshot before mutation.** Every INSERT/UPDATE/DELETE that hits the target DB must write pending snapshots first, then mutate in a transaction, then confirm/fail the snapshot. Failed writes must not look restorable in History.
4. **Test DB for agents.** Use `$TEST_DATABASE_URL` only. Never run `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` against `$DATABASE_URL` without explicit human confirmation.
5. **Identifier quoting.** Table/column/schema names come from catalogs, then quoted (`"schema"."table"`). Do not interpolate unvalidated names into SQL.
6. **Do not mark a task done** because code was generated. Update [docs/progress.md](docs/progress.md) only with evidence (command + outcome). Phase 3 write-path tasks need human verification.

## Stack reminders

- Backend: Elysia on `Bun.serve()`, TypeBox schemas on routes, Eden Treaty on the web client.
- Frontend: React + Vite + TanStack Table/Query/Virtual + Tailwind. Pending-changes-then-save (Prisma Studio model), not auto-commit per cell.
- Rollback store: one SQLite file per connection under `~/.pg-studio/backups/<connection-id>.sqlite` (`batches` + `snapshots`). Cascade-aware capture; restore in topological order inside one Postgres transaction per batch.
- v1 auth is the Postgres role. No app user accounts.

## How to work

1. Pick the next unchecked task in `docs/progress.md`.
2. Load the matching skills (Postgres/Bun/Elysia before Phase 0; TanStack when UI packages exist; `code-review` before calling Phase 3 done).
3. Smallest slice that can be verified.
4. Run focused tests. Update the tracker. Stop for human review at write-path safety gates.
