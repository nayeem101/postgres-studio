import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysiajs/eden";
import { createSeededTestDb, requireTestDatabaseUrl } from "./helpers";
import { createServerApp, connectionIdFromUrl } from "../../apps/server/src/server-app";
import { BackupStore } from "../../apps/server/src/backup";

let db: SQL;
let app: ReturnType<typeof createServerApp>;
let api: ReturnType<typeof treaty<ReturnType<typeof createServerApp>>>;
let backupDir: string;
let recentsFile: string;

const urlA = requireTestDatabaseUrl();
// Same physical database, different URL string -> distinct connection id.
const urlB = `${urlA}?application_name=pg-studio-switch-test`;
const idA = connectionIdFromUrl(urlA);
const idB = connectionIdFromUrl(urlB);

beforeAll(async () => {
  db = await createSeededTestDb();
  backupDir = mkdtempSync(join(tmpdir(), "pg-studio-backups-"));
  recentsFile = join(backupDir, "recent.json");
  app = createServerApp({ databaseUrl: urlA, backupDir, recentsFile });
  api = treaty(app);
});

afterAll(async () => {
  if ((app as unknown as { server?: unknown }).server) await app.stop(true);
  await db.close();
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {
    // Windows may hold WAL locks momentarily after close; temp dir cleanup is best-effort.
  }
});

describe("connection management", () => {
  test("switching connections keeps rollback stores isolated per connection", async () => {
    // Batch 1 lands in connection A's store.
    const saveA = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save.post({
      updates: [],
      deletes: [{ pkValues: [3] }],
      inserts: [],
    });
    expect(saveA.error).toBeNull();

    // Switch to B; the live database handle changes identity.
    const switched = await api.api.connections.post({ url: urlB });
    expect(switched.error).toBeNull();
    expect(switched.data!.current.id).toBe(idB);

    const tables = await api.api.tables.get();
    expect(tables.data!.tables.length).toBeGreaterThan(0); // new handle is live

    // Batch 2 must land in connection B's store.
    const saveB = await api.api.schemas({ schema: "public" }).tables({ table: "employees" }).save.post({
      updates: [],
      deletes: [],
      inserts: [{ values: { id: 60, name: "After Switch" } }],
    });
    expect(saveB.error).toBeNull();
    expect(saveB.data!.batchId).toBeDefined();

    // Open A's sqlite file directly: it must hold ONLY connection A's batch.
    const storeA = BackupStore.open(join(backupDir, `${idA}.sqlite`));
    try {
      const batchesA = storeA.listRestorableBatches();
      expect(batchesA).toHaveLength(1);
    } finally {
      storeA.close();
    }

    // History through the API now reflects B's store only.
    const history = await api.api.history.batches.get();
    expect(history.data!.batches).toHaveLength(1);
    expect(history.data!.batches[0]!.connectionId).toBe(idB);

    // Recents track both connections, redacted over the wire.
    const conns = await api.api.connections.get();
    expect(conns.data!.recents.map(r => r.id)).toContain(idA);
    expect(conns.data!.recents.map(r => r.id)).toContain(idB);
    expect(conns.data!.current.url).toContain("***");
  });

  test("rejects non-postgres URLs", async () => {
    const res = await api.api.connections.post({ url: "http://example.com/db" });
    expect(res.error?.status).toBe(400);
  });

  test("switching back to the same URL is a no-op", async () => {
    const res = await api.api.connections.post({ url: urlB });
    expect(res.data!.current.id).toBe(idB);
  });
});
