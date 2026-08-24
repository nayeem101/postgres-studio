# Feasibility Study & Build Plan: Postgres Data Studio with Bidirectional FK Navigation

## 1. Correcting the starting assumption

Prisma Studio (current version) is **standalone and ORM-agnostic**. It can connect directly to any Postgres database via connection string (`prisma studio --url=...`) and introspects the schema in real time — no `schema.prisma`, no Prisma Client, no Prisma anywhere in your app. So it works fine against a .NET Web API's Postgres database. That is *not* the gap.

The real gap: Prisma Studio's relationship navigation is one-directional and click-through (jump to the related table), not a persistent "for this row, show me everything it points to *and* everything that points to it" panel.

## 2. Existing tools — what already solves this

| Tool | License | Bidirectional FK row view | Notes |
|---|---|---|---|
| **DBeaver** | Free (CE), Apache-2.0 | **Yes — closest match.** References panel shows the referenced row (outgoing) and all rows that reference the current row (incoming), for the selected PK. | Full DBA IDE, dense UI, steep for non-technical users, Java/Eclipse-based, not spreadsheet-first. |
| DbVisualizer | Free + Pro | Yes, as a relationship graph | Pro tier for the good stuff; visual graph, not a compact row-detail drawer. |
| DataGrip | Paid (JetBrains) | Partial | Strong FK metadata/diagrams; live reverse-reference *row* browsing is weaker. |
| Beekeeper Studio | Free/open core | Forward only | One-click navigate to FK target; reverse lookup and even FK hover-preview are still open GitHub feature requests. |
| Prisma Studio | Free, closed source | Forward only, click-through | Best-in-class spreadsheet UX; no ORM required now; no reverse-reference drawer. |
| pgAdmin / Adminer | Free | No | Admin-focused, not row-relationship-focused. |
| NocoDB / Directus / Retool | Free–paid | Varies, but these turn your DB into an app builder, heavier footprint than a "studio" | Overkill if you just want a viewer. |

**Conclusion:** nothing combines *(a)* Prisma Studio's clean spreadsheet-like UX, *(b)* zero-ORM standalone operation, and *(c)* a first-class bidirectional FK drawer on the row level. DBeaver has the closest capability but not the UX. This is a legitimate gap worth building for — the differentiator is UX + the drawer as the headline feature, not raw capability.

**Second gap — per-edit local rollback.** DBeaver and TablePlus both ship "Backup and Restore," but it's whole-database dump/restore via `pg_dump`/`pg_restore` — a DBA operation, not something you'd reach for after one bad UPDATE. No mainstream tool in this space does automatic, per-mutation before-image snapshots with one-click rollback for individual edits. That's a second genuine differentiator, not just a nice-to-have.

## 3. Feasibility

**Technically straightforward, not a research project.** Everything you need is exposed by Postgres itself:

- **Schema/table/column introspection:** `information_schema` + `pg_catalog` (`pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`) give you tables, columns, types, PKs, FKs, indexes, enums, views.
- **Outgoing FK (row → row it points to):** for each FK column on the row, read `pg_constraint` where `contype = 'f'` to get `(local table, local column) → (foreign table, foreign column)`, then `SELECT * FROM foreign_table WHERE foreign_column = row.local_column`.
- **Incoming FK (rows that point to this row):** query `pg_constraint` for all constraints where `confrelid = this_table's oid` (i.e., this table is the *target*), then for each, `SELECT * FROM child_table WHERE fk_column = this_row.pk_value` — paginated, since there could be many.
- **Composite keys:** slightly more SQL to build (`ROW(a,b) = ROW($1,$2)`), but same pattern.
- **No dependency on Prisma, EF Core, or any ORM** — this reads Postgres' own catalogs, so it's true to your ".NET-agnostic" requirement and works for any backend stack.

Risk areas to plan for, not blockers:
- Very large tables → need cursor/keyset pagination, not offset scans, for both the main grid and the FK drawer.
- Tables with **no formal FK constraints** (some teams disable them intentionally, e.g. Rails/PlanetScale-style, or a lot of legacy schemas) — you may want an optional "inferred relationships" mode (heuristic on column naming like `user_id` → `users.id`) as a v2, clearly marked as inferred vs. real constraints.
- Self-referencing FKs (e.g. `employees.manager_id → employees.id`) — need to guard the UI against infinite drawer loops.
- Write support (editing/deleting rows) needs transaction-safe diffing and FK-aware delete warnings (cascade vs. restrict) — this is where most of the engineering time will actually go, not the read-side browsing.
- Multi-schema Postgres databases (not just `public`) — introspection needs to be schema-aware from day one.
- **Bun-specific risk:** `Bun.sql` is newer and less battle-tested than `pg`/`postgres.js`; if you hit an edge case (exotic types, LISTEN/NOTIFY, some SSL configs), fall back is either `postgres.js` (pure-JS, runs fine on Bun, closest in style to `Bun.sql`) or `pg` (works unmodified on Bun per Bun's Node compatibility layer). Keep the introspection/query layer isolated behind a small internal module so swapping the driver later is a one-file change, not a rewrite.

**Verdict: feasible, low technical risk, medium-large but well-understood scope.** The hard part is UX polish and making the write-path safe, not the introspection.

## 4. Web app vs. Electron

**Recommendation: web app (local server + browser UI), same architecture as Prisma Studio itself. Skip Electron.**

Reasoning:
- Prisma Studio's own model — a lightweight local Node/web server that opens `localhost:PORT` in the default browser — is proven, simple to build, simple to update, and trivially cross-platform (Windows/macOS/Linux "for free" since it's just a browser).
- Electron adds real cost you don't need here: packaging/signing per OS, auto-update infrastructure, larger binary size, a whole extra IPC layer between main/renderer — for an app whose entire job is "talk to Postgres and render a grid." None of your target features (FK drawer, schema introspection) need OS-level access, filesystem beyond reading a connection string, or native menus.
- A pure web app also unlocks the thing Prisma's newer Studio added for teams — optional hosted/shared mode (self-hosted, run it on a server, whole team hits one URL) — which is a nice differentiator over desktop-only tools like DBeaver/DataGrip.
- Downside of web-only: no native OS packaging/installer feel, no offline-app icon in the dock. This is minor for a dev tool — most engineers are fine running one CLI command (`npx pg-studio --url=...`), exactly like they already do for Prisma Studio.
- If down the line you want a "double-click to open" desktop feel without building Electron, wrapping the same web app in a *thin* Tauri shell is a cheap add-on later (Tauri binaries are far smaller than Electron and reuse your web frontend as-is) — but this is optional polish, not a v1 requirement.

**Decision: build as a local web server + SPA frontend, launched via CLI, connecting directly to Postgres. Revisit Tauri packaging only after the core product is validated.**

## 5. Proposed tech stack

**Runtime note — Bun, and Elysia over bare `Bun.serve()`:** Bun does not ship an official "Express for Bun" package; its first-party primitives are `Bun.serve()` (native routing, added in Bun 1.3) and `Bun.sql` (native Postgres/MySQL/SQLite client). Elysia is not first-party, but it's built directly on top of `Bun.serve()` (it uses Bun's native router under the hood, not a competing HTTP layer), so choosing it doesn't cost you Bun's native performance — it adds three things bare `Bun.serve()` doesn't give you, all of which matter for this project specifically:

1. **Schema validation for dynamic, per-table payloads.** Row-edit/insert endpoints accept arbitrary column shapes (text, int, enum, jsonb, timestamptz, etc.) depending on which table is open. Elysia's TypeBox-based schemas validate this declaratively, compiled to optimized functions at startup rather than checked per-request.
2. **Eden Treaty — an end-to-end typed client with no code generation.** The React frontend consumes runtime-derived shapes (table/column/FK metadata from introspection) that don't exist as static types anywhere. Eden Treaty keeps frontend and backend in sync on these shapes automatically, which removes a real class of drift bugs for a tool like this.
3. **Auto-generated OpenAPI/Swagger docs** from the same schemas, useful if the API ever gets scripted against directly, or just for debugging endpoints during development.

The trade-off: Elysia is an added dependency, not literally first-party, and it doesn't provide infrastructure primitives (queues, background jobs, tracing) — but none of that is needed for a local dev tool, and the runtime overhead versus bare `Bun.serve()` is negligible once a Postgres round-trip is in the request path. **Decision: Elysia on Bun**, using `Bun.sql` underneath for the database layer.

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | Single binary for runtime + package manager + bundler + test runner; native TypeScript execution (no build step in dev); ~2–4x raw HTTP throughput over Node in benchmarks, though real-world gains shrink once DB I/O dominates — worth it here mainly for the built-in `Bun.sql` + routing, not raw speed. |
| Backend/API | **Elysia** on Bun (built on `Bun.serve()`'s native router) | Adds schema validation for dynamic per-table payloads, an end-to-end typed client (Eden Treaty) so the React frontend stays in sync with runtime-derived schema shapes, and free OpenAPI docs — without giving up Bun's native routing underneath. |
| Postgres driver | **`Bun.sql`** — first-party, native, no ORM | Tagged-template queries (`` sql`SELECT ... WHERE id=${id}` `` — auto-parameterized, so injection-safe by construction) against `pg_catalog`/`information_schema`. Built-in connection pooling and transactions, so no separate pool library either. |
| Schema introspection | Hand-written SQL against `pg_catalog` (`pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`, `pg_enum`), cached per-connection with a manual "refresh schema" action | Full control over composite keys, multi-schema, enums, generated columns — a canned introspection library would fight you here. |
| Frontend | **React + TypeScript**, Vite | Standard, fast dev loop, huge component ecosystem for data grids. |
| Data grid | **TanStack Table** (headless) + a virtualization layer (**TanStack Virtual** or `react-window`) for large tables | Prisma Studio-like spreadsheet feel with inline cell editing, sortable/filterable columns, and virtualized rows so 100k-row tables don't choke the browser. |
| FK drawer / relationship panel | Custom React panel, own component — this is your core differentiator | Slide-over or split-pane showing: "References" (outgoing, usually 0–few rows) and "Referenced by" (incoming, paginated, grouped by table). |
| Data fetching (frontend) | **Eden Treaty** (Elysia's typed client) + **TanStack Query** for caching/pagination/optimistic updates | Eden Treaty gives compile-time-checked API calls without hand-written types or codegen; TanStack Query layers caching and pagination on top of those typed calls. |
| Auth to the DB | Just the Postgres connection string/role permissions — no separate auth layer for v1 (single-user local tool, like Prisma Studio) | Keep v1 scope tight; add app-level auth only if/when you build the "hosted, shared with team" mode. |
| Packaging | npm/Bun package with a `bin` CLI entry (`bunx pg-studio --url=...`, works via `npx` too since Bun publishes standard npm packages), same UX as `npx prisma studio` | Zero-install trial, matches developer expectations. |
| Local backup / rollback store | **`bun:sqlite`** — first-party embedded SQLite, one file per connection | Durable local undo log (survives restarts, unlike an in-memory stack). Stores before-image snapshots so any edit/delete can be rolled back without touching Postgres backup/restore. |
| Styling | Tailwind CSS | Fast to build a clean, spreadsheet-dense UI without fighting a heavy component library. |

## 6. Build plan (phased)

**Timeline note — building with AI coding agents:** scaffolding, introspection queries, CRUD endpoints, and UI components genuinely compress a lot with agent-assisted development — a lot of Phases 1, 2, and 4 is exactly the kind of well-specified, pattern-repeating work agents are strong at. What doesn't compress at the same rate is **your own review and testing time**, and that matters disproportionately for Phase 3: the whole point of the local rollback system is that it's trustworthy under pressure (someone's about to lose data and needs it to work correctly, right then). Bugs in the code that *writes data* are recoverable by re-running an agent; bugs in the code that's supposed to *undo* a bad write are the failure mode this feature exists to prevent. So below, generation time drops sharply everywhere, but Phase 3 keeps proportionally more human verification time than the others — cascade-order restores, batch rollback, and the two-phase capture logic specifically should be hand-tested against real edge cases (cascading deletes, composite keys, a failed mid-batch restore), not just agent-generated and trusted.

### Phase 0 — Spike (half a day)
- CLI (`Bun.argv` or a tiny arg-parser) that accepts `--url`, connects with `Bun.sql`, and dumps table list + columns from `information_schema` to confirm the introspection approach end-to-end.
- Prove out one FK constraint query in both directions against a seeded test DB (a few tables, one self-referencing FK, one composite FK) to validate the SQL patterns before building UI on top.
- Stand up a minimal Elysia app (routes defined with schema validation on one endpoint) to confirm the dev loop — hot reload, path params, TypeBox validation error messages — before committing to it for the whole backend.
- Try Eden Treaty from a throwaway frontend fetch to confirm the typed-client flow works end-to-end before Phase 1 depends on it.

### Phase 1 — Core browsing (Prisma Studio parity), ~2–3 days
- Elysia app + SPA scaffold, `localhost` launch flow. Bun can serve the built React static assets directly, so no separate static file server is needed.
- Define TypeBox schemas for the core response shapes (table list, column metadata, row payloads) early — these drive both validation and the Eden Treaty types the frontend will consume.
- Schema introspection: tables, views, columns, types, PK/FK/unique/index metadata, enums, multi-schema support.
- Sidebar table/view list, grid view with virtualized rows, column sort/filter/search, pagination (keyset-based).
- Row detail panel: view a single row's full values.
- Basic inline cell editing + delete row, with a pending-changes/save model like Prisma Studio's.
- Add new row form generated from column metadata (types, defaults, nullability, enums).

### Phase 2 — The differentiator: bidirectional FK panel, ~2 days
- On row selection: "References" section — resolve each FK column to its target row (fetch + inline preview, not just an ID).
- "Referenced by" section — for every table with an FK pointing at this table, paginated list of matching rows, grouped and collapsible per source table, with a count badge per table (`orders (14)`, `audit_log (312)` etc.) so it doesn't overwhelm.
- Click-through from either side to jump to that row and re-center the drawer on it (with breadcrumb history so users can navigate back).
- Guard against self-referential infinite loops (cap depth / dedupe visited rows).
- "Inferred relationships" toggle for tables missing formal FK constraints (heuristic column-name matching), visually distinguished from real constraints.

### Phase 3 — Write-path safety & polish, ~4–5 days (code generates fast; budget real hours for hand-testing rollback correctness — see note above)
- **Local rollback system (see §6a for design):** before-image capture on every UPDATE/DELETE/INSERT, `bun:sqlite`-backed undo log, cascade-aware snapshotting, two-phase capture-then-commit so failed writes never leave stale backup entries.
- History panel UI: list of past mutations/batches, before → after diff view, "Restore" per row or per save-batch.
- Delete confirmation that shows FK impact upfront (e.g., "12 rows in `order_items` reference this row" before you commit a delete) using the same incoming-FK query — this doubles as the cascade list the rollback system needs to snapshot.
- Transaction-wrapped saves, optimistic UI with rollback on failure.
- Retention/pruning controls for the local backup store (age- or size-based, plus manual clear).
- Global search across tables (optional, nice-to-have).
- Connection management (recent connections, multiple saved DBs).

### Phase 4 — Distribution, ~1 day
- Publish as an npm package with a `bin` CLI, README modeled on Prisma Studio's `--url` flag UX.
- Optional: Docker image for a "run it on a server, whole team connects via browser" self-hosted mode — this is the concrete advantage over desktop-only competitors like DBeaver/DataGrip.

**Rough total with agent-assisted development: ~10–12 working days** rather than ~7–9 weeks — most of that compression coming from Phases 0, 1, 2, and 4, where the work is well-specified and pattern-heavy. Treat Phase 3's days as a floor, not a target: if cascade/rollback edge cases surface real bugs during hand-testing, let that phase run long rather than shipping write-path safety on a deadline.

## 6a. Design detail — local backup & rollback

This is the third headline feature (alongside the bidirectional FK drawer), so it deserves its own spec rather than a bullet.

**Storage:** one `bun:sqlite` file per connection (e.g. `~/.pg-studio/backups/<connection-id>.sqlite`), separate from the target Postgres database entirely — a bad rollback can never corrupt the thing it's protecting. Schema roughly:

- `batches` — `id, created_at, label` (a "batch" = one Save action, which may touch several rows/tables at once, matching Prisma Studio's pending-changes-then-save model).
- `snapshots` — `id, batch_id, schema_name, table_name, pk_json, operation (insert|update|delete), before_image_json, after_image_json (nullable), status (pending|confirmed|failed)`.

**Capture flow, per mutation:**
1. Resolve the row(s) affected, including cascades: for a DELETE, walk `pg_constraint` for any FK pointing at this table with `confdeltype = 'c'` (CASCADE) and recursively find every row that would disappear with it — this reuses the exact incoming-FK query built for the relationship drawer in Phase 2, so it's not new introspection work.
2. `SELECT` the full before-image of every affected row (parent + cascaded children) and write it to `snapshots` with `status = pending`.
3. Execute the real mutation against Postgres inside a transaction.
4. On commit success, flip `status = confirmed`. On failure, flip to `failed` (kept for debugging, filtered out of the History UI) or delete it outright.

**Rollback flow:**
- Restoring a `delete` snapshot re-`INSERT`s the before-image — parents before children, using the same topological order the cascade walk already produced.
- Restoring an `update` snapshot re-`UPDATE`s the row back to `before_image_json`.
- Restoring an `insert` snapshot `DELETE`s the row that was added.
- Restoring a whole batch replays all of its snapshots in one Postgres transaction, so a multi-row Save either fully rolls back or not at all.

**Retention:** this is a local safety net, not a permanent audit trail — default to pruning by age (e.g. 30 days) and/or size cap (e.g. 500MB per connection), both user-configurable, plus a manual "clear history" action.

**Edge cases to design for explicitly:** very large before-images (e.g. bulk update touching 50k rows — cap what gets auto-snapshotted per batch and warn the user rather than silently ballooning the SQLite file); `bytea`/large binary columns (store a reference/hash instead of the raw bytes past a size threshold); schema drift between snapshot time and restore time (a column may have been dropped/renamed since — restore should validate against current schema and surface a clear error rather than silently failing).

## 6b. Testing strategy and conventions

Use three layers, each testing a different boundary. Unit tests are fast and deterministic; integration tests prove real Postgres behavior; browser E2E tests prove the assembled user workflow. Do not substitute one layer for another.

### Minimum test set by phase

| Phase | Required tests | What they prove |
|---|---|---|
| Phase 0 | Unit + integration | Pure SQL/metadata logic is correct, and catalog/FK queries work against real Postgres (including self-FK and composite FK fixtures). |
| Phase 1 | Unit + integration + a thin E2E smoke test | API contracts and reads work, while a real browser can load the SPA and select a table. |
| Phase 2 | Unit + integration + E2E | FK direction/grouping/pagination logic is correct, Postgres relationships are real, and the drawer navigation works end to end. |
| Phase 3 | Unit + integration + E2E + human verification | Rollback state/order is correct, transactions/cascades behave correctly in Postgres, and users can safely save/restore. Human gates remain mandatory. |
| Phase 4 | Full suite + package smoke test | The published CLI starts and accepts `--url`; optional Docker smoke test covers the self-hosted image. |

### Test ownership and file conventions

- **Unit:** `*.test.ts` beside the owning pure module or under `tests/unit/`. Test identifier quoting, keyset cursor encoding, metadata normalization, FK graph traversal, snapshot state transitions, diffing, and restore ordering without a database or browser.
- **Integration:** `tests/integration/**/*.test.ts`. Use a dedicated `$TEST_DATABASE_URL`, apply `tests/fixtures/seed.sql`, and clean up in a transaction or reset fixture. These tests may call `Bun.sql` and the Elysia app, but never `DATABASE_URL`. Cover catalog introspection, outgoing/incoming FKs, composite keys, cascades, transaction failure, and schema drift.
- **Component/UI:** `apps/web/**/*.test.tsx` with Bun's DOM preload and Happy DOM when the component layer exists. Test accessible roles, pending-change behavior, loading/error states, and drawer rendering without pretending this is a real browser.
- **E2E:** `tests/e2e/**/*.spec.ts` using a real browser runner (Playwright is the planned choice). Start the local server against a disposable test database, then cover table selection, row selection, FK drawer click-through, save failure, and restore. Keep this suite small and workflow-focused.
- **Type/API contract:** `*.test-d.ts` or a dedicated type-check fixture, verified by `tsc --noEmit`; use Bun's `expectTypeOf` only as an assertion helper because it is a runtime no-op.

### Bun test runner boundary

Bun's built-in `bun:test` runner is sufficient for unit tests, Postgres integration tests, Elysia request tests, snapshots, mocks, TypeScript/JSX, and React component tests when paired with Happy DOM. It also provides watch mode, retries, parametrized tests, preloads, and built-in coverage.

It is **not sufficient by itself for real browser E2E**: Bun's DOM support emulates browser APIs and does not replace a browser automation runner. Use Playwright for E2E and keep browser tests separate from `bun test`.

Recommended commands once each layer exists:

```
bun test tests/unit
bun test tests/integration
bun test apps/web --preload ./tests/setup/happydom.ts
bunx playwright test tests/e2e
bun test --coverage
```

The default CI gate is unit + integration + typecheck. Run E2E on changes to routes, API contracts, or UI workflows and before release. Set coverage thresholds only after meaningful code exists; do not use coverage percentage as a substitute for the rollback human gates.

## 7. AI agent skills for building this project

Given the plan assumes agent-assisted development (§6), it's worth equipping the agent with skills for this exact stack rather than relying on general training knowledge, which is often stale for fast-moving tools like Bun/Elysia/TanStack. Sourced from skills.sh and the maintainers' own repos/docs, preferring official (tool-maintainer-published) skills first, falling back to the most-adopted community option only where no official one exists.

| Area | Skill | Source | Why this one |
|---|---|---|---|
| Postgres | `postgres-best-practices` | **Official** — `supabase/agent-skills` (2.5K★, 362K installs) | Query performance, indexing, RLS, schema design, connection pooling — explicitly written to apply to any Postgres setup, not just Supabase-hosted ones. Directly feeds Phase 0/1 introspection and query design. |
| Bun runtime | Bun skills | **Official** — shipped in `oven-sh/bun` itself | Straight from Bun's own maintainers rather than a third-party writeup — lowest risk of stale/incorrect Bun-specific guidance (`Bun.serve()`, `Bun.sql`, `bun:sqlite` APIs move fast). |
| Elysia | `elysia` | **Official** — `elysiajs/skills` | Published by the Elysia org itself. Covers routing, TypeBox validation, Eden Treaty typed client, plugins — exactly the parts of §5's backend stack that benefit most from being current. |
| TanStack Table & Query | ships in-package | **Official, and stronger than skills.sh** — `@tanstack/react-table` / `@tanstack/react-query` via `@tanstack/intent` | TanStack now ships `SKILL.md` inside the npm packages themselves, versioned with the library. Install the package, run `npx @tanstack/intent@latest list`, and the agent loads guidance that's guaranteed to match your installed version — no separate skill to track or go stale. |
| Security / write-path review | `code-review` | **Official** — `anthropics/knowledge-work-plugins` | Anthropic's own review skill; explicitly audits SQL injection, auth flaws, and credential exposure. Point it at Phase 3's rollback/cascade/write-path code specifically — this is the phase where a review pass matters most (see §6's testing note). |
| React (general patterns) | `vercel-react-best-practices` | No official React/Meta skill exists; closest authority — `vercel-labs/agent-skills` | Vercel maintains skills.sh itself and is a major React ecosystem contributor. Covers re-renders, bundle size, server/client component boundaries — relevant even though this project's frontend is a Vite SPA, not Next.js. |
| Tailwind CSS | `tailwind-v4-shadcn` | No official Tailwind Labs skill exists (confirmed absent — maintainers were asked directly in a GitHub discussion); most-adopted community pick — `jezweb/claude-skills` | One of the more actively maintained, broadly cross-referenced community Tailwind v4 skills. Star/install rankings shift on skills.sh — worth a quick check at install time in case a better-adopted option has since appeared. |

**Install pattern** (via the `skills` CLI, works with `npx` or `bunx`):
```
bunx skills add supabase/agent-skills --skill postgres-best-practices
bunx skills add oven-sh/bun
bunx skills add elysiajs/skills --skill elysia
bunx skills add anthropics/knowledge-work-plugins --skill code-review
bunx skills add vercel-labs/agent-skills --skill vercel-react-best-practices
bunx skills add jezweb/claude-skills --skill tailwind-v4-shadcn
```
TanStack's skills need no `skills add` step — they arrive with `npm install @tanstack/react-table @tanstack/react-query` and are loaded via `npx @tanstack/intent@latest list` / `load`.

**Sequencing against the build plan:** install Postgres + Bun + Elysia skills before Phase 0 (they inform the introspection/server spike directly); TanStack's ship automatically once those packages land in Phase 1; pull in the `code-review` skill specifically for Phase 3, run it against the rollback/cascade code before calling that phase done, per the testing note in §6.

## 7a. Multi-tool setup — Cursor, VS Code (Copilot), and OpenCode

Since these three get used at separate times rather than simultaneously, the goal is **one shared source of truth plus thin per-tool wrappers**, not three parallel configs that drift out of sync.

**Single source of truth: `AGENTS.md` at the repo root.** This is now the vendor-neutral standard read natively by all three: Cursor discovers it automatically, VS Code's Copilot reads it directly, and OpenCode treats it as interchangeable with `CLAUDE.md` (first one found wins, so don't maintain both with different content). Put the project's real substance here — architecture, the no-ORM/raw-SQL decision, the FK-cascade and rollback design pointers, and the non-negotiables (parameterized queries only, snapshot-before-mutation always) — once, not per-tool.

```
/AGENTS.md                          # shared source of truth (all three read this)
/.cursor/rules/*.mdc                 # Cursor-only: glob-scoped rules, e.g. stricter rules for /apps/server/src/backup/**
/.github/copilot-instructions.md     # optional belt-and-suspenders for VS Code Copilot — Copilot reads AGENTS.md
                                      # directly, but has been observed truncating large instruction files under
                                      # heavy context load, so a short duplicate here is cheap insurance
/opencode.json                       # OpenCode-only: model choice, permission (allow/ask/deny) blocks
```

**Skills — install once, mostly reused.** The `skills` CLI auto-detects which agent it's running under and installs to the right directory, but since Claude Code's `.claude/skills/` is also read natively by OpenCode, running the install commands from §7 while in either Claude Code or OpenCode effectively covers both. For Cursor, run the same `bunx skills add ...` commands from inside Cursor once so its own resolver picks them up too — no separate skill content to maintain, just an extra install pass.

**Per-tool safety configuration (matters more here than usual, given the rollback system's whole job is recovering from a bad write):**
- **Cursor:** `.cursor/mcp.json` if connecting a Postgres MCP server for live introspection during development — point it at `$TEST_DATABASE_URL`, never the real one.
- **VS Code:** `.vscode/mcp.json` for the same MCP connection if using Copilot's agent mode; `.vscode/tasks.json` for one-click `bun run dev` / `bun test` / seed-db tasks so the workflow doesn't depend on remembering CLI commands.
- **OpenCode:** `opencode.json`'s `permission` block — set `bash` to `ask` (not blanket `allow`) for anything touching a real connection string, and keep `edit`/`bash` scoped to the repo. This is the one of the three with the most explicit, structured permission system, so it's worth being deliberate here rather than defaulting to allow-all.
- All three: none should ever have blanket shell-command allow rules that could run `DROP`/`TRUNCATE`/`DELETE` against `$DATABASE_URL` (as opposed to `$TEST_DATABASE_URL`) without a manual confirmation step — this is the same guardrail from the single-tool checklist, just needs setting three times instead of once.

**What NOT to do:** don't hand-write three divergent instruction files (a Cursor-specific `AGENTS.md`, a differently-worded `copilot-instructions.md`, a differently-worded `opencode.json` `instructions` field) — that's exactly the fragmentation AGENTS.md exists to avoid, and it's how a project ends up with a rule that's in `CLAUDE.md` but silently missing from whichever tool was added last.

## 8. Summary recommendation

1. You were wrong that Prisma Studio can't be used for .NET/Postgres projects — it can, standalone, via `--url`.
2. You were right that no tool gives you a clean, Prisma-Studio-grade UI with a **bidirectional** FK relationship view as the centerpiece — DBeaver has the capability but not the UX; everyone else has only forward navigation.
3. **Per-edit local rollback is also a genuine gap** — existing tools only offer whole-database dump/restore, not automatic before-image snapshots with one-click undo per mutation.
4. Build it as a **web app** (local server + browser SPA, CLI-launched), not Electron — lower cost, matches the Prisma Studio distribution model you're already used to, and leaves room for a self-hosted team mode later.
5. Stack: **Bun + Elysia (schema validation, typed API) + `Bun.sql` + `pg_catalog` introspection + `bun:sqlite` for the local backup log** on the backend, **React + Eden Treaty + TanStack Table/Query + Tailwind** on the frontend.
6. Sequence: prove the FK-direction SQL first (Phase 0), then build read-only Prisma-Studio-parity browsing (Phase 1), then ship the bidirectional FK drawer (Phase 2), then harden writes with the local rollback system as the flagship safety feature (Phase 3) — with agent-assisted coding, roughly **10–12 working days** total, though Phase 3 should be paced by testing confidence, not the calendar.
7. Equip the agent with official skills for each part of the stack (§7) before starting — Postgres, Bun, and Elysia skills are all genuinely maintainer-published, TanStack's ship inside the npm packages themselves, and Anthropic's own `code-review` skill should specifically gate Phase 3.
8. Since Cursor, VS Code, and OpenCode are all in rotation (§7a), keep one shared `AGENTS.md` as the source of truth rather than three drifting instruction files — all three read it natively, and installed skills carry over between Claude Code/OpenCode/Cursor without duplication.