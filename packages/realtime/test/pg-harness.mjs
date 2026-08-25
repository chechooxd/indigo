/**
 * Real-Postgres lifecycle helper for the `WalSource` integration suites
 * (`parity.mjs`, `resume.mjs`). PGlite (used elsewhere in the monorepo) can't
 * do logical replication, so these suites need an actual server with
 * `wal_level=logical` — this module owns ONLY the mechanics of driving one.
 *
 * Gated on `INDIGODB_TEST_DATABASE_URL` (decision 14): unset → every
 * dependent suite self-skips with a printed notice instead of failing, so
 * `pnpm --filter @indigodb/realtime test` (and therefore the `ts` CI job,
 * which discovers this package's `test` script via Turbo) stays
 * Postgres-free. The `postgres` CI job (PR B) sets the variable and gets
 * full coverage.
 *
 * Local setup used to develop/verify this suite:
 *   docker run -d --name indigo-wal-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=indigo_test -p 55432:5432 postgres:17 \
 *     -c wal_level=logical -c max_replication_slots=4 -c max_wal_senders=4
 *   export INDIGODB_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/indigo_test
 */
import pg from "pg";
import { renderRealtimeLogSql } from "@indigodb/migrator";

export function testDatabaseUrl() {
  return process.env.INDIGODB_TEST_DATABASE_URL ?? null;
}

/** Skips the calling suite (exit 0, printed notice) when no real Postgres is configured. */
export function skipIfNoDatabase(suiteName) {
  const url = testDatabaseUrl();
  if (url) return url;
  console.log(
    `SKIP - ${suiteName}: INDIGODB_TEST_DATABASE_URL is unset — real-Postgres suite skipped ` +
      `(logical replication needs a real server; PGlite can't do it). Set the var, or see ` +
      `CI's \`postgres\` job for full coverage.`,
  );
  return null;
}

/** Runs `fn(client)` against a fresh admin connection, always closing it. */
export async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates an isolated table + slot + publication for one test run, tears
 * them down afterwards even on failure. `label` must be a valid identifier
 * fragment (lowercase/digits/underscore) — used verbatim in SQL, so callers
 * must not pass untrusted input.
 */
export async function withReplicationFixture(url, label, fn) {
  const table = `wal_test_${label}`;
  // Design decision 6: slot and publication share ONE name so the DDL side
  // and WalSource can never diverge. The fixture mirrors that on purpose.
  const slot = `wal_test_${label}`;
  const pub = slot;
  await withAdmin(url, async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    await admin.query(
      `CREATE TABLE "${table}" (id serial primary key, name text, big text)`,
    );
    await admin.query(`ALTER TABLE "${table}" REPLICA IDENTITY FULL`);
    await admin.query(
      `SELECT pg_create_logical_replication_slot('${slot}', 'pgoutput') ` +
        `WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}')`,
    );
    await admin.query(
      `DO $$ BEGIN CREATE PUBLICATION "${pub}" FOR TABLE "${table}"; ` +
        `EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    );
    // realtime-shape-log PR A: `WalSource` now writes every commit to
    // `_indigo_realtime_log` before dispatching, so any fixture that starts
    // a real `WalSource` needs the table to exist first — `db push`'s job in
    // production, done by hand here via the same renderer. Idempotent
    // (`CREATE TABLE IF NOT EXISTS`) and never dropped in teardown: it is
    // shared, persistent bookkeeping across fixtures/suites, exactly like
    // production.
    for (const stmt of renderRealtimeLogSql({ tables: [{ realtime: true }] })) {
      await admin.query(stmt);
    }
  });

  try {
    await fn({ table, slot, pub });
  } finally {
    await withAdmin(url, async (admin) => {
      await admin.query(`DROP PUBLICATION IF EXISTS "${pub}"`);
      const slotRow = await admin.query(
        `SELECT active FROM pg_replication_slots WHERE slot_name = '${slot}'`,
      );
      if (slotRow.rows[0]?.active) {
        await admin.query(`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${slot}'`).catch(() => {});
      }
      await admin.query(`SELECT pg_drop_replication_slot('${slot}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}')`).catch(() => {});
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Run directly: prove the harness itself works (or self-skips cleanly).
  const url = skipIfNoDatabase("pg-harness.mjs");
  if (url) {
    await withReplicationFixture(url, "harness_selftest", async ({ table }) => {
      await withAdmin(url, async (admin) => {
        await admin.query(`INSERT INTO "${table}" (name) VALUES ('ok')`);
      });
      console.log(`ok - harness self-test: fixture created/inserted/torn down for "${table}"`);
    });
  }
}
