/**
 * Real-Postgres suite for `_indigo_realtime_log` (`realtime-shape-log` PR A):
 * ordering, durability (failure -> teardown -> redelivery), and `db push`
 * idempotency / publication non-membership.
 *
 * Self-skips when `INDIGODB_TEST_DATABASE_URL` is unset (decision 14), same
 * pattern as `parity.mjs`/`resume.mjs`. Wired into the same `postgres` CI
 * lane via `package.json`'s `test` script.
 */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { renderPushSql, renderRealtimeLogSql, REALTIME_LOG_TABLE } from "@indigodb/migrator";
import { WalSource } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";
import { skipIfNoDatabase, withAdmin, withReplicationFixture } from "./pg-harness.mjs";

const url = skipIfNoDatabase("log.mjs");
if (!url) process.exit(0);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function schemaFor(table) {
  const base = testSchema();
  const post = base.tables.find((t) => t.name === "Post");
  return {
    ...base,
    tables: [
      {
        ...post,
        // Model name (== log `table_name`) unique per fixture: `_indigo_realtime_log`
        // is one shared table across every test in this file, never truncated
        // between fixtures (matches production — the log is persistent
        // bookkeeping), so a fixed "Post" name here would let one test's rows
        // leak into the next test's `WHERE table_name = ...` query.
        name: table,
        dbName: table,
        columns: [
          { name: "id", dbName: "id" },
          { name: "name", dbName: "name" },
          { name: "big", dbName: "big" },
        ],
        primaryKey: ["id"],
      },
    ],
  };
}

async function logRowsFor(admin, table) {
  const res = await admin.query(
    `SELECT id, lsn::text AS lsn, op, "new", buckets FROM "${REALTIME_LOG_TABLE}" ` +
      `WHERE table_name = $1 ORDER BY lsn, id`,
    [table],
  );
  return res.rows;
}

// ── A8.1 — ordering + batch granularity ─────────────────────────────────────

await check("ordering: 200 rows over interleaved single-row transactions reproduce commit order in the log (ORDER BY lsn, id)", async () => {
  await withReplicationFixture(url, "log_order", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });
    await source.start(
      (e) => events.push(e),
      (e) => console.error("onError", e.message),
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      for (let i = 1; i <= 200; i++) {
        await admin.query(`INSERT INTO "${table}" (name) VALUES ($1)`, [`row-${i}`]);
      }
    });
    await new Promise((r) => setTimeout(r, 2500));
    await source.stop();

    strictEqual(events.length, 200, `expected 200 dispatched events, got ${events.length}`);

    await withAdmin(url, async (admin) => {
      const rows = await logRowsFor(admin, table);
      strictEqual(rows.length, 200, `expected 200 log rows, got ${rows.length}`);
      const names = rows.map((r) => r.new.name);
      const expected = Array.from({ length: 200 }, (_, i) => `row-${i + 1}`);
      deepStrictEqual(names, expected, "reading the log in ORDER BY lsn, id must reproduce commit order");
      ok(
        rows.every((r) => r.buckets === null),
        "buckets must be NULL for every row in this PR",
      );
    });
  });
});

await check("batch granularity: one multi-row transaction writes N log rows sharing exactly one lsn", async () => {
  await withReplicationFixture(url, "log_batch", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });
    await source.start(
      (e) => events.push(e),
      (e) => console.error("onError", e.message),
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      await admin.query("BEGIN");
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('a')`);
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('b')`);
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('c')`);
      await admin.query("COMMIT");
    });
    await new Promise((r) => setTimeout(r, 1000));
    await source.stop();

    strictEqual(events.length, 3);

    await withAdmin(url, async (admin) => {
      const rows = await logRowsFor(admin, table);
      strictEqual(rows.length, 3);
      const lsns = new Set(rows.map((r) => r.lsn));
      strictEqual(lsns.size, 1, "all 3 rows of one transaction must share exactly one commit lsn");
    });
  });
});

// ── A8.2 — durability: a failed log write blocks ack, and is redelivered ──

await check("durability: log write failure (table dropped mid-stream) blocks ack; restoring the table redelivers the transaction on reconnect", async () => {
  await withReplicationFixture(url, "log_durability", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });
    // Force a short backoff ceiling so the test doesn't wait 1s+ needlessly.
    source["retryMs"] = 200;

    const errors = [];
    await source.start(
      (e) => events.push(e),
      (e) => errors.push(e.message),
    );
    await new Promise((r) => setTimeout(r, 300));

    // Drop the log table out from under the writer connection — the next
    // commit's INSERT must fail.
    await withAdmin(url, async (admin) => {
      await admin.query(`DROP TABLE "${REALTIME_LOG_TABLE}"`);
    });

    await withAdmin(url, async (admin) => {
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('lost-then-found')`);
    });

    // Give WalSource time to hit the failed insert, tear down, and start
    // backing off — but the table is still missing, so the first reconnect
    // attempt's writer will also fail to use it (CREATE happens next).
    await new Promise((r) => setTimeout(r, 500));
    strictEqual(events.length, 0, "no onEvent call for the failed transaction");
    // The exact error text depends on how the driver surfaces the failure
    // (a clean "relation does not exist", or the connection being reset
    // outright) — what design decision 2 actually requires is that SOME
    // onError fires and nothing dispatches, both asserted here and above.
    ok(errors.length > 0, `expected at least one onError call for the failed transaction, got none`);

    // Restore the table (production equivalent: `db push` / `migrate deploy`
    // re-creating it) — the next reconnect attempt's writer will succeed.
    // `renderRealtimeLogSql` only needs to know "at least one @@realtime
    // table exists" — a minimal stub is enough (WalSource's own `schemaFor`
    // stub above lacks the full column metadata `renderPushSql` would need).
    await withAdmin(url, async (admin) => {
      for (const stmt of renderRealtimeLogSql({ tables: [{ realtime: true }] })) {
        await admin.query(stmt);
      }
    });

    // Give the backoff-driven reconnect time to fire and redeliver.
    await new Promise((r) => setTimeout(r, 2000));
    await source.stop();

    strictEqual(events.length, 1, "the transaction must be redelivered exactly once after the table is restored and WalSource reconnects");
    strictEqual(events[0].new.name, "lost-then-found");

    await withAdmin(url, async (admin) => {
      const rows = await logRowsFor(admin, table);
      strictEqual(rows.length, 1, "exactly one log row for the redelivered transaction — no duplicate/partial write");
      strictEqual(rows[0].new.name, "lost-then-found");
    });
  });
});

// ── A8.3 — db push idempotency + no publication feedback loop (decision 14) ──

await check("db push idempotency: applying renderPushSql twice against a schema with @@realtime is a no-op; the log table never appears in the publication", async () => {
  const table = "LogPushIdemPost";
  await withAdmin(url, async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS "${table}"`);
  });
  try {
    // A full parse+resolve (not the WalSource-only column stub `schemaFor`
    // uses above) — `renderPushSql` needs real column types/nullability/etc,
    // which WalSource itself never reads.
    const schema = resolve(
      parse(`Table ${table} {\n  id Int @id @default(autoincrement())\n  name String\n\n  @@realtime\n}\n`),
    );
    // No explicit `slot` option here — this schema drives resolveSlotName()'s
    // default publication/slot ("indigo_realtime"), exactly what `db push`
    // itself would target; pg-harness's per-fixture `wal_test_*` names are a
    // separate, decoupled mechanism used by the other suites in this file.
    await withAdmin(url, async (admin) => {
      await admin.query(renderPushSql(schema));
      // Re-running must converge without error — the idempotency bar.
      await admin.query(renderPushSql(schema));

      const logTable = await admin.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [REALTIME_LOG_TABLE],
      );
      strictEqual(logTable.rows.length, 1, "_indigo_realtime_log must exist after push");

      const pubTables = await admin.query(
        `SELECT tablename FROM pg_publication_tables WHERE pubname = 'indigo_realtime'`,
      );
      ok(
        !pubTables.rows.some((r) => r.tablename === REALTIME_LOG_TABLE),
        "the log table must never appear in the realtime publication (decision 14 — no feedback loop)",
      );
    });
  } finally {
    await withAdmin(url, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    });
  }
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
