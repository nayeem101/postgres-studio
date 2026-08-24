# Agentic workflow

One loop for Cursor, VS Code Copilot, and OpenCode. Architecture lives in [`AGENTS.md`](../AGENTS.md). Task state lives in [`docs/progress.md`](progress.md).

## Loop

1. **Select** the next unchecked task in `docs/progress.md` (do not skip human-gate tasks).
2. **Read** `AGENTS.md`, the matching `.cursor/rules/*.mdc`, and skills listed for that phase in [`docs/agent-skills.md`](agent-skills.md).
3. **Slice** the smallest change that can be verified (one query, one route, one UI panel).
4. **Implement** in the owning package (`packages/db` for SQL, `apps/server` for HTTP, `apps/web` for UI, `packages/api` for the Elysia `app` export).
5. **Write and check tests using the matching layer:** unit tests for deterministic logic, integration tests for real Postgres/Elysia behavior, component tests for React with Happy DOM, and Playwright E2E tests for real browser workflows. Run the narrowest relevant command first, then the default CI gate (`bun test` unit + integration and `bun run typecheck`).
6. **Update the tracker** in the same change: checkbox, date, evidence command, notes, follow-ups.
7. **Stop** at write-path safety gates. Do not auto-advance Phase 3 cascade/rollback tasks after generating code.

## Test conventions

Use Bun's built-in `bun:test` for `*.test.ts` and `*.test.tsx` files:

- `tests/unit/` or beside pure source modules: no database, filesystem, network, or browser. Test SQL builders, identifier allowlists, metadata transforms, cursor logic, FK graph traversal, snapshot state transitions, and restore ordering.
- `tests/integration/`: real `$TEST_DATABASE_URL`, seeded by `tests/fixtures/seed.sql`. Test `pg_catalog` introspection, FK behavior, transactions, cascades, and schema drift. Never use `$DATABASE_URL`.
- `apps/web/**/*.test.tsx`: component tests with a Happy DOM preload. Assert user-visible behavior and accessible roles; reset DOM state with cleanup.
- `tests/e2e/**/*.spec.ts`: Playwright only, against a disposable test database and local server. Keep these few and workflow-level: load table, select row, open both FK directions, save failure, restore.
- `*.test-d.ts` or type fixtures: run `tsc --noEmit`; `expectTypeOf` helps express assertions but does not replace the type checker.

Bun covers unit, integration, request, snapshot, mock, TypeScript/JSX, and Happy DOM component tests. It does not provide a real browser for E2E, so Playwright remains required for browser workflows. Do not add a second test framework for the layers Bun already covers.

Use descriptive names, `describe` by feature, explicit error-path assertions, `beforeEach`/`afterEach` cleanup, and assertion counting for complex async tests. Do not hide failures with `test.skip`, `test.todo`, or retries; use them only with a tracker note. Run coverage with `bun test --coverage` after meaningful code exists, but treat coverage as a signal rather than proof of rollback correctness.

## Tracker update convention

When completing a task, edit its row in `docs/progress.md`:

- `[x]` plus **Done:** `YYYY-MM-DD`
- **Evidence:** exact command and outcome (pass/fail, not “looks good”)
- **Notes:** caveats, skipped edges, follow-ups

Do not mark a task done because an agent wrote files. Generated code without a recorded check stays `[ ]`.

If work is blocked, leave `[ ]` and add **Blocked:** with the reason.

## Safety

- Agents may only mutate `$TEST_DATABASE_URL`.
- OpenCode: `opencode.json` sets `bash` to `ask`. Do not switch it to blanket `allow` for shell that can hit `$DATABASE_URL`.
- No MCP against a production connection string.

## Human verification (mandatory)

These cannot be closed by agent tests alone:

- Cascading deletes: snapshot order and restore order (parents before children on restore).
- Composite primary/foreign keys.
- Failed mid-batch restore (Postgres transaction must fully abort; SQLite snapshot statuses stay consistent).
- Schema drift between snapshot and restore (clear error, no silent partial restore).
