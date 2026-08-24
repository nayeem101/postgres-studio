# Copilot — Postgres Studio

Follow root `AGENTS.md`. That file is the source of truth.

Short reminders if `AGENTS.md` is truncated in context:

- Raw parameterized SQL only (`Bun.sql`). No ORM. Driver isolated in `packages/db`.
- Snapshot before every mutation; History must not offer failed snapshots as restore.
- Agents use `$TEST_DATABASE_URL` only — never destructive SQL on `$DATABASE_URL` without a human.
- Work the next task in `docs/progress.md`. Do not mark done without evidence.
- Layout: `apps/server`, `apps/web`, `packages/api` (Eden Treaty), `packages/db`, `packages/config`.
