/**
 * Real-Postgres parity suite (A7.2): the same INSERT/UPDATE/DELETE script
 * drives `PgNotifySource` (with its NOTIFY trigger DDL applied by hand —
 * the migrator DDL renderers land in PR B) and `WalSource`, and asserts the
 * emitted `RealtimeEvent`s are deep-equal after masking `ts`/`txid` (whose
 * exact values legitimately differ between the two transports — decisions
 * 9/10). Also proves decision 8's parity bar: full `old` on UPDATE/DELETE
 * under `REPLICA IDENTITY FULL`, and no `partial: true` truncation on a
 * >8000-byte column (the v1 NOTIFY payload-size limit `WalSource` removes).
 *
 * Self-skips when `INDIGODB_TEST_DATABASE_URL` is unset (decision 14).
 */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { WalSource, PgNotifySource } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";
import { skipIfNoDatabase, withAdmin, withReplicationFixture } from "./pg-harness.mjs";

const url = skipIfNoDatabase("parity.mjs");
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

/** Minimal single-table ResolvedSchema pointed at the harness's per-run table name. */
function schemaFor(table) {
  const base = testSchema();
  const post = base.tables.find((t) => t.name === "Post");
  return {
    ...base,
    tables: [
      {
        ...post,
        name: "Post",
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

/** v1 trigger DDL, applied by hand (PR B renders this from the schema instead). */
const NOTIFY_FUNCTION = `
CREATE OR REPLACE FUNCTION indigo_notify_trigger() RETURNS trigger AS $$
DECLARE
  payload json;
BEGIN
  payload = json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'pk', CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD)->'id' ELSE row_to_json(NEW)->'id' END,
    'new', CASE WHEN TG_OP != 'DELETE' THEN row_to_json(NEW) ELSE NULL END,
    'old', CASE WHEN TG_OP != 'INSERT' THEN row_to_json(OLD) ELSE NULL END,
    'txid', txid_current()::text,
    'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  PERFORM pg_notify('indigo_events', json_build_object(
    'table', TG_TABLE_NAME, 'op', TG_OP,
    'pk', json_build_object('id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END),
    'new', CASE WHEN TG_OP != 'DELETE' THEN row_to_json(NEW) ELSE NULL END,
    'old', CASE WHEN TG_OP != 'INSERT' THEN row_to_json(OLD) ELSE NULL END,
    'txid', txid_current()::text,
    'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`;

function maskVolatile(events) {
  return events
    // `lsn` is masked too: `WalSource` populates it (realtime-shape-log
    // design), `PgNotifySource` never does — an additive, source-specific
    // field, not a parity violation (asserted directly below).
    .map((e) => ({ ...e, ts: undefined, txid: undefined, lsn: undefined }))
    .sort((a, b) => (a.pk.id ?? 0) - (b.pk.id ?? 0) || a.op.localeCompare(b.op));
}

await check("parity: insert/update/delete emit deep-equal events (masking ts/txid)", async () => {
  await withReplicationFixture(url, "parity_basic", async ({ table, slot, pub }) => {
    const schema = schemaFor(table);

    await withAdmin(url, async (admin) => {
      await admin.query(NOTIFY_FUNCTION);
      await admin.query(
        `CREATE TRIGGER indigo_rt_${table} AFTER INSERT OR UPDATE OR DELETE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION indigo_notify_trigger()`,
      );
    });

    const notifyEvents = [];
    const walEvents = [];
    const notifySource = new PgNotifySource(url, schema);
    const walSource = new WalSource(url, schema, { slot });

    await notifySource.start(
      (e) => notifyEvents.push(e),
      (e) => console.error("notify onError", e),
    );
    await walSource.start(
      (e) => walEvents.push(e),
      (e) => console.error("wal onError", e),
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      await admin.query(`INSERT INTO "${table}" (name, big) VALUES ('a', 'x')`);
      await admin.query(`UPDATE "${table}" SET name = 'b' WHERE name = 'a'`);
      await admin.query(`DELETE FROM "${table}" WHERE name = 'b'`);
    });

    await new Promise((r) => setTimeout(r, 800));
    await notifySource.stop();
    await walSource.stop();
    await withAdmin(url, async (admin) => {
      await admin.query(`DROP TRIGGER IF EXISTS indigo_rt_${table} ON "${table}"`);
    });

    strictEqual(notifyEvents.length, 3, `expected 3 NOTIFY events, got ${notifyEvents.length}`);
    strictEqual(walEvents.length, 3, `expected 3 WAL events, got ${walEvents.length}`);
    deepStrictEqual(maskVolatile(walEvents), maskVolatile(notifyEvents));

    const update = walEvents.find((e) => e.op === "UPDATE");
    ok(update.old && update.old.name === "a", "UPDATE old must carry the full pre-image, not just pk");
    const del = walEvents.find((e) => e.op === "DELETE");
    ok(del.old && del.old.name === "b", "DELETE old must carry the full pre-image");

    // realtime-shape-log design / realtime-wal-source delta: WalSource events
    // carry `lsn` (an "X/Y" hex string); PgNotifySource omits it — additive,
    // not a parity violation (masked out above precisely so the deep-equal
    // check doesn't treat this legitimate difference as a mismatch).
    ok(
      walEvents.every((e) => typeof e.lsn === "string" && /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(e.lsn)),
      "every WalSource event must carry an X/Y hex lsn",
    );
    ok(
      notifyEvents.every((e) => e.lsn === undefined),
      "PgNotifySource must never populate lsn",
    );
  });
});

await check("parity: no partial truncation on a >8000-byte column", async () => {
  await withReplicationFixture(url, "parity_large", async ({ table, slot }) => {
    const schema = schemaFor(table);
    const bigValue = "x".repeat(1024 * 1024); // 1 MB, well past NOTIFY's 8000-byte limit

    const walEvents = [];
    const walSource = new WalSource(url, schema, { slot });
    await walSource.start(
      (e) => walEvents.push(e),
      (e) => console.error("wal onError", e),
    );
    await new Promise((r) => setTimeout(r, 300));

    await withAdmin(url, async (admin) => {
      await admin.query(`INSERT INTO "${table}" (name, big) VALUES ('big', $1)`, [bigValue]);
    });
    await new Promise((r) => setTimeout(r, 800));
    await walSource.stop();

    strictEqual(walEvents.length, 1);
    strictEqual(walEvents[0].partial, undefined);
    strictEqual(walEvents[0].new.big.length, bigValue.length);
  });
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
