/**
 * `WalSource` unit tests (no DB): constructor/model-map, `translate`-level
 * decoding, `txid`/`ts` semantics, and slot-name resolution. Real-Postgres
 * integration coverage (parity/resume/ordering) lives in `parity.mjs` /
 * `resume.mjs`, gated by `pg-harness.mjs` per decision 14.
 *
 * `WalSource` decodes pgoutput messages through a private `handleMessage`
 * method, so these tests drive it the same way `LogicalReplicationService`
 * would: by injecting `Pgoutput.Message`-shaped objects and observing
 * `onEvent`/`onError`. `handleMessage` is invoked via the public surface by
 * reaching into the instance (`source["handleMessage"]`) rather than adding
 * a test-only export — the production interface (`RealtimeSource`) stays
 * exactly `start`/`stop`/`models`, matching `PgNotifySource`.
 */
import { deepStrictEqual, strictEqual, throws, ok } from "node:assert";
import { WalSource, resolveSlotName } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function relation(name, columns, replicaIdentity = "full") {
  return {
    tag: "relation",
    relationOid: 1,
    schema: "public",
    name,
    replicaIdentity,
    columns: columns.map((c) => ({ name: c, flags: 1, typeOid: 0, typeMod: -1, typeSchema: null, typeName: null, parser: (v) => v })),
    keyColumns: columns, // pgoutput marks every column "key" under REPLICA IDENTITY FULL
  };
}

function newSource() {
  const source = new WalSource("postgres://unused/db", testSchema());
  const events = [];
  const errors = [];
  const onEvent = (e) => events.push(e);
  const onError = (e) => errors.push(e);
  return { source, events, errors, onEvent, onError };
}

function drive(source, messages, onEvent, onError) {
  for (const m of messages) {
    source["handleMessage"](m, onEvent, onError);
  }
}

// ── A1.1 — constructor / model map ──────────────────────────────────────
check("constructor builds the model map from @@realtime tables only", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  deepStrictEqual(source.models.sort(), ["Comment", "Post"]);
});

// ── A2.1 — translate(): insert/update/delete parity + unknown table drop ──
check("insert parity: table/op/pk/new, translated to schema names", () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "hi", body_text: "hello" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].table, "Post");
  deepStrictEqual(events[0].op, "INSERT");
  deepStrictEqual(events[0].pk, { id: 1 });
  deepStrictEqual(events[0].new, { id: 1, title: "hi", body: "hello" });
  strictEqual(events[0].old, undefined);
});

check("update: full old tuple parity (REPLICA IDENTITY FULL)", () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 2 },
      {
        tag: "update",
        relation: rel,
        key: null,
        old: { id: 1, title: "hi", body_text: "hello" },
        new: { id: 1, title: "hi2", body_text: "hello" },
      },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].old, { id: 1, title: "hi", body: "hello" });
  deepStrictEqual(events[0].new, { id: 1, title: "hi2", body: "hello" });
  deepStrictEqual(events[0].pk, { id: 1 });
});

check("delete: pk derived from schema primaryKey, not wire keyColumns", () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 3 },
      { tag: "delete", relation: rel, key: null, old: { id: 5, title: "x", body_text: "y" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].pk, { id: 5 });
  deepStrictEqual(events[0].old, { id: 5, title: "x", body: "y" });
  strictEqual(events[0].new, undefined);
});

check("change on a non-@@realtime table is dropped silently", () => {
  const { source, events, errors, onEvent, onError } = newSource();
  const rel = relation("Draft", ["id", "title"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 4 },
      { tag: "insert", relation: rel, new: { id: 1, title: "x" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 0);
  strictEqual(errors.length, 0);
});

check("relation not tracked by the schema at all (unpublished) is dropped, not fatal", () => {
  const { source, events, errors, onEvent, onError } = newSource();
  const rel = relation("Ghost", ["id"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 5 },
      { tag: "insert", relation: rel, new: { id: 1 } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 0);
  strictEqual(errors.length, 0);
});

// ── A2.2 — malformed/unrecognized messages route through onError ──────────
check("unrecognized message tag routes through onError, does not throw", () => {
  const { source, events, errors, onEvent, onError } = newSource();
  drive(source, [{ tag: "future_tag_v99" }], onEvent, onError);
  strictEqual(events.length, 0);
  strictEqual(errors.length, 1);
  ok(errors[0] instanceof Error);
  ok(/future_tag_v99/.test(errors[0].message));
});

check("valid-but-inert protocol messages (relation/message/origin/truncate/type) are not errors", () => {
  const { source, events, errors, onEvent, onError } = newSource();
  drive(
    source,
    [
      relation("Post", ["id"]),
      { tag: "message", flags: 0, transactional: false, messageLsn: null, prefix: "p", content: new Uint8Array() },
      { tag: "origin", originLsn: null, originName: "o" },
      { tag: "truncate", cascade: false, restartIdentity: false, relations: [] },
      { tag: "type", typeOid: 1, typeSchema: "pg_catalog", typeName: "int4" },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 0);
  strictEqual(errors.length, 0);
});

// ── A3 — txid/ts semantics ────────────────────────────────────────────────
check("txid = decimal xid from begin; ts = commit timestamp, ISO with ms", () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  // 2024-01-01T00:00:00.500Z in microseconds since Unix epoch:
  const commitTime = BigInt(Date.parse("2024-01-01T00:00:00.500Z")) * 1000n;
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 424242 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "insert", relation: rel, new: { id: 2, title: "t2", body_text: "b2" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 2);
  for (const e of events) {
    strictEqual(e.txid, "424242");
    strictEqual(e.ts, "2024-01-01T00:00:00.500Z");
  }
});

check("every row event of the same transaction shares txid/ts", () => {
  const { source, events, onEvent, onError } = newSource();
  const relPost = relation("Post", ["id", "title", "body_text"]);
  const relComment = relation("Comment", ["id", "post_id", "text"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 7 },
      { tag: "insert", relation: relPost, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "insert", relation: relComment, new: { id: 1, post_id: 1, text: "c" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  strictEqual(events.length, 2);
  strictEqual(events[0].txid, events[1].txid);
  strictEqual(events[0].ts, events[1].ts);
  deepStrictEqual(events.map((e) => e.table), ["Post", "Comment"]);
});

// ── A5 — acknowledgement fires only after every row is dispatched ─────────
check("acknowledge is called with the commit LSN only after every row is dispatched", () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const order = [];
  source["service"] = {
    acknowledge: async (lsn) => {
      order.push(`ack:${lsn}`);
      return true;
    },
  };
  const wrappedOnEvent = (e) => {
    order.push(`dispatch:${e.pk.id}`);
    onEvent(e);
  };
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 9 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "insert", relation: rel, new: { id: 2, title: "t2", body_text: "b2" } },
      { tag: "commit", flags: 0, commitLsn: "0/99", commitEndLsn: "0/100", commitTime: 0n },
    ],
    wrappedOnEvent,
    onError,
  );
  strictEqual(events.length, 2);
  // Both dispatches happen synchronously inside handleMessage's commit case;
  // acknowledge() is called (fire-and-forget) only after that loop finishes.
  deepStrictEqual(order, ["dispatch:1", "dispatch:2", "ack:0/99"]);
});

// ── A4 — reconnect uses the same 1s→30s exponential backoff as PgNotifySource ──
check("backoff: schedules the first retry at 1s and doubles thereafter, capped at 30s", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  source["stopped"] = false;
  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return 0; // never actually fire — this test only inspects scheduled delays
  };
  try {
    // 6 consecutive scheduleReconnect calls (as connect() would issue after
    // each failed attempt) must grow 1000 -> 2000 -> 4000 -> 8000 -> 16000 -> 30000 (capped).
    for (let i = 0; i < 6; i++) {
      source["scheduleReconnect"](() => {}, () => {});
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (source["retryTimer"]) clearTimeout(source["retryTimer"]);
  }
  deepStrictEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
});

check("backoff: does not schedule once stopped", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  source["stopped"] = true;
  let called = false;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => {
    called = true;
    return 0;
  };
  try {
    source["scheduleReconnect"](() => {}, () => {});
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  strictEqual(called, false);
});

// ── Slot name resolution ───────────────────────────────────────────────────
check("resolveSlotName: default when unset", () => {
  strictEqual(resolveSlotName({}), "indigo_realtime");
});
check("resolveSlotName: override honoured", () => {
  strictEqual(resolveSlotName({ INDIGODB_REALTIME_SLOT: "tenant_a_realtime" }), "tenant_a_realtime");
});
check("resolveSlotName: rejects invalid characters, no SQL/connection built", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "Tenant-A!" }), /Invalid INDIGODB_REALTIME_SLOT/);
});
check("resolveSlotName: rejects a 64-char name", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "a".repeat(64) }), /Invalid INDIGODB_REALTIME_SLOT/);
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
