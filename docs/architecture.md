# Architecture & Codebase Guide

This document explains the whole codebase: what every file does, where each
feature lives, and how the end-to-end flows work. Read this top-to-bottom once
and you should be able to navigate any part of the repo.

---

## 1. The big picture

```
┌───────────────────────────────  Browser  ───────────────────────────────┐
│  apps/web  (React SPA)                                                  │
│    Sidebar · DataGrid · DetailPanel · FKDrawer · HistoryPanel           │
│    api.ts — Eden Treaty client, fully typed from the server's routes     │
└──────────────────────────────────│──────────────────────────────────────┘
                     same-origin HTTP (Vite proxy in dev)
┌──────────────────────────────────▼──────────────────────────────────────┐
│  apps/server  (Elysia on Bun.serve)                                     │
│    server-app.ts   — all routes + TypeBox schemas + save/restore flows  │
│    backup/         — bun:sqlite undo log (batches + snapshots)          │
│    restore.ts      — reverse-replay of a confirmed batch                │
└──────────────────────────────────│──────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│  packages/db  (@pg-studio/db)                                           │
│    The ONLY module that talks to Postgres: Bun.sql driver,              │
│    pg_catalog introspection, SQL compilers, pure graph/heuristic        │
│    helpers. Swapping drivers is a one-module change by design.          │
└──────────────────────────────────│──────────────────────────────────────┘
                                   │
                            Postgres (pg_catalog → live tables)
```

**Type-safety chain.** `apps/server/src/index.ts` exports `type App = typeof
app`. `packages/api/src/index.ts` re-exports it. `apps/web/src/api.ts` builds
`treaty<App>` — so request/response shapes are checked at compile time from
server to client with zero hand-written API types. Changing a route breaks
typecheck in the web app until the UI catches up.

**Non-negotiables baked into the design** (from [AGENTS.md](../AGENTS.md)):
parameterized SQL only; identifiers quote-validated against catalogs; no ORM;
before-images written *before* any mutation; failed writes never look
restorable.

---

## 2. File-by-file map

### `apps/server/src/`

| File | Job |
|---|---|
| `index.ts` | Process entrypoint. Reads `PG_STUDIO_DB_URL ?? TEST_DATABASE_URL`, serves built SPA if `apps/web/dist` exists, listens on `PORT` (default 3000). Exports `type App`. |
| `server-app.ts` | **The heart**: `createServerApp(config)` wires every route + TypeBox schema, plus the save flow and connection switching. Also exports `connectionIdFromUrl`, `redactUrl`, shared schemas (`SaveBodySchema`, …), and `ConnectionError`. |
| `backup/index.ts` | `BackupStore` — bun:sqlite undo log. Two tables: `batches` (pending→confirmed→failed state machine, `restored_at`) and `snapshots` (per-row before/after images keyed by pk tuple). Additive migrations via `pragma table_info`. Also prune/clear for retention. |
| `restore.ts` | `restoreBatch()` — validates a confirmed batch, checks for schema drift, then replays undo ops inside ONE Postgres transaction (see §4.4). Throws `RestoreError` for user-facing 409s. |
| `seed.ts` | CLI: applies `tests/fixtures/seed.sql` to `$TEST_DATABASE_URL`; refuses when it equals `DATABASE_URL`. |
| `prune-cli.ts` | Retention CLI over `~/.pg-studio/backups/*.sqlite`: `--max-age-days`, `--keep N`, `--clear`, optional `--connection <id>`. |
| `cli.ts` | Early spike CLI (prints introspected tables/columns). Kept for reference. |
| `spike-app.ts` | Early Elysia spike. Not part of the real app. |

### `packages/db/src/` (`@pg-studio/db`)

Everything that touches Postgres, plus pure helpers that need no database.

| File | Job |
|---|---|
| `identify.ts` | Identifier safety: `assertSafeIdent`, `quoteIdentifier`, `quoteQualified`. Every dynamic SQL path goes through this. |
| `catalog.ts` | `listTables`, `listColumns` — live catalog queries (tables AND views). |
| `schema-meta.ts` | `listPrimaryKeys`, `listUniqueConstraints`, `listIndexes`, `listEnums`. |
| `fks.ts` | FK introspection: `listIncomingFks`, `listOutgoingFks`, `listTableFks` — includes `onDelete`/`onUpdate` actions (`confdeltype`). |
| `normalize.ts` | Raw catalog rows → typed metadata (`TableMeta`, `ColumnMeta`, `FkConstraintMeta`) with validation (`MetadataError`). |
| `cursor.ts` | Keyset pagination cursors: base64url encode/decode of `(column,value)` tuples (`CursorError`). |
| `rows.ts` | `compileRowsQuery` — SELECT page + keyset WHERE clause + ORDER BY pk columns; `listRows` executor; `jsonSafe`. |
| `mutations.ts` | Compilers for writes: `compileUpdate/Delete/Insert/SelectByPkTuples`. All parameterized; identifiers quoted. |
| `fk-graph.ts` | Pure FK-graph algorithms: `walkReferences` (BFS with visited-dedupe, powers drawer traversal guards) and `topoRestoreOrder` (parents-before-children ordering for restore). |
| `references.ts` | Row-level reference resolution for the drawer: `resolveOutgoingReferences` (parent previews + `pickDisplayColumn` heuristic) and `resolveIncomingReferences` (exact per-FK counts + paginated child rows). |
| `cascades.ts` | `collectCascadingRows` — BFS over incoming CASCADE / SET NULL edges to snapshot children a delete would silently destroy or modify. Cycle-safe via visited set of `(table, pk)`. |
| `inferred.ts` | `inferRelations` — pure name heuristics (`_id` suffix → singular/plural/trailing-segment table match, strong/weak confidence, real-FK exclusion, self-edge guard). |
| `search.ts` | `searchAcrossTables` — global textual search: escaped ILIKE, two-phase exact pagination (counts first, then row fetch only for tables overlapping the requested page). |

`index.ts` re-exports the public surface; import from `@pg-studio/db`, never
from file paths.

### `apps/web/src/`

| File | Job |
|---|---|
| `main.tsx` | React root + QueryClientProvider. |
| `App.tsx` | Top-level layout & state: selected table, detail row, **drawer history stack** (click-through navigation + visited-dedupe loop guard, depth cap 25), History panel toggle. |
| `api.ts` | `treaty<App>` client + the UI-facing types (`Row`, `StudioClient`, …). Component tests swap this via the `client` prop — the narrow `StudioClient` interface is the seam. |
| `components/Sidebar.tsx` | Schema-grouped table list, global search box + results, connection section (current URL, recents dropdown, add form; clears query cache on switch). |
| `components/DataGrid.tsx` | Virtualized grid: keyset "Load more", sort toggle, local search, double-click cell editing, staged deletes (`✕`), References button (`⛓`), add-row toggle, pending-changes toolbar with **FK-impact delete confirmation**, Save/Discard. |
| `components/AddRowForm.tsx` | Insert form generated from column metadata: required markers, enum selects, numeric coercion; stages inserts (DB defaults apply when omitted). |
| `components/DetailPanel.tsx` | Click-a-row → all columns aside. Replaced by the drawer while it's open. |
| `components/FKDrawer.tsx` | Bidirectional FK drawer: outgoing previews, incoming count badges with expandable paginated children, inferred-relationships toggle (default off), Back/Close. |
| `components/HistoryPanel.tsx` | Restorable batches, before→after diff per snapshot, batch Restore button with result notice. |
| `ui.test.tsx` | All component tests (one file, many describes). |

### `packages/api/src/index.ts`
One line: re-exports `type App` from the server. Exists so the web package can
depend on a tiny type-only package instead of the server itself.

### `tests/`

| Path | Covers |
|---|---|
| `unit/*.test.ts` | Pure logic, no Postgres: cursor codec, identifier quoting, normalization, mutation compilers, fk-graph, BackupStore lifecycle/pruning, display-column picker, inferred heuristics, rows-query compiler. |
| `integration/helpers.ts` + `fixtures/apply-seed.ts` | Open `$TEST_DATABASE_URL`, apply `fixtures/seed.sql` (drop + recreate everything, so files are order-independent). |
| `integration/harness.test.ts` | Seed sanity + cascade behavior of the fixture. |
| `integration/{introspect,fks,schema-meta}.test.ts` | Catalog introspection correctness. |
| `integration/{api,rows-api}.test.ts` | Table detail + rows endpoints (keyset pagination, sorting). |
| `integration/save-api.test.ts` | Transactional save: before-images pre-mutation, confirm/fail semantics, cascade delete through the API. |
| `integration/references.test.ts`, `inferred-api.test.ts`, `search-api.test.ts` | Drawer endpoints, `/inferred`, `/search`. |
| `integration/restore-api.test.ts` | Cascade capture+restore, insert RETURNING undo, update rewind, failed-write exclusion, double-restore 409, schema-drift 409. |
| `integration/connections-api.test.ts` | Runtime switching + rollback-store isolation. |
| `e2e/smoke.spec.ts` | Playwright: boots built app + server, drives the real UI. |
| `setup/happydom.ts` | Preload registering happy-dom for component tests. |
| `types/eden.test-d.ts` | Compile-time checks that treaty types line up. |

### Root config

`package.json` (workspace scripts) · `playwright.config.ts` (builds SPA, boots
server, chromium) · `bunfig.toml` · `tsconfig.json` + `packages/config/tsconfig.base.json`.

---

## 3. HTTP API reference

All JSON. Errors are `{ error: string }`.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness. |
| `GET /api/connections` | Current connection (id + redacted URL) + recents. |
| `POST /api/connections` | Switch at runtime: body `{ url }` or `{ connectionId }` (resolved against server-side recents). Invalid scheme → 400; unknown id → 404. |
| `GET /api/tables` | Tables + views across schemas. |
| `GET /api/enums` | Enum types + labels (add-row form selects). |
| `GET /api/search?q&offset&limit` | Global textual search; returns pk tuples + snippets + exact pagination. Empty `q` → 400. |
| `GET /api/schemas/:s/tables/:t` | Table detail: columns, primary key, uniques, outgoing/incoming FKs. |
| `GET /api/schemas/:s/tables/:t/rows` | Keyset-paginated rows (`cursor`, `sort`, `limit`). |
| `POST /api/schemas/:s/tables/:t/save` | Apply staged updates/deletes/inserts as one transaction (see §4.2). Returns counts incl. `cascadedDeletes` + `batchId`; 500 keeps batch `failed`. |
| `POST .../references/outgoing` | Resolve each outgoing FK of one row to a parent preview (`{row, displayColumn}` or null) + `parentColumns`. |
| `POST .../references/incoming` | Per incoming FK: exact `totalCount` + one page of child rows + `nextOffset`. |
| `GET .../inferred` | Name-heuristic relationship candidates (real FKs excluded). |
| `GET /api/history/batches` | Confirmed, not-yet-restored batches for the current connection. |
| `GET /api/history/batches/:id/snapshots` | Batch + snapshots incl. before/after images (409 if not confirmed). |
| `POST /api/history/batches/:id/restore` | Reverse-replay in one transaction; marks restored. 409 on failed/pending/already-restored/drift. |

---

## 4. Feature flows

### 4.1 Browsing (grid)

1. Sidebar select → `App` sets `selected`, remounts `DataGrid` (keyed).
2. Grid fetches table detail (columns, pk) + `rows?cursor=…`.
3. `packages/db/rows.ts::compileRowsQuery` builds
   `select * from t order by <pk cols> limit $n where (pk) > ($…)` — keyset,
   never OFFSET. Next page's cursor = encoded last-row pk tuple.
4. Sort toggle re-requests with `sort=<column>&dir=asc|desc` (pk cols are
   always appended for a total order). Search filters *loaded* rows only
   (client-side).

### 4.2 Editing: pending changes → Save

**Staging (local only):**
double-click cell → input → Enter stages into `stagedUpdates` (Map keyed by
row); `✕` stages into `stagedDeletes`; AddRowForm stages inserts. Nothing hits
the network except the confirmation counts below.

**Save flow (`DataGrid.onSave` → `performSave`):**

1. If staged deletes exist → open confirm dialog; fetch
   `references/incoming` per deleted row and show summed per-table impact.
   Commit requires an explicit **Confirm & save** click. Cancel discards the
   dialog, not the staging.
2. `POST .../save` with `{updates, deletes, inserts}`. Server-side:

```
validate (pk arity, known columns, non-empty ops)
collect cascading children for deletes      ← packages/db/cascades.ts
beginBatch() → sqlite batch status=pending  ← BEFORE Postgres is touched
addSnapshots(before-images + cascade captures)
db.begin(async tx => UPDATEs, DELETEs, INSERTs…RETURNING)
attach after-images (updates re-selected; inserts from RETURNING)
                                            ← batch still pending: two-phase intact
confirmBatch()                              ← now restorable
```

3. On any Postgres error inside the tx: rollback + `failBatch()` → the batch
   never appears in History (non-negotiable #3). The UI keeps the pending
   overlay and shows an alert (optimistic rollback).

### 4.3 FK drawer (bidirectional references)

1. `⛓` button on a row → `App.navigateTo({schema, table, pkValues})`.
2. Navigation guard: if the target already exists in the drawer stack, the
   forward entries are truncated (breadcrumb semantics) instead of pushing a
   duplicate — self-FK ping-pong cannot grow the stack; hard cap depth 25.
3. Drawer fires two requests:
   - `references/outgoing` → per FK: parent preview using
     `pickDisplayColumn` (preferred names > text column > first column);
     clicking navigates by the FK's `parentColumns` mapped off the preview row.
   - `references/incoming` → groups filtered to `totalCount > 0`; badge shows
     the exact count; expanding lists children ("Load more" pages by
     `nextOffset`); clicking a child navigates by that child table's pk
     (fetched via cached table detail).
4. `Back` pops one level; `Close` clears the stack. While the drawer is open
   it replaces the DetailPanel.

### 4.4 Rollback: capture → History → restore

**Capture.** Every write path records images:
- updates/deletes: full row read before mutation;
- cascaded children: captured pre-tx with `effect=cascade` (undo = re-insert)
  or `effect=set-null` (undo = rewrite captured row);
- inserts: rows returned by `INSERT … RETURNING` are stored as
  after-images while the batch is still pending — undo needs the generated pk.

**History UI.** `HistoryPanel` lists only `confirmed ∧ restored_at IS NULL`
batches (server-filtered). Expanding shows per-snapshot diffs (updates show
`col: before → after`).

**Restore (`apps/server/src/restore.ts`).**

```
batch must be confirmed, current connection, not yet restored
schema drift check: every captured image key must still exist;
                    pk shape must still match  → else 409, nothing runs
build undo ops: insert→DELETE by after-image pk
                delete→INSERT full before-image row
                update→UPDATE all columns back to before-image
order: undo-inserts child-first (reversed topo),
       then re-inserts/updates parents-first (topoRestoreOrder)
execute ALL inside db.begin(tx)  → markRestored(batchId)
```

Any failure aborts the transaction; the batch stays restorable (safe
direction).

### 4.5 Inferred relationships

Toggle in drawer header (default **off** — the endpoint isn't even fetched
until enabled). Server runs `inferRelations` over the table's columns vs. all
tables: `_id` suffix stripped, singular/plural + trailing-segment matching
(`delivery_address_id → addresses`), confidence strong/weak, columns covered
by real FKs excluded, no self-edges. Rendered dashed/italic and labeled
`(inferred, confidence)` — visually distinct from real FK rows.

### 4.6 Global search

Sidebar form → `GET /api/search?q=` → engine lowercases-escapes the pattern
(`%`,`_`,`\` neutralized), counts matches per textual column set per table,
then fetches rows only for tables overlapping the requested window — giving
exact pagination without OFFSET scans. Each hit carries pk values; clicking
calls `App.onOpenRow` which switches table **and** opens the drawer centered
on that row.

### 4.7 Connection management

`POST /api/connections {url|connectionId}` → `switchConnection`:
close old store + pool → open new `SQL(url)` → open a fresh
`BackupStore.open(~/.pg-studio/backups/<new-id>.sqlite)` → push to recents.
Because the id is a hash of the URL, each connection's undo history lives in
its own file and can never mix (proven in `connections-api.test.ts`). The
sidebar clears all react-query caches on switch; URLs are redacted on the
wire, and reconnecting to a recent database happens by id resolved
server-side.

---

## 5. Testing strategy

| Suite | Command | Needs |
|---|---|---|
| Unit | `bun run test` (subset `tests/unit`) | nothing |
| Integration | `bun run test` (subset `tests/integration`) | `$TEST_DATABASE_URL` reachable |
| Components | `bun run test:web` | happy-dom preload (no Postgres) |
| E2E | `bun run test:e2e` | builds SPA + boots server + Postgres |
| Types | `bun run typecheck` | nothing |

Conventions:
- Component tests inject a fake `StudioClient` (see `stubClient`,
  `makeRowClient` in `ui.test.tsx`) — the UI never imports the real treaty
  client directly.
- Integration files each call `createSeededTestDb()` in `beforeAll`; the seed
  drops/recreates the fixture schema, so test order doesn't matter.
- Write-path assertions always check both sides: Postgres outcome *and*
  sqlite batch/snapshot state (the two-phase contract).
- Human gates for destructive verification live in
  [docs/progress.md](progress.md) and are never auto-checked.

## 6. Where to add things

- New endpoint → `apps/server/src/server-app.ts` (TypeBox both directions);
  heavy lifting belongs in `@pg-studio/db` as a tested unit.
- New pure SQL/graph logic → new module in `packages/db/src` + export from its
  `index.ts` + unit tests in `tests/unit`.
- New UI surface → component in `apps/web/src/components` + describe block in
  `ui.test.tsx` with a stub client; wire through `App.tsx`.
- New mutation kind → extend `mutations.ts` compiler + `SnapshotInput`
  handling in `BackupStore` + save-flow integration test covering failure.
