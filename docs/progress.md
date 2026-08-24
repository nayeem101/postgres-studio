# Progress tracker

Source: [postgres-studio-feasibility-and-plan.md](postgres-studio-feasibility-and-plan.md) §§6–7a. Update this file when a task is actually verified ([agent-workflow.md](agent-workflow.md)).

**Status:** Bootstrap complete. Phase 0 in progress (test foundation done).

| Phase | Status |
|---|---|
| Bootstrap (skills, rules, workflow, monorepo) | done |
| Phase 0 — Spike | not started |
| Phase 1 — Core browsing | not started |
| Phase 2 — Bidirectional FK panel | not started |
| Phase 3 — Write-path safety | not started |
| Phase 4 — Distribution | not started |

---

## Bootstrap

- [x] Shared `AGENTS.md` + Cursor rules + Copilot/OpenCode/VS Code wrappers  
  **Done:** 2026-08-24  
  **Evidence:** files present: `AGENTS.md`, `.cursor/rules/{safety,backend,frontend}.mdc`, `.github/copilot-instructions.md`, `opencode.json`, `.vscode/tasks.json`  
  **Notes:** MCP configs omitted until a test-only URL exists.

- [x] Project-local skills installed and catalogued  
  **Done:** 2026-08-24  
  **Evidence:** `bunx skills list` shows Postgres, Elysia, code-review, React, Tailwind, and selected Bun skills; `skills-lock.json` committed  
  **Notes:** `oven-sh/bun` contributor skills skipped. Tailwind skill is `tailwind-theme-builder` (jezweb). TanStack intent deferred until packages are installed.

- [x] Agentic workflow + this tracker  
  **Done:** 2026-08-24  
  **Evidence:** `docs/agent-workflow.md`, `docs/progress.md`, `docs/agent-skills.md`

- [x] Monorepo layout (`apps/*`, `packages/*`, `tests/*`)  
  **Done:** 2026-08-24  
  **Evidence:** workspace `package.json` + placeholder packages; `bun install` run during bootstrap if Bun is available  
  **Notes:** No Phase 0 CLI/introspection behavior yet.

---

## Phase 0 — Spike

- [ ] CLI accepts `--url`, connects with `Bun.sql`, dumps table list + columns from `information_schema`  
  **Acceptance:** printed tables/columns for `$TEST_DATABASE_URL`  
  **Verify:** `bun run --filter @pg-studio/server spike -- --url "$TEST_DATABASE_URL"` (or the CLI name chosen in the spike)

- [ ] FK query both directions on seeded DB (self-FK + composite FK)  
  **Acceptance:** outgoing + incoming rows match seed  
  **Verify:** script or test against `tests/fixtures` seed

- [ ] Minimal Elysia app: schema validation on one endpoint, hot reload, path params, TypeBox errors  
  **Acceptance:** invalid body returns validation error; valid body 200

- [ ] Eden Treaty throwaway client fetch against that endpoint  
  **Acceptance:** typed client compiles and round-trips

### Phase 0 test foundation

- [x] Unit test foundation for deterministic SQL and metadata logic  
  **Done:** 2026-08-24  
  **Evidence:** `bun test tests/unit` → 65 pass / 0 fail; `bun run typecheck` → all 4 packages exit 0 (db/api upgraded from `bun build` to real `tsc --noEmit`)  
  **Notes:** `packages/db` pure modules: `identify.ts` (strict allowlist + catalog-name quoting), `cursor.ts` (keyset codec), `normalize.ts` (catalog-row normalization, FK column-count invariant), `fk-graph.ts` (visited/depth-capped traversal, restore topological order with cycle fallback). No database access in these tests.

- [x] Integration test fixture and real Postgres test harness  
  **Done:** 2026-08-24  
  **Evidence:** `bun test tests/integration` → 6 pass / 0 fail against `postgres://…@localhost:5432/pg_studio_test` (docker `postgres:16-alpine`); `bun run seed:test-db` reseeds and redacts the URL  
  **Notes:** seed covers self-FK (`employees.manager_id`), composite PK/FK (`orders`↔`order_items`), cascade (`customers`↔`addresses`). Harness asserts FK reads, orphan-insert rejection, cascade delete. Root `seed:test-db` script runs from repo root so Bun loads root `.env` (`--filter` changes cwd). Seed refuses to run when `TEST_DATABASE_URL === DATABASE_URL`.

---

## Phase 1 — Core browsing

- [ ] Elysia app + Vite SPA scaffold; localhost launch; Bun can serve built SPA  
  **Acceptance:** `bun run dev` opens UI against local API

- [ ] TypeBox schemas for table list, column metadata, row payloads (drive Eden Treaty)  
  **Acceptance:** `packages/api` exports `typeof app`; web imports Treaty types

- [ ] Schema introspection: tables, views, columns, types, PK/FK/unique/index, enums, multi-schema  
  **Acceptance:** non-`public` schema appears; enums listed

- [ ] Sidebar table/view list  
  **Acceptance:** click selects table and loads grid

- [ ] Virtualized grid, column sort/filter/search, keyset pagination  
  **Acceptance:** large table does not mount all rows; next page uses keyset not `OFFSET`

- [ ] Row detail panel  
  **Acceptance:** selected row shows all columns

- [ ] Inline cell edit + delete with pending-changes/save (not auto-commit)  
  **Acceptance:** edits stay pending until Save; Save is transactional

- [ ] Add-row form from column metadata (types, defaults, nullability, enums)  
  **Acceptance:** required/nullable/enum fields match catalog

- [ ] Component tests for SPA states and pending changes  
  **Acceptance:** `bun test apps/web --preload ./tests/setup/happydom.ts` covers accessible grid, loading/error, and pending-save behavior

- [ ] Thin browser E2E smoke test  
  **Acceptance:** `bunx playwright test tests/e2e` loads the local app and selects a table against a disposable test database

---

## Phase 2 — Bidirectional FK panel

- [ ] References (outgoing): FK columns resolve to target row preview, not ID-only  
  **Acceptance:** preview shows target PK + a display column

- [ ] Referenced by (incoming): grouped by source table, paginated, count badges  
  **Acceptance:** badge count matches `COUNT(*)` for that FK

- [ ] Click-through re-centers drawer; breadcrumb history back  
  **Acceptance:** back returns to previous row/table

- [ ] Self-referential loop guard (depth cap / visited dedupe)  
  **Acceptance:** self-FK cannot recurse unbounded

- [ ] Inferred-relationships toggle (name heuristics), visually distinct from real FKs  
  **Acceptance:** inferred rows labeled; default off

---

## Phase 3 — Write-path safety

Human gates: do not check these off without a person running the listed cases.

- [ ] Before-image capture on INSERT/UPDATE/DELETE; `bun:sqlite` undo log; two-phase pending → mutate → confirmed/failed  
  **Acceptance:** failed Postgres write never appears as restorable in History  
  **Verify:** `bun test` mutation/snapshot tests + manual failed-write

- [ ] Cascade-aware snapshotting (reuse incoming-FK / `confdeltype = 'c'`)  
  **Acceptance:** deleting a parent snapshots cascaded children  
  **Human gate:** cascading deletes

- [ ] History UI: batches, before → after diff, restore per row or per batch  
  **Acceptance:** restore batch is one Postgres transaction

- [ ] Delete confirmation shows FK impact counts before commit  
  **Acceptance:** counts match incoming-FK query

- [ ] Transaction-wrapped saves; optimistic UI rolls back on failure  
  **Acceptance:** UI reverts pending overlay if API errors

- [ ] Retention/pruning (age, size cap, manual clear)  
  **Acceptance:** prune command respects config; History empty after clear

- [ ] Restore topological order; composite keys; schema-drift error  
  **Human gates:** composite keys; failed mid-batch restore; schema drift  
  **Acceptance:** drift surfaces an error; no silent column drop

- [ ] `code-review` skill run on backup/cascade/write-path  
  **Evidence:** date + findings file or notes in this row  
  **Notes:** agent review is not a substitute for human gates above

- [ ] Global search across tables (optional)  
  **Acceptance:** searches configured columns; pagination

- [ ] Connection management (recent / multiple saved DBs)  
  **Acceptance:** switching connection does not mix SQLite backup files

---

## Phase 4 — Distribution

- [ ] npm/Bun package with `bin` CLI (`bunx pg-studio --url=...`)  
  **Acceptance:** README matches Prisma Studio `--url` UX

- [ ] Optional Docker image for self-hosted team mode  
  **Acceptance:** documented compose/run; still uses Postgres URL, no app auth in v1
