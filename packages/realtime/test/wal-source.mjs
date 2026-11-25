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
import { WalSource, PgNotifySource, resolveSlotName, project, projectionSet } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";

let passed = 0;
let ran = 0;
async function check(name, fn) {
  ran++;
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
  // Every commit now writes to `_indigo_realtime_log` before dispatching, so
  // a real (fake) writer + service must be present by default — tests that
  // care about the write/ack path override these explicitly.
  source["writer"] = { query: async () => ({ rows: [] }), end: async () => {} };
  source["service"] = { acknowledge: async () => true };
  return { source, events, errors, onEvent, onError };
}

/** Awaits a source's serial write/dispatch/ack chain after driving messages. */
async function drained(source) {
  await source["chain"];
}

function drive(source, messages, onEvent, onError) {
  for (const m of messages) {
    source["handleMessage"](m, onEvent, onError);
  }
}

// ── A1.1 — constructor / model map ──────────────────────────────────────
await check("constructor builds the model map from @@realtime tables only", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  deepStrictEqual(source.models.sort(), ["Comment", "Post"]);
});

// ── A2.1 — translate(): insert/update/delete parity + unknown table drop ──
await check("insert parity: table/op/pk/new, translated to schema names", async () => {
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
  await drained(source);
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].table, "Post");
  deepStrictEqual(events[0].op, "INSERT");
  deepStrictEqual(events[0].pk, { id: 1 });
  deepStrictEqual(events[0].new, { id: 1, title: "hi", body: "hello" });
  strictEqual(events[0].old, undefined);
});

await check("update: full old tuple parity (REPLICA IDENTITY FULL)", async () => {
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
  await drained(source);
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].old, { id: 1, title: "hi", body: "hello" });
  deepStrictEqual(events[0].new, { id: 1, title: "hi2", body: "hello" });
  deepStrictEqual(events[0].pk, { id: 1 });
});

await check("delete: pk derived from schema primaryKey, not wire keyColumns", async () => {
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
  await drained(source);
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].pk, { id: 5 });
  deepStrictEqual(events[0].old, { id: 5, title: "x", body: "y" });
  strictEqual(events[0].new, undefined);
});

await check("change on a non-@@realtime table is dropped silently", async () => {
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
  await drained(source);
  strictEqual(events.length, 0);
  strictEqual(errors.length, 0);
});

await check("relation not tracked by the schema at all (unpublished) is dropped, not fatal", async () => {
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
  await drained(source);
  strictEqual(events.length, 0);
  strictEqual(errors.length, 0);
});

// ── A2.2 — malformed/unrecognized messages route through onError ──────────
await check("unrecognized message tag routes through onError, does not throw", () => {
  const { source, events, errors, onEvent, onError } = newSource();
  drive(source, [{ tag: "future_tag_v99" }], onEvent, onError);
  strictEqual(events.length, 0);
  strictEqual(errors.length, 1);
  ok(errors[0] instanceof Error);
  ok(/future_tag_v99/.test(errors[0].message));
});

await check("valid-but-inert protocol messages (relation/message/origin/truncate/type) are not errors", () => {
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
await check("txid = decimal xid from begin; ts = commit timestamp, ISO with ms", async () => {
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
  await drained(source);
  strictEqual(events.length, 2);
  for (const e of events) {
    strictEqual(e.txid, "424242");
    strictEqual(e.ts, "2024-01-01T00:00:00.500Z");
  }
});

await check("every row event of the same transaction shares txid/ts", async () => {
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
  await drained(source);
  strictEqual(events.length, 2);
  strictEqual(events[0].txid, events[1].txid);
  strictEqual(events[0].ts, events[1].ts);
  deepStrictEqual(events.map((e) => e.table), ["Post", "Comment"]);
});

// ── A5 — serial insert -> dispatch -> ack chain (realtime-shape-log PR A) ──
//
// `commit` now writes the transaction's buffered rows to
// `_indigo_realtime_log` (via `this.writer`, a second ordinary `pg.Client`)
// BEFORE dispatching to `onEvent` and acknowledging the commit LSN — and the
// whole insert->dispatch->ack sequence is appended to a serial promise chain
// (`this.chain`) so two back-to-back commits can never interleave even
// though `handleMessage` itself stays synchronous. Tests drive `handleMessage`
// synchronously (as `service.on("data")` would) and then await
// `source["chain"]` to observe the fully-settled order.

function fakeWriter(queryImpl) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl ? queryImpl(sql, params) : { rows: [] };
    },
    end: async () => {},
  };
}

await check("insert -> dispatch -> ack: log INSERT completes before any onEvent call, which completes before ack", async () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const order = [];
  source["writer"] = fakeWriter(() => {
    order.push("insert");
    return { rows: [] };
  });
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
  await source["chain"];
  strictEqual(events.length, 2);
  deepStrictEqual(order, ["insert", "dispatch:1", "dispatch:2", "ack:0/99"]);
});

await check("serial chain: two back-to-back commits never interleave their insert/dispatch/ack, even with a slow first write", async () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const order = [];
  let insertCount = 0;
  source["writer"] = fakeWriter(async () => {
    insertCount++;
    if (insertCount === 1) {
      // First commit's write is slow — a synchronous `data` handler would
      // still deliver the second commit's messages while this is pending.
      await new Promise((r) => setTimeout(r, 30));
    }
    order.push(`insert:${insertCount}`);
    return { rows: [] };
  });
  source["service"] = {
    acknowledge: async (lsn) => {
      order.push(`ack:${lsn}`);
      return true;
    },
  };
  const wrappedOnEvent = (e) => order.push(`dispatch:${e.pk.id}`);

  // Both commits driven synchronously, back to back — exactly what
  // `service.on("data")` does while the first write is still in flight.
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    wrappedOnEvent,
    onError,
  );
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/4", commitTime: 0n, xid: 2 },
      { tag: "insert", relation: rel, new: { id: 2, title: "t2", body_text: "b2" } },
      { tag: "commit", flags: 0, commitLsn: "0/5", commitEndLsn: "0/6", commitTime: 0n },
    ],
    wrappedOnEvent,
    onError,
  );

  await source["chain"];
  deepStrictEqual(order, [
    "insert:1",
    "dispatch:1",
    "ack:0/2",
    "insert:2",
    "dispatch:2",
    "ack:0/5",
  ]);
});

await check("failure: a failed log INSERT dispatches no onEvent, does not acknowledge, and tears the connection down", async () => {
  const { source, events, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  // scheduleReconnect() no-ops once `stopped`; this test drives handleMessage
  // directly (bypassing start()), so mark the source as running.
  source["stopped"] = false;
  let stopped = false;
  let acked = false;
  let rescheduled = false;
  source["writer"] = fakeWriter(() => {
    throw new Error("connection reset");
  });
  source["service"] = {
    acknowledge: async () => {
      acked = true;
      return true;
    },
    stop: async () => {
      stopped = true;
    },
  };
  source["scheduleReconnect"] = () => {
    rescheduled = true;
  };
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    (e) => events.push(e),
    onError,
  );
  await source["chain"];
  strictEqual(events.length, 0, "no onEvent call for the failed transaction");
  strictEqual(acked, false, "commit LSN must not be acknowledged — ack is monotonic and would confirm the lost transaction");
  strictEqual(stopped, true, "the connection must be torn down, not logged-and-continued");
  strictEqual(rescheduled, true, "a reconnect must be scheduled after teardown");
  strictEqual(source["service"], null, "service reference cleared after teardown");
});

await check("multi-row batch: one transaction inserting 3 rows produces exactly one INSERT call (batch granularity, decision 12)", async () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t1", body_text: "b1" } },
      { tag: "insert", relation: rel, new: { id: 2, title: "t2", body_text: "b2" } },
      { tag: "insert", relation: rel, new: { id: 3, title: "t3", body_text: "b3" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  strictEqual(events.length, 3);
  strictEqual(writer.calls.length, 1, "expected exactly one INSERT call for the whole transaction");
  ok(/VALUES/.test(writer.calls[0].sql));
  // 3 rows * 9 columns (lsn, txid, table_name, op, pk, new, old, ts, buckets).
  strictEqual(writer.calls[0].params.length, 27);
});

await check("buckets is written as NULL when the table declares no @@allow block at all (public — computeBuckets(table.allow===undefined))", async () => {
  const { source, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  strictEqual(params[params.length - 1], null, "buckets column must be NULL when the table has no @@allow block");
});

// ── B3.1 — computeBuckets wiring: WalSource passes its result into the log
// INSERT's buckets column ────────────────────────────────────────────────
//
// Hand-built `ResolvedSchema` fixtures (B1.3's flagged constraint): a
// `@@realtime` model with `@@allow` rules is unreachable through a compiled
// `.indigo` source file (`validate.rs:86-97`'s guard) until slice 4, so
// this wiring is exercised against an in-memory schema, never `testSchema()`.

function schemaWithAllow(allow) {
  return {
    tables: [
      {
        name: "Post",
        dbName: "Post",
        realtime: true,
        columns: [
          { name: "id", dbName: "id" },
          { name: "ownerId", dbName: "ownerId" },
          { name: "title", dbName: "title" },
        ],
        primaryKey: ["id"],
        allow,
      },
    ],
  };
}

const claim = { kind: "claim", name: "userId" };
const field = (name) => ({ kind: "field", name });

await check("B3.1: an INSERT on a table with a field==claim read rule writes a non-NULL buckets array derived from the row", async () => {
  const source = new WalSource(
    "postgres://unused/db",
    schemaWithAllow([{ action: "read", left: field("ownerId"), right: claim }]),
  );
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const rel = relation("Post", ["id", "ownerId", "title"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, ownerId: "u1", title: "t" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    (e) => {},
    (e) => {},
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(params[params.length - 1], ["u1"]);
});

await check("B3.1: a table with @@allow but no read rule (create-only) writes buckets = [] (deny-all, not NULL)", async () => {
  const source = new WalSource(
    "postgres://unused/db",
    schemaWithAllow([{ action: "create", left: field("ownerId"), right: claim }]),
  );
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const rel = relation("Post", ["id", "ownerId", "title"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, ownerId: "u1", title: "t" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    (e) => {},
    (e) => {},
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(params[params.length - 1], []);
});

await check("B3.1: UPDATE unions buckets from both new and old (ownership change) — the losing owner still observes the row leaving their view", async () => {
  const source = new WalSource(
    "postgres://unused/db",
    schemaWithAllow([{ action: "read", left: field("ownerId"), right: claim }]),
  );
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const rel = relation("Post", ["id", "ownerId", "title"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      {
        tag: "update",
        relation: rel,
        old: { id: 1, ownerId: "u1", title: "t" },
        new: { id: 1, ownerId: "u2", title: "t" },
      },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    (e) => {},
    (e) => {},
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(params[params.length - 1].sort(), ["u1", "u2"]);
});

await check("B3.1: buckets are computed from the RAW physical-column-keyed row, not the schema-field-renamed wire event", async () => {
  // `@map`-renamed column: physical `owner_id`, schema field `ownerId`. The
  // AllowRule's field operand always carries the PHYSICAL name.
  const source = new WalSource("postgres://unused/db", {
    tables: [
      {
        name: "Post",
        dbName: "Post",
        realtime: true,
        columns: [
          { name: "id", dbName: "id" },
          { name: "ownerId", dbName: "owner_id" },
        ],
        primaryKey: ["id"],
        allow: [{ action: "read", left: field("owner_id"), right: claim }],
      },
    ],
  });
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const rel = relation("Post", ["id", "owner_id"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, owner_id: "u1" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    (e) => {},
    (e) => {},
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(params[params.length - 1], ["u1"]);
});

await check("lsn: every emitted event carries the commit LSN as the X/Y hex string pg_lsn prints", async () => {
  const { source, events, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  source["writer"] = fakeWriter();
  source["service"] = { acknowledge: async () => true };
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: "t", body_text: "b" } },
      { tag: "commit", flags: 0, commitLsn: "1A/2B", commitEndLsn: "1A/2C", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  strictEqual(events.length, 1);
  strictEqual(events[0].lsn, "1A/2B");
});

// ── A6 — threat: SQL injection through logged row data ─────────────────────
await check("threat: a row value crafted as a SQL injection payload round-trips as inert parameterized data, never concatenated into SQL", async () => {
  const { source, onEvent, onError } = newSource();
  const rel = relation("Post", ["id", "title", "body_text"]);
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const payload = `'); DROP TABLE "User"; --`;
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, title: payload, body_text: "b" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ sql, params }] = writer.calls;
  strictEqual(sql.includes("DROP TABLE"), false, "the injection payload must never appear literally in the SQL text");
  // params layout per row: [lsn, txid, table_name, op, pk, "new", "old", ts, buckets] — index 5 is "new".
  const newRow = JSON.parse(params[5]);
  strictEqual(newRow.title, payload, "the payload must reach the writer intact, only as a bound (JSON-encoded) parameter");
});

// ── C1 — projection helper: three-state null vs empty Set (RCP-7, task 2.1) ──
await check("project(): null allow returns the row unchanged; empty Set returns {} — never conflated", () => {
  const row = { id: 1, status: "ok", passwordHash: "secret" };
  deepStrictEqual(project(row, null), row, "null allow (bare @@realtime) must pass the row through untouched");
  deepStrictEqual(project(row, new Set()), {}, "an empty Set must project to {}, not fall back to the full row");
});

await check("project(): non-empty Set narrows to exactly the allowed keys, preserving null values (RWS-7)", () => {
  const row = { id: 1, status: null, passwordHash: "secret" };
  deepStrictEqual(project(row, new Set(["id", "status"])), { id: 1, status: null });
});

await check("projectionSet(): absent realtimeColumns -> null; present (incl. empty) -> a Set", () => {
  strictEqual(projectionSet({ realtimeColumns: undefined }), null);
  deepStrictEqual(projectionSet({ realtimeColumns: ["id", "status"] }), new Set(["id", "status"]));
  deepStrictEqual(projectionSet({ realtimeColumns: [] }), new Set());
});

// ── C2 — write-time enforcement in WalSource (Phase 3) ─────────────────────
//
// Hand-built `ResolvedSchema` fixtures carrying `realtimeColumns` directly
// (same rationale as `schemaWithAllow` above: a compiled `.indigo` source
// is not required to exercise `WalSource`'s handling of the resolved IR
// field — PR 1 already proves the compiler produces it correctly).

function schemaWithProjection({ realtimeColumns, allow, primaryKey = ["id"], extraColumns = [] } = {}) {
  return {
    tables: [
      {
        name: "Post",
        dbName: "Post",
        realtime: true,
        realtimeColumns,
        columns: [
          { name: "id", dbName: "id" },
          { name: "status", dbName: "status" },
          { name: "passwordHash", dbName: "passwordHash" },
          ...extraColumns,
        ],
        primaryKey,
        allow,
      },
    ],
  };
}

function newProjectedSource(schema) {
  const source = new WalSource("postgres://unused/db", schema);
  const events = [];
  const writer = fakeWriter();
  source["writer"] = writer;
  source["service"] = { acknowledge: async () => true };
  const onEvent = (e) => events.push(e);
  const onError = (e) => {
    throw e;
  };
  return { source, events, writer, onEvent, onError };
}

await check("RCP-2/RWS-1: a non-allowlisted column is absent from the INSERT params and the dispatched event", async () => {
  const { source, events, writer, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: ["id", "status"] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, status: "ok", passwordHash: "s3cr3t" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(Object.keys(JSON.parse(params[5])).sort(), ["id", "status"]);
  strictEqual(events.length, 1);
  deepStrictEqual(Object.keys(events[0].new).sort(), ["id", "status"]);
  ok(!("passwordHash" in events[0].new), "passwordHash must not reach the dispatched event");
});

await check("RCP-4: a field newly added to the model but absent from columns stays excluded, no code change needed", async () => {
  const { source, events, writer, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: ["id", "status"] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, status: "ok", passwordHash: "leaked-if-forgotten" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  ok(!("passwordHash" in JSON.parse(params[5])), "the unlisted field must never appear in the logged new row");
  ok(!("passwordHash" in events[0].new), "the unlisted field must never appear in the dispatched event");
});

await check("RCP-11/RWS-4: old is narrowed identically to new (same key set), for UPDATE and DELETE", async () => {
  const { source, events, writer, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: ["id", "status"] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      {
        tag: "update",
        relation: rel,
        old: { id: 1, status: "pending", passwordHash: "old-secret" },
        new: { id: 1, status: "ok", passwordHash: "new-secret" },
      },
      { tag: "delete", relation: rel, old: { id: 2, status: "gone", passwordHash: "deleted-secret" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  // Both row changes commit in the same transaction, so `buildLogInsert`
  // batches them into ONE multi-row INSERT (design decision 12) — 9 params
  // per row, UPDATE at offset 0, DELETE at offset 9.
  strictEqual(writer.calls.length, 1);
  const { params } = writer.calls[0];
  strictEqual(params.length, 18);
  const [updateNew, updateOld] = [params[5], params[6]];
  const [deleteNew, deleteOld] = [params[14], params[15]];
  deepStrictEqual(Object.keys(JSON.parse(updateNew)).sort(), ["id", "status"]);
  deepStrictEqual(Object.keys(JSON.parse(updateOld)).sort(), ["id", "status"]);
  strictEqual(deleteNew, null, "DELETE has no new image");
  deepStrictEqual(Object.keys(JSON.parse(deleteOld)).sort(), ["id", "status"]);
  strictEqual(events.length, 2);
  deepStrictEqual(Object.keys(events[0].old).sort(), Object.keys(events[0].new).sort());
});

await check("RCP-8: event.pk is complete even when the PK column is absent from columns", async () => {
  const { source, events, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: ["status"] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 7, status: "ok", passwordHash: "s" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  deepStrictEqual(events[0].pk, { id: 7 }, "pk must still carry the full primary key");
  ok(!("id" in events[0].new), "id must NOT be implicitly injected into new just because it's the pk");
  deepStrictEqual(Object.keys(events[0].new), ["status"]);
});

await check("RCP-9: an explicitly listed PK field appears in new in addition to pk", async () => {
  const { source, events, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: ["id", "status"] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 7, status: "ok", passwordHash: "s" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  deepStrictEqual(events[0].pk, { id: 7 });
  deepStrictEqual(events[0].new, { id: 7, status: "ok" }, "id appears in new only because it was explicitly listed");
});

await check("RCP-7 mechanics: columns:[] stores '{}'::jsonb (not NULL) and dispatches new:{} with pk intact", async () => {
  const { source, events, writer, onEvent, onError } = newProjectedSource(
    schemaWithProjection({ realtimeColumns: [] }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 3, status: "ok", passwordHash: "s" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  strictEqual(params[5], "{}", "an empty allowlist must store the JSON literal '{}', distinguishable from NULL");
  strictEqual(events.length, 1);
  deepStrictEqual(events[0].new, {}, "dispatched new must be an empty object, not absent");
  deepStrictEqual(events[0].pk, { id: 3 }, "identity survives even with an empty column allowlist");
});

await check("RCP-12/RWS-3: buckets computed from the FULL raw row are unaffected by a projected-away @@allow field", async () => {
  const { source, writer, onEvent, onError } = newProjectedSource(
    schemaWithProjection({
      realtimeColumns: ["id", "status"],
      allow: [{ action: "read", left: field("ownerId"), right: claim }],
      extraColumns: [{ name: "ownerId", dbName: "ownerId" }],
    }),
  );
  const rel = relation("Post", ["id", "status", "passwordHash", "ownerId"]);
  drive(
    source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, status: "ok", passwordHash: "s", ownerId: "u1" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    onEvent,
    onError,
  );
  await source["chain"];
  const [{ params }] = writer.calls;
  deepStrictEqual(params[params.length - 1], ["u1"], "buckets must reflect ownerId even though it's excluded from columns");
  ok(!("ownerId" in JSON.parse(params[5])), "ownerId itself must not appear in the projected new payload");
});

await check("RWS-6: no emitted event carries partial:true across projected, empty-list, and bare cases", async () => {
  for (const realtimeColumns of [["id", "status"], [], undefined]) {
    const { source, events, onEvent, onError } = newProjectedSource(schemaWithProjection({ realtimeColumns }));
    const rel = relation("Post", ["id", "status", "passwordHash"]);
    drive(
      source,
      [
        { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
        { tag: "insert", relation: rel, new: { id: 1, status: "ok", passwordHash: "s" } },
        { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
      ],
      onEvent,
      onError,
    );
    await source["chain"];
    strictEqual(events.length, 1);
    strictEqual(events[0].partial, undefined, `partial must not be set for realtimeColumns=${JSON.stringify(realtimeColumns)}`);
  }
});

await check("RSL-2: widening the allowlist on a rebuilt source does not recover the first commit's already-narrow history", async () => {
  const narrow = newProjectedSource(schemaWithProjection({ realtimeColumns: ["id"] }));
  const rel = relation("Post", ["id", "status", "passwordHash"]);
  drive(
    narrow.source,
    [
      { tag: "begin", commitLsn: "0/1", commitTime: 0n, xid: 1 },
      { tag: "insert", relation: rel, new: { id: 1, status: "ok", passwordHash: "s" } },
      { tag: "commit", flags: 0, commitLsn: "0/2", commitEndLsn: "0/3", commitTime: 0n },
    ],
    narrow.onEvent,
    narrow.onError,
  );
  await narrow.source["chain"];
  const [{ params: firstParams }] = narrow.writer.calls;
  deepStrictEqual(Object.keys(JSON.parse(firstParams[5])), ["id"], "the first commit's stored row must stay narrow");

  // Rebuild the source with a wider allowlist — the FIRST source/writer's
  // captured params (asserted above) must not be mutated by this.
  const wide = newProjectedSource(schemaWithProjection({ realtimeColumns: ["id", "status"] }));
  drive(
    wide.source,
    [
      { tag: "begin", commitLsn: "0/3", commitTime: 0n, xid: 2 },
      { tag: "insert", relation: rel, new: { id: 2, status: "ok", passwordHash: "s" } },
      { tag: "commit", flags: 0, commitLsn: "0/4", commitEndLsn: "0/5", commitTime: 0n },
    ],
    wide.onEvent,
    wide.onError,
  );
  await wide.source["chain"];

  deepStrictEqual(
    Object.keys(JSON.parse(firstParams[5])),
    ["id"],
    "the first source's captured history must remain narrow after a wider source is built",
  );
});

// ── C3 — PgNotifySource narrows too (design decision 7, DX-4) ──────────────
await check("DX-4: PgNotifySource.translate narrows new/old identically for narrow, empty, and bare columns", () => {
  for (const [realtimeColumns, expectedKeys] of [
    [["id", "status"], ["id", "status"]],
    [[], []],
    [undefined, ["id", "status", "passwordHash"]],
  ]) {
    const source = new PgNotifySource(
      "postgres://unused/db",
      schemaWithProjection({ realtimeColumns }),
    );
    const payload = JSON.stringify({
      table: "Post",
      op: "INSERT",
      pk: { id: 1 },
      new: { id: 1, status: "ok", passwordHash: "s" },
      ts: "2026-01-01T00:00:00.000Z",
      txid: "1",
    });
    const event = source["translate"](payload);
    ok(event, `expected an event for realtimeColumns=${JSON.stringify(realtimeColumns)}`);
    deepStrictEqual(Object.keys(event.new).sort(), [...expectedKeys].sort());
    deepStrictEqual(event.pk, { id: 1 }, "pk must never be narrowed");
  }
});

// ── A4 — reconnect uses the same 1s→30s exponential backoff as PgNotifySource ──
await check("backoff: schedules the first retry at 1s and doubles thereafter, capped at 30s", () => {
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

await check("backoff: does not schedule once stopped", () => {
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
await check("resolveSlotName: default when unset", () => {
  strictEqual(resolveSlotName({}), "indigo_realtime");
});
await check("resolveSlotName: override honoured", () => {
  strictEqual(resolveSlotName({ INDIGODB_REALTIME_SLOT: "tenant_a_realtime" }), "tenant_a_realtime");
});
await check("resolveSlotName: rejects invalid characters, no SQL/connection built", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "Tenant-A!" }), /Invalid INDIGODB_REALTIME_SLOT/);
});
await check("resolveSlotName: rejects a 64-char name", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "a".repeat(64) }), /Invalid INDIGODB_REALTIME_SLOT/);
});

// ── `start()` readiness contract (realtime-start-contract, RSC-*/RWS-*) ────
//
// These tests never touch a real Postgres — `createService()`/
// `createWriter()` are private test seams overridden per test (the same
// reach-into-the-instance style the rest of this file already uses).
// Resolve-timing assertions use a `Promise.race` against a `setImmediate`
// sentinel rather than a fixed timeout: Node drains all pending microtasks
// (including a settled `start()`'s `.then()` chain) before any `setImmediate`
// callback runs, so the race is deterministic — a failing case fails the
// assertion immediately, it does not hang the suite.

function fakeReplicationService() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    fire(event, ...args) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    subscribe: () => new Promise(() => {}), // overridden per test
    stop: async () => {},
    acknowledge: async () => true,
  };
}

function fakeReplicationWriter(connectImpl) {
  const calls = { connect: 0, end: 0 };
  return {
    calls,
    connect: async () => {
      calls.connect++;
      if (connectImpl) await connectImpl();
    },
    end: async () => {
      calls.end++;
    },
    query: async () => ({ rows: [] }),
    on() {},
  };
}

/** Resolves after every currently-queued microtask has drained. */
function afterMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

await check("RWS-1: construction performs no I/O — createService/createWriter are never called before start()", () => {
  let serviceCalls = 0;
  let writerCalls = 0;
  const source = new WalSource("postgres://unused/db", testSchema());
  source["createService"] = () => {
    serviceCalls++;
    return fakeReplicationService();
  };
  source["createWriter"] = () => {
    writerCalls++;
    return fakeReplicationWriter();
  };
  deepStrictEqual(source.models.sort(), ["Comment", "Post"]);
  strictEqual(serviceCalls, 0, "constructing/reading a WalSource must not open a replication connection");
  strictEqual(writerCalls, 0, "constructing/reading a WalSource must not open a log-writer connection");
});

await check("RSC-1/RWS-2: start() resolves once the stream is confirmed live, not at stream end", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let resolveSubscribe;
  const subscribePromise = new Promise((resolve) => {
    resolveSubscribe = resolve;
  });
  const service = fakeReplicationService();
  service.subscribe = () => subscribePromise;
  source["createService"] = () => service;
  source["createWriter"] = () => fakeReplicationWriter();
  // Resolving subscribePromise below lets connect() reach its normal-
  // completion tail, which calls the real scheduleReconnect() — override it
  // so cleanup doesn't arm a real setTimeout past this check's own return.
  source["scheduleReconnect"] = () => {};

  const startPromise = source.start(() => {}, () => {});
  await afterMicrotasks();
  service.fire("start");

  const outcome = await Promise.race([
    startPromise.then(() => "resolved"),
    afterMicrotasks().then(() => "still-pending"),
  ]);
  strictEqual(outcome, "resolved", "start() must resolve promptly once the stream is confirmed live");

  const subscribeOutcome = await Promise.race([
    subscribePromise.then(() => "settled"),
    afterMicrotasks().then(() => "still-pending"),
  ]);
  strictEqual(subscribeOutcome, "still-pending", "subscribe()'s own promise must still be pending — the stream has not ended");
  resolveSubscribe();
});

await check("RSC-4/RWS-3: start() rejects on a missing replication slot, carrying the underlying error", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  const slotError = Object.assign(new Error('publication "indigo_realtime" does not exist'), { code: "42704" });
  const service = fakeReplicationService();
  service.subscribe = () => Promise.reject(slotError);
  source["createService"] = () => service;
  source["createWriter"] = () => fakeReplicationWriter();
  // This test is scoped to the first-attempt rejection only — the backoff
  // policy itself is RSC-10/RWS-9's job. Without this override the catch
  // block's own scheduleReconnect() would arm a REAL setTimeout against the
  // same always-rejecting fake, doubling forever and keeping the process
  // alive well past this check's own completion.
  source["scheduleReconnect"] = () => {};

  let caught;
  try {
    await source.start(() => {}, () => {});
  } catch (err) {
    caught = err;
  }
  strictEqual(caught, slotError, "the rejection must carry the exact underlying Postgres error, not a substituted one");
});

await check("RSC-5/RWS-4: start() rejects on an authentication failure without ever calling subscribe()", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  const authError = Object.assign(new Error("password authentication failed"), { code: "28P01" });
  let subscribeCalled = false;
  const service = fakeReplicationService();
  service.subscribe = () => {
    subscribeCalled = true;
    return new Promise(() => {});
  };
  source["createService"] = () => service;
  source["createWriter"] = () => fakeReplicationWriter(() => {
    throw authError;
  });
  // See RSC-4/RWS-3 above — same reason: without this the catch block's own
  // scheduleReconnect() would arm a real, ever-doubling setTimeout.
  source["scheduleReconnect"] = () => {};

  let caught;
  try {
    await source.start(() => {}, () => {});
  } catch (err) {
    caught = err;
  }
  strictEqual(caught, authError, "the rejection must carry the underlying Postgres authentication error");
  strictEqual(subscribeCalled, false, "a writer-connect failure must reject start() before subscribe() is ever reached — a distinct path from RSC-4/RWS-3");
});

await check("settleReady: resolve nulls the field, so a later reject call is a no-op (bug-class 1, direction resolve-then-reject)", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let resolveCalls = 0;
  let rejectCalls = 0;
  source["ready"] = {
    resolve: () => {
      resolveCalls++;
    },
    reject: () => {
      rejectCalls++;
    },
  };
  source["settleReady"]("resolve");
  strictEqual(resolveCalls, 1);
  strictEqual(source["ready"], null, "the field must be nulled immediately once settled");

  // Simulates a later reconnect failure calling settleReady("reject", ...)
  // after a successful start — must be a no-op, not a re-invocation of the
  // original reject.
  source["settleReady"]("reject", new Error("late reconnect failure"));
  strictEqual(resolveCalls, 1, "the original resolve callback must not be invoked again");
  strictEqual(rejectCalls, 0, "the original reject callback must never fire after resolve already settled the deferred");
});

await check("settleReady: reject nulls the field, so a later resolve call is a no-op (bug-class 1, direction reject-then-resolve)", () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let resolveCalls = 0;
  let rejectCalls = 0;
  source["ready"] = {
    resolve: () => {
      resolveCalls++;
    },
    reject: () => {
      rejectCalls++;
    },
  };
  source["settleReady"]("reject", new Error("first attempt failed"));
  strictEqual(rejectCalls, 1);
  strictEqual(source["ready"], null, "the field must be nulled immediately once settled");

  // Simulates a later reconnect success calling settleReady("resolve")
  // after a first-attempt rejection — must be a no-op, not a re-invocation
  // of the original resolve.
  source["settleReady"]("resolve");
  strictEqual(rejectCalls, 1, "the original reject callback must not be invoked again");
  strictEqual(resolveCalls, 0, "the original resolve callback must never fire after reject already settled the deferred");
});

await check("RSC-7/RWS-5: a reconnect failure after a successful start does not reject the already-resolved start()", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  const service1 = fakeReplicationService();
  service1.subscribe = () => new Promise(() => {});
  source["createService"] = () => service1;
  source["createWriter"] = () => fakeReplicationWriter();

  const startPromise = source.start(() => {}, () => {});
  await afterMicrotasks();
  service1.fire("start");
  await startPromise; // must already be resolved — proven by RSC-1/RWS-2 above

  strictEqual(source["ready"], null, "the deferred is nulled once the first attempt resolves");

  // Drive a second connect() attempt directly, as scheduleReconnect() would
  // after a later connection loss, whose writer fails.
  const reconnectError = new Error("connection reset");
  source["createWriter"] = () => fakeReplicationWriter(() => {
    throw reconnectError;
  });
  source["scheduleReconnect"] = () => {}; // avoid leaking a real backoff timer
  source["stopped"] = false;

  const errors = [];
  await source["connect"](() => {}, (e) => errors.push(e));

  strictEqual(errors.length, 1, "the reconnect failure must be reported");
  strictEqual(errors[0], reconnectError);
  strictEqual(source["ready"], null, "the already-settled deferred must still be null — never re-armed by a reconnect");
});

await check("RSC-8a/RWS-6a: a reconnect success after a successful start does not re-resolve start()", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  const service1 = fakeReplicationService();
  service1.subscribe = () => new Promise(() => {});
  source["createService"] = () => service1;
  source["createWriter"] = () => fakeReplicationWriter();

  const startPromise = source.start(() => {}, () => {});
  await afterMicrotasks();
  service1.fire("start");
  await startPromise;
  strictEqual(source["ready"], null);

  // Drive a second connect() attempt directly whose service fires "start"
  // again (as a real reconnect success would). Not awaited to completion:
  // like the first attempt, its subscribe() only settles at stream end,
  // which never happens in this test.
  const service2 = fakeReplicationService();
  service2.subscribe = () => new Promise(() => {});
  source["createService"] = () => service2;
  source["createWriter"] = () => fakeReplicationWriter();
  source["stopped"] = false;

  void source["connect"](() => {}, () => {});
  await afterMicrotasks();
  service2.fire("start"); // must not throw, must not re-settle anything
  await afterMicrotasks();

  strictEqual(source["ready"], null, "firing start() a second time after the deferred already resolved must stay a no-op");
});

await check("RSC-8b/RWS-6b: a reconnect success after a rejected start does not re-settle it, and raises no unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const source = new WalSource("postgres://unused/db", testSchema());
    const slotError = Object.assign(new Error('publication "indigo_realtime" does not exist'), { code: "42704" });
    const service1 = fakeReplicationService();
    service1.subscribe = () => Promise.reject(slotError);
    source["createService"] = () => service1;
    source["createWriter"] = () => fakeReplicationWriter();
    source["scheduleReconnect"] = () => {}; // avoid leaking a real backoff timer

    let caught;
    try {
      await source.start(() => {}, () => {});
    } catch (err) {
      caught = err;
    }
    strictEqual(caught, slotError);
    strictEqual(source["ready"], null);

    // A later reconnect attempt succeeds after the first-attempt rejection.
    // Not awaited to completion: subscribe() only settles at stream end,
    // which never happens in this test.
    const service2 = fakeReplicationService();
    service2.subscribe = () => new Promise(() => {});
    source["createService"] = () => service2;
    source["createWriter"] = () => fakeReplicationWriter();
    source["stopped"] = false;

    void source["connect"](() => {}, () => {});
    await afterMicrotasks();
    service2.fire("start"); // must not resolve the already-rejected start()
    await afterMicrotasks();

    strictEqual(source["ready"], null, "the already-rejected deferred must stay null — never re-settled by a later reconnect success");
    // Give any dangling rejection a full macrotask turn to surface before
    // asserting none did.
    await afterMicrotasks();
    strictEqual(unhandled.length, 0, "the detached connect() attempt must never crash the host process via an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

await check("RSC-9/RWS-7: stop() before the stream goes live rejects the pending start() and tears down resources", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let resolveWriterConnect;
  const writerConnectPromise = new Promise((resolve) => {
    resolveWriterConnect = resolve;
  });
  const service = fakeReplicationService();
  let serviceStopped = false;
  service.stop = async () => {
    serviceStopped = true;
  };
  const writer = fakeReplicationWriter(() => writerConnectPromise);
  source["createService"] = () => service;
  source["createWriter"] = () => writer;

  const startPromise = source.start(() => {}, () => {});
  await afterMicrotasks();
  const stopPromise = source.stop();
  resolveWriterConnect(); // let the held-open writer.connect() proceed

  let caught;
  try {
    await startPromise;
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof Error, "start() must reject rather than remain pending once stop() runs before the stream goes live");
  await stopPromise;
  strictEqual(serviceStopped, true, "the replication service must be stopped");
  strictEqual(writer.calls.end, 1, "the in-flight writer connection must be closed, with none left open");
});

await check("RWS-8: a superseded connect() closes its own writer and does not overwrite this.writer", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let resolveFirstWriterConnect;
  const firstWriterConnectPromise = new Promise((resolve) => {
    resolveFirstWriterConnect = resolve;
  });
  const firstWriter = fakeReplicationWriter(() => firstWriterConnectPromise);
  const firstService = fakeReplicationService();
  firstService.subscribe = () => new Promise(() => {});

  const secondWriter = fakeReplicationWriter();
  const secondService = fakeReplicationService();
  secondService.subscribe = () => new Promise(() => {});

  let call = 0;
  source["createWriter"] = () => (++call === 1 ? firstWriter : secondWriter);
  let serviceCall = 0;
  source["createService"] = () => (++serviceCall === 1 ? firstService : secondService);
  source["stopped"] = false; // connect() driven directly, bypassing start()

  const firstConnect = source["connect"](() => {}, () => {});
  await afterMicrotasks();
  // A second connect() supersedes the first while its writer is still
  // connecting. Not awaited to completion: its own subscribe() only settles
  // at stream end, which never happens in this test — only the writer
  // supersession guard on the FIRST attempt is under test here.
  void source["connect"](() => {}, () => {});
  await afterMicrotasks();
  resolveFirstWriterConnect(); // let the superseded first attempt proceed
  await firstConnect;

  strictEqual(firstWriter.calls.end, 1, "the superseded attempt must close its own writer");
  strictEqual(source["writer"], secondWriter, "this.writer must never be overwritten by the superseded attempt");
});

await check("reconnect teardown: failed subscribe() stops the old service and closes its writer before scheduling reconnect", async () => {
  const source = new WalSource("postgres://unused/db", testSchema());
  let rejectSubscribe;
  const subscribePromise = new Promise((_resolve, reject) => {
    rejectSubscribe = reject;
  });
  let serviceStopCalls = 0;
  let reconnectCalls = 0;
  const service = fakeReplicationService();
  service.subscribe = () => subscribePromise;
  service.stop = async () => {
    serviceStopCalls++;
  };
  const writer = fakeReplicationWriter();
  source["createService"] = () => service;
  source["createWriter"] = () => writer;
  source["scheduleReconnect"] = () => {
    reconnectCalls++;
  };

  const startPromise = source.start(() => {}, () => {});
  await afterMicrotasks();
  service.fire("start");
  await startPromise;

  // Simulate pg_terminate_backend killing the replication connection mid-stream.
  rejectSubscribe(new Error("terminating connection due to administrator command"));
  await afterMicrotasks();
  await afterMicrotasks();

  strictEqual(serviceStopCalls, 1, "failed service must be stopped so its standby-status interval never leaks");
  strictEqual(writer.calls.end, 1, "failed attempt must close its log-writer before reconnecting");
  strictEqual(reconnectCalls, 1, "reconnect must still be scheduled after tearing down the dead service");
});

console.log(`\n${passed} passed`);
// RCP-13 reachability guard: fails loudly if a case above is skipped/omitted
// instead of silently shrinking the run.
strictEqual(ran, 52, "expected exactly 52 check() cases to run in wal-source.mjs");
strictEqual(passed, 52, "expected exactly 52 checks to pass — an omitted or silently-skipped case must shrink this count and fail loudly");
if (process.exitCode) process.exit(process.exitCode);
