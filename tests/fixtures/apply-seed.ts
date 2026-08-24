import type { SQL } from "bun";

const SEED_PATH = `${import.meta.dir}/seed.sql`;

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL must be set (copy .env.example). Integration tests never touch DATABASE_URL.",
    );
  }
  return url;
}

/**
 * Apply the deterministic fixture to an open test-database connection.
 * The seed file is a static repo asset with no parameters, so the
 * multi-statement file API is safe here. Never call this with anything
 * but $TEST_DATABASE_URL.
 */
export async function applySeed(db: SQL): Promise<void> {
  await db.file(SEED_PATH);
}
