# Progress tracker

Source: [postgres-studio-feasibility-and-plan.md](postgres-studio-feasibility-and-plan.md) §§6–7a. Update this file when a task is actually verified ([agent-workflow.md](agent-workflow.md)).

**Status:** Bootstrap complete. Phase 0 complete (all tasks verified). Phase 1 not started.

| Phase | Status |
|---|---|
| Bootstrap (skills, rules, workflow, monorepo) | done |
| Phase 0 — Spike | done |
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

- [x] CLI accepts `--url`, connects with `Bun.sql`, dumps table list + columns from `information_schema`  
  **Done:** 2026-08-24  
  **Evidence:** `bun apps/server/src/cli.ts --url "$TEST_DATABASE_URL"` printed 5 relations with columns/flags; `--json` round-trips the same payload; `mysql://` URL rejected exit 2 with usage; unknown arg exit 2. Catalog functions covered by `bun run test` (83 pass / 0 fail)  
  **Notes:** `packages/db/src/catalog.ts` holds introspection (bind parameters only, identifiers quoted). System/temp/toast schemas excluded. Identity columns render as `DEFAULT (identity)` (`is_identity` folded into `hasDefault`). URLs are password-redacted before printing. Root `test` script scoped to `tests/unit tests/integration` so Playwright specs aren't collected by bun.

- [x] FK query both directions on seeded DB (self-FK + composite FK)  
  **Done:** 2026-08-24  
  **Evidence:** `bun run test` → 90 pass / 0 fail; `tests/integration/fks.test.ts` asserts outgoing self-FK (`employees.manager_id`, SET NULL), composite FK (`order_items[shop_id,order_no] → orders`, CASCADE), incoming for `orders`/`employees`, and empty results for leaf tables  
  **Notes:** `packages/db/src/fks.ts` via `pg_constraint` with positional pairing of `conkey/confkey` (composite columns stay aligned); direction filters verified against fixture. Gotcha recorded: reusing a shared SQL fragment across concurrent queries misapplied appended WHERE — fragments are now built fresh per call.

- [x] Minimal Elysia app: schema validation on one endpoint, hot reload, path params, TypeBox errors  
  **Done:** 2026-08-24  
  **Evidence:** `bun test tests/integration/elysia-spike.test.ts` → 7 pass / 0 fail (`app.handle` request-level, no network); live boot check `PORT=3999 bun apps/server/src/index.ts` → `/health` = `{"ok":true}`, `/spike/hello/grace` = `{"message":"hello, grace"}`; full gate `bun run test` → 97 pass / 0 fail, `bun run typecheck` exit 0  
  **Notes:** `apps/server/src/spike-app.ts` is the Phase 0 surface (prefix `/spike`, DB-free). Invalid body/type/range → 422 with TypeBox validation payload. `dev` script runs `bun --hot src/index.ts`. elysia pinned in `apps/server`, eden in `packages/api`.

- [x] Eden Treaty throwaway client fetch against that endpoint  
  **Done:** 2026-08-24  
  **Evidence:** `bun test tests/integration/eden-treaty.test.ts` → 4 pass / 0 fail (in-memory treaty round-trips hello + echo, 422 surfaced as error); type gate `tsc --noEmit -p tests/tsconfig.json` passes incl. negative cases (`@ts-expect-error` on missing param / wrong limit type); full gate `bun run test` → 101 pass / 0 fail  
  **Notes:** `packages/api` re-exports `App` from the server entry (type-only, no port binding). Dependency direction fixed: api dev-depends on server; server no longer depends on api. Gotcha: path params go in the segment call (`api.spike.hello({name}).get()`), not the verb call — both runtime test and types now encode this. Tests are now typechecked via new root `tests/tsconfig.json` wired into `bun run typecheck`.

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

- [x] Schema introspection: tables, views, columns, types, PK/FK/unique/index, enums, multi-schema  
  **Done:** 2026-08-24  
  **Evidence:** `bun run test` → 110 pass / 0 fail. `tests/integration/schema-meta.test.ts` asserts composite PK order (`orders[shop_id,order_no]`), unique constraints in both schemas, secondary/partial index flags, enum values in declaration order, `USER-DEFINED`/`task_status` udt on the status column; view vs table kind asserted in `introspect.test.ts`  
  **Notes:** new `packages/db/src/schema-meta.ts` (listPrimaryKeys/listUniqueConstraints/listIndexes/listEnums). Seed fixture extended with `app` schema, `task_status` enum, view, partial index, and cross-schema FK `public.links → app.projects`. Bug caught by tests: module initially used global `sql` instead of the injected connection — all catalog access now flows through the passed `db`.

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
