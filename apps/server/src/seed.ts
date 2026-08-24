import { SQL } from "bun";
import { applySeed, requireTestDatabaseUrl } from "../../../tests/fixtures/apply-seed";

const testUrl = requireTestDatabaseUrl();

if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
  console.error(
    "Refusing to seed: TEST_DATABASE_URL is identical to DATABASE_URL. Point TEST_DATABASE_URL at a disposable database.",
  );
  process.exit(1);
}

const db = new SQL(testUrl);
try {
  await applySeed(db);
  const [{ count }] = await db`select count(*)::int as count from public.employees`;
  console.log(`Seeded ${testUrl.replace(/:[^:@/]+@/, ":***@")} (employees=${count})`);
} finally {
  await db.close();
}
