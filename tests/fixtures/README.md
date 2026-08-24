# Test fixtures

- `seed.sql` — deterministic schema + data applied only to `$TEST_DATABASE_URL`.
  Covers: self-FK (`employees.manager_id`), composite PK/FK (`orders` ↔ `order_items`),
  cascade pair (`customers` ↔ `addresses`).
- `apply-seed.ts` — executes `seed.sql` on an open connection (`db.file`).

Reseed manually with `bun run seed:test-db`, or call `createSeededTestDb()` from
`tests/integration/helpers.ts` inside tests.
