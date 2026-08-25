# Postgres Studio

A local-first web studio for Postgres: browse any database like a spreadsheet,
inspect relationships in a bidirectional FK drawer, stage edits and save them
as one transaction, and roll any batch back from a local undo log.

No ORM, no agents-in-your-database: the server introspects `pg_catalog` live
and only ever issues parameterized SQL against identifiers it has validated.

## Features

- **Spreadsheet grid** — keyset-paginated rows (no `OFFSET` scans), column
  search over loaded rows, sort toggling, virtualized rendering.
- **Pending changes model** — edit cells, delete rows, add rows locally;
  nothing touches Postgres until you press **Save**, which applies everything
  in a single transaction.
- **Bidirectional FK drawer** — outgoing references resolve to parent-row
  previews; incoming references show exact count badges with paginated child
  rows; click-through navigation with breadcrumb back.
- **Rollback (History)** — every save writes before-images into a local
  `bun:sqlite` undo log *before* Postgres is touched. Failed writes are never
  restorable. Restore replays a batch in reverse inside one transaction.
- **Cascade-aware capture** — deleting a parent snapshots children that
  Postgres would cascade-delete or null out, so restore brings them back.
- **Delete confirmation** — shows per-table FK impact counts before commit.
- **Global search** — escaped `ILIKE` across all textual columns with exact
  pagination; click a hit to open that row.
- **Inferred relationships** (opt-in toggle) — name heuristics suggest
  references where no real FK exists (`delivery_address_id → addresses`).
- **Connection management** — switch databases at runtime; each connection
  gets its own isolated rollback store.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- A reachable Postgres instance (13+ recommended)
- Playwright's chromium only if you want the E2E suite: `bun run playwright:install`

## Quick start

```bash
bun install

# Configure environment (see .env.example):
#   TEST_DATABASE_URL – a disposable database used by tests AND, by default,
#                       as the database the server browses.
#   PG_STUDIO_DB_URL  – optional; the database to browse when you don't want
#                       to point the studio at the test database.
cp .env.example .env

# Create/refresh the demo fixture (self-FK, composite FK, cascade pair,
# multi-schema, enum, view) — refuses to run against DATABASE_URL.
bun run seed:test-db

# Run backend + frontend together (API on :3000, Vite on :5173 proxying /api)
bun run dev
```

Open <http://localhost:5173>, pick a table in the sidebar, double-click a cell
to edit, stage deletes with `✕`, open the drawer with `⛓`, then **Save**.

### Production mode

```bash
bun run build:web          # builds apps/web/dist
bun --hot apps/server/src/index.ts   # or without --hot for plain serving
```

The Elysia server serves both the API and the built SPA on
`http://localhost:3000` (`PORT` overrides).

### Connecting to your own database

Either set `PG_STUDIO_DB_URL` before starting the server, or paste a
`postgres://…` URL into the sidebar's **Connection** box at runtime — the
server swaps its connection live and keeps one rollback store per connection
under `~/.pg-studio/backups/<connection-id>.sqlite`.

> The v1 auth model is your Postgres role: whatever it can do, the studio can
> do. Keep it local / trusted-network.

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install workspace dependencies |
| `bun run dev` | Backend (:3000) + Vite dev server (:5173) |
| `bun run dev:server` / `dev:web` | Either half alone |
| `bun run seed:test-db` | Drop/recreate + seed `$TEST_DATABASE_URL` |
| `bun run test` | Unit + integration suites (needs Postgres running) |
| `bun run test:web` | React component tests (happy-dom, no Postgres) |
| `bun run test:e2e` | Playwright smoke test against a built app |
| `bun run typecheck` | All workspaces + tests, strict TS |
| `bun apps/server/src/prune-cli.ts [--max-age-days N] [--keep N] [--clear]` | Prune/clear rollback stores |

Integration/E2E tests target `$TEST_DATABASE_URL` exclusively — the seed
script hard-refuses when it detects that variable equals `DATABASE_URL`.

## Documentation

- [docs/architecture.md](docs/architecture.md) — **the codebase explained**:
  every file's job, where each feature lives, and the end-to-end flows.
- [docs/postgres-studio-feasibility-and-plan.md](docs/postgres-studio-feasibility-and-plan.md) — original design.
- [docs/progress.md](docs/progress.md) — task tracker with acceptance evidence.

## Repository layout

```
apps/server     Elysia HTTP server, CLI entrypoints, bun:sqlite rollback store
apps/web        React SPA (grid, drawer, history, search, connections)
packages/db     Postgres driver, catalog introspection, SQL compilers, pure helpers
packages/api    Eden Treaty type re-export (typeof app)
packages/config Shared tsconfig bases
tests           unit · integration · e2e · fixtures · component-test setup
```
