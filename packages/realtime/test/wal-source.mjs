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

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
