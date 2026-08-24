/**
 * Real-Postgres resume/ordering suite (A7.3/A7.4) — the bug this slice
 * exists to fix: `PgNotifySource` loses every NOTIFY delivered while
 * disconnected. `WalSource` must resume from the replication slot's
 * confirmed LSN instead.
 *
 * Self-skips when `INDIGODB_TEST_DATABASE_URL` is unset (decision 14).
 */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { WalSource } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";
import { skipIfNoDatabase, withAdmin, withReplicationFixture } from "./pg-harness.mjs";

const url = skipIfNoDatabase("resume.mjs");
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
      { ...post, name: "Post", dbName: table, columns: [
        { name: "id", dbName: "id" },
        { name: "name", dbName: "name" },
        { name: "big", dbName: "big" },
      ], primaryKey: ["id"] },
    ],
  };
}

await check("resume: stop(), commit N rows, start() → all N arrive in commit order", async () => {
  await withReplicationFixture(url, "resume_gap", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });

    await source.start(
      (e) => events.push(e),
      (e) => console.error("onError", e.message),
    );
    await new Promise((r) => setTimeout(r, 300));
    await source.stop();

    // Committed entirely while the source is stopped — this is exactly the
    // NOTIFY-era loss window.
    await withAdmin(url, async (admin) => {
      for (let i = 1; i <= 5; i++) {
        await admin.query(`INSERT INTO "${table}" (name) VALUES ($1)`, [`gap-${i}`]);
      }
    });

    const resumed = [];
    await source.start(
      (e) => resumed.push(e),
      (e) => console.error("onError(resume)", e.message),
    );
    await new Promise((r) => setTimeout(r, 1000));
    await source.stop();

    strictEqual(resumed.length, 5, `expected all 5 gap rows delivered on resume, got ${resumed.length}`);
    deepStrictEqual(resumed.map((e) => e.new.name), ["gap-1", "gap-2", "gap-3", "gap-4", "gap-5"]);
    strictEqual(events.length, 0, "nothing should have arrived while stopped");
  });
});

await check("resume: pg_terminate_backend mid-stream → backoff resumes without gaps", async () => {
  await withReplicationFixture(url, "resume_kill", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });
    // Force a short backoff ceiling for the test so it doesn't wait 30s.
    source["retryMs"] = 200;

    await source.start(
      (e) => events.push(e),
      () => {},
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('before-kill')`);
    });
    await new Promise((r) => setTimeout(r, 500));

    // Kill the replication backend server-side.
    await withAdmin(url, async (admin) => {
      await admin.query(
        `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = $1 AND active`,
        [slot],
      );
    });

    // Give WalSource time to notice, back off, and reconnect.
    await new Promise((r) => setTimeout(r, 2000));

    await withAdmin(url, async (admin) => {
      await admin.query(`INSERT INTO "${table}" (name) VALUES ('after-kill')`);
    });
    await new Promise((r) => setTimeout(r, 1500));
    await source.stop();

    const names = events.map((e) => e.new?.name).filter(Boolean);
    ok(names.includes("before-kill"), `expected before-kill in ${JSON.stringify(names)}`);
    ok(names.includes("after-kill"), `expected after-kill (post-reconnect) in ${JSON.stringify(names)}`);
  });
});

await check("ordering: 200 rows across interleaved transactions arrive in commit order", async () => {
  await withReplicationFixture(url, "resume_order", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const events = [];
    const source = new WalSource(url, schema, { slot });
    await source.start(
      (e) => events.push(e),
      (e) => console.error("onError", e.message),
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      // 200 single-row transactions, interleaved with a second table's
      // (non-realtime) writes to prove ordering isn't accidentally table-scoped.
      for (let i = 1; i <= 200; i++) {
        await admin.query(`INSERT INTO "${table}" (name) VALUES ($1)`, [`row-${i}`]);
      }
    });
    await new Promise((r) => setTimeout(r, 2000));
    await source.stop();

    strictEqual(events.length, 200, `expected 200 events, got ${events.length}`);
    const expected = Array.from({ length: 200 }, (_, i) => `row-${i + 1}`);
    deepStrictEqual(events.map((e) => e.new.name), expected);
  });
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
