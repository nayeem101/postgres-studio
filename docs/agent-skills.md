# Agent skills

Project-local skills live in `.agents/skills/` (Cursor / Copilot / shared) and `.claude/skills/` (Claude Code + OpenCode). Restore with `bunx skills experimental_install` from [`skills-lock.json`](../skills-lock.json).

Re-install for this repo:

```
bunx skills add supabase/agent-skills --skill supabase-postgres-best-practices -y --copy -a cursor -a claude-code -a opencode -a github-copilot
bunx skills add elysiajs/skills --skill elysiajs -y --copy -a cursor -a claude-code -a opencode -a github-copilot
bunx skills add anthropics/knowledge-work-plugins --skill code-review -y --copy -a cursor -a claude-code -a opencode -a github-copilot
bunx skills add vercel-labs/agent-skills --skill vercel-react-best-practices -y --copy -a cursor -a claude-code -a opencode -a github-copilot
bunx skills add jezweb/claude-skills --skill tailwind-theme-builder -y --copy -a cursor -a claude-code -a opencode -a github-copilot
bunx skills add jarle/bun-skills --skill "Bun SQL" --skill "Bun SQLite" --skill "Bun Server" --skill "Bun Routing" --skill "Bun Workspaces" --skill "Bun Configuring a monorepo using workspaces" --skill "Bun Parse command-line arguments" --skill "Bun Environment Variables" --skill "Bun Writing tests" --skill "Bun TypeScript" -y --copy -a cursor -a claude-code -a opencode -a github-copilot
```

## Installed

| Area | Skill | Source | When to load |
|---|---|---|---|
| Postgres | `supabase-postgres-best-practices` | Official — `supabase/agent-skills` | Before introspection, catalog SQL, indexes, pooling, RLS, or query performance work (Phase 0–1, any later SQL). |
| Elysia | `elysiajs` | Official — `elysiajs/skills` | Routes, TypeBox, plugins, Eden Treaty (Phase 0–1). |
| Write-path review | `code-review` | Official — `anthropics/knowledge-work-plugins` | **Phase 3 gate.** Run against rollback, cascade snapshotting, and mutation SQL before marking Phase 3 done. |
| React | `vercel-react-best-practices` | `vercel-labs/agent-skills` (no official Meta skill) | SPA rendering, re-renders, bundle size. Ignore Next.js server-component bits that do not apply. |
| Tailwind v4 | `tailwind-theme-builder` | Community — `jezweb/claude-skills` | Tailwind v4 `@theme` setup. Plan named `tailwind-v4-shadcn`; that skill is no longer in the jezweb listing — this is the current v4 skill in that repo. |
| Bun.sql | `bun-sql` | Community docs pack — `jarle/bun-skills` | Tagged-template Postgres access. |
| bun:sqlite | `bun-sqlite` | `jarle/bun-skills` | Local rollback store. |
| Bun.serve | `bun-server`, `bun-routing` | `jarle/bun-skills` | Understand what Elysia sits on; prefer `elysiajs` for actual routes. |
| Workspaces | `bun-workspaces`, `bun-configuring-a-monorepo-using-workspaces` | `jarle/bun-skills` | Root `package.json` workspaces. |
| CLI / env / tests | `bun-parse-command-line-arguments`, `bun-environment-variables`, `bun-writing-tests`, `bun-typescript` | `jarle/bun-skills` | Phase 0 CLI spike and `bun test`. |
| Browser E2E | `@playwright/test` (project-local) | Microsoft Playwright | `tests/e2e/**/*.spec.ts`; run with `bun run test:e2e`. |
| Agent browser control | `playwright-mcp` (global) | Microsoft Playwright MCP | Cursor/VS Code browser exploration and E2E debugging; configured in `.cursor/mcp.json` and `.vscode/mcp.json`. |
| Agent CLI | `playwright-cli` (global) | Microsoft Playwright CLI | Token-efficient browser interaction and code-generation workflows. |

## Not installed (and why)

- **`oven-sh/bun` official skills** are Bun *contributor* guides (JSC, Rust, bundler internals). They are not app-runtime guidance. Do not load them for this product.
- **TanStack Table / Query** ship `SKILL.md` inside the npm packages. After Phase 1 installs those packages: `npx @tanstack/intent@latest list` then `load`. No `skills add` step.
- **Database MCP** is not configured yet. When added, `.cursor/mcp.json` and `.vscode/mcp.json` must point at `$TEST_DATABASE_URL` only.
- **Playwright MCP** is configured for local browser testing only (`localhost`, `127.0.0.1`, headless Chrome). It does not receive database credentials.

## Playwright setup

The project pins `@playwright/test` in the root dev dependencies and uses `playwright.config.ts` for the E2E test directory, local server startup, Chromium project, retries, traces, screenshots, and HTML reports. Install/update the browser with:

```
bun run playwright:install
```

Global tools installed for agent workflows:

```
playwright-cli --version
playwright-mcp --help
```

Run the suite after the Phase 1 local server and SPA exist:

```
bun run test:e2e
bun run test:e2e:ui
```

## Phase gates

- **Before Phase 0:** Postgres + Elysia + Bun.sql / CLI / SQLite skills.
- **Phase 1 UI:** TanStack intent skills + React + Tailwind.
- **Before Phase 3 complete:** `code-review` on `packages/db` mutations and `apps/server` backup/rollback. Human tests still required (see `docs/progress.md`).
