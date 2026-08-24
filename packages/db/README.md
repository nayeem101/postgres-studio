# `@pg-studio/db`

Raw SQL against Postgres (`Bun.sql`). Owns:

- connection from a URL
- `pg_catalog` / `information_schema` introspection
- keyset row reads
- parameterized mutations used by the rollback two-phase flow

Apps must not open their own catalog/mutation connections.
