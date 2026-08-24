# Integration tests

Run with `bun test tests/integration`. Requires `$TEST_DATABASE_URL` (see `.env.example`);
agents must only ever point it at a disposable database. Seed fixture: [`../fixtures/seed.sql`](../fixtures/seed.sql),
applied by `tests/fixtures/apply-seed.ts` via `createSeededTestDb()` from `helpers.ts`.

Manual reseed: `bun run seed:test-db`.
