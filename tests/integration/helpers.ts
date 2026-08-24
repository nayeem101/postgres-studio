import { SQL } from "bun";
import { applySeed, requireTestDatabaseUrl } from "../fixtures/apply-seed";

/**
 * Open a connection to $TEST_DATABASE_URL and (re)apply the seed fixture.
 * Caller owns the connection and must `await db.close()`.
 */
export async function createSeededTestDb(): Promise<SQL> {
  const db = new SQL(requireTestDatabaseUrl(), { max: 4, idleTimeout: 20 });
  await applySeed(db);
  return db;
}

export { applySeed, requireTestDatabaseUrl };
