/**
 * Unit suite (no DB) for `RealtimeEngine`'s SSE `dispatch()` wake-up scoping
 * (`realtime-live-endpoint` tasks B1.1-B1.3).
 *
 * Hand-built `ResolvedSchema`/`ResolvedTable` fixtures — not parsed from
 * `.indigo` source — since until PR B's `validate.rs` guard removal lands,
 * the compiler still rejects `@@realtime`+`@@allow` on the same model.
 * `dispatch()` is private; every check below drives it indirectly through a
 * fake `RealtimeSource` (captures the engine's `onEvent` callback) fanning
 * out to a subscriber added via `handleRequest` against a fake
 * `ServerResponse` that records every `write()` call.
 *
 * The corrected predicate (Engram #734/#735, spec fix): wake-up-only SSE
 * applies whenever `ResolvedTable.allow !== undefined` — ANY `@@allow`
 * block — not "carries a `read` `AllowRule`". `computeBuckets` returns `[]`
 * (deny-all) for an `@@allow` block with no `read` rule, so a create-only
 * model must ALSO get wake-up-only treatment or it silently reopens the
 * leak the `@@realtime`+`@@allow` compiler guard existed to prevent.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { RealtimeEngine } from "../dist/index.js";

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

console.log("realtime engine: dispatch() SSE wake-up scoping (unit, no DB)");

/** Captures the engine's `onEvent` callback without touching a real DB. */
function fakeSource() {
  let onEvent = null;
  return {
    source: {
      async start(cb) {
        onEvent = cb;
      },
      async stop() {},
    },
    emit(event) {
      ok(onEvent, "engine must call source.start() before emitting");
      onEvent(event);
    },
  };
}

/** Minimal duck-typed `IncomingMessage`/`ServerResponse` for `handleRequest`. */
function fakeSubscriber(urlPath = "/") {
  const written = [];
  const req = {
    url: urlPath,
    on() {
      // 'close' listener registration — no-op, this suite never tears down mid-test.
    },
  };
  const res = {
    status: null,
    headers: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    write(chunk) {
      written.push(chunk);
    },
  };
  return { req, res, written };
}

function makeEngine(tables) {
  const { source, emit } = fakeSource();
  const engine = new RealtimeEngine({
    connectionString: "postgres://unused/unused",
    schema: { tables },
    source,
  });
  return { engine, emit };
}

function readRule(fieldName = "ownerId") {
  return {
    action: "read",
    left: { kind: "claim", name: "userId" },
    right: { kind: "field", name: fieldName },
  };
}

function createRule(fieldName = "ownerId") {
  return {
    action: "create",
    left: { kind: "claim", name: "userId" },
    right: { kind: "field", name: fieldName },
  };
}

async function subscribeAndDispatch(engine, emit, event) {
  const { req, res, written } = fakeSubscriber("/");
  engine.handleRequest(req, res);
  await engine.start();
  emit(event);
  return written;
}

// ── B1.1(a) — no `allow` at all: unchanged full-payload `event: change` ────

await check("B1.1a: model with no @@allow gets full-payload event: change, byte-identical shape", async () => {
  const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
  const event = {
    table: "Post",
    op: "INSERT",
    pk: { id: "1" },
    new: { id: "1", title: "hi" },
    txid: "42",
    ts: "2026-01-01T00:00:00.000Z",
    lsn: "0/ABC",
  };
  const written = await subscribeAndDispatch(engine, emit, event);
  const changeFrame = written.find((f) => f.includes("event: change"));
  ok(changeFrame, `expected an event: change frame, got: ${written.join("|")}`);
  ok(!written.some((f) => f.includes("event: wake")), "must not emit a wake frame for a non-allow model");
  const dataLine = changeFrame.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));
  deepStrictEqual(
    { table: payload.table, op: payload.op, pk: payload.pk, new: payload.new, txid: payload.txid, ts: payload.ts, lsn: payload.lsn },
    { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1", title: "hi" }, txid: "42", ts: "2026-01-01T00:00:00.000Z", lsn: "0/ABC" },
  );
});

// ── B1.1(b) — `allow` present with a `read` rule: scoped `event: wake` ─────

await check("B1.1b: model with an @@allow read rule gets scoped event: wake {table,op,lsn}, no pk/new/old", async () => {
  const { engine, emit } = makeEngine([{ name: "Order", realtime: true, allow: [readRule()] }]);
  const event = {
    table: "Order",
    op: "UPDATE",
    pk: { id: "7" },
    new: { id: "7", status: "shipped" },
    old: { id: "7", status: "pending" },
    ts: "2026-01-01T00:00:00.000Z",
    lsn: "0/DEF",
  };
  const written = await subscribeAndDispatch(engine, emit, event);
  const wakeFrame = written.find((f) => f.includes("event: wake"));
  ok(wakeFrame, `expected an event: wake frame, got: ${written.join("|")}`);
  ok(!written.some((f) => f.includes("event: change")), "must not emit a full-payload frame for an allow model");
  const dataLine = wakeFrame.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));
  deepStrictEqual(payload, { table: "Order", op: "UPDATE", lsn: "0/DEF", seq: 1 });
  ok(!("pk" in payload), "wake frame must not carry pk");
  ok(!("new" in payload), "wake frame must not carry new");
  ok(!("old" in payload), "wake frame must not carry old");
});

// ── B1.1(c) — corrected predicate: `allow` present with ONLY a `create`
//    rule (no `read` rule anywhere) ALSO gets scoped `event: wake` ─────────

await check(
  "B1.1c: create-only @@allow model (no read rule) still gets wake-up-only SSE (corrected predicate)",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Invoice", realtime: true, allow: [createRule()] }]);
    const event = {
      table: "Invoice",
      op: "INSERT",
      pk: { id: "3" },
      new: { id: "3", amount: 100 },
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/111",
    };
    const written = await subscribeAndDispatch(engine, emit, event);
    const wakeFrame = written.find((f) => f.includes("event: wake"));
    ok(
      wakeFrame,
      `create-only allow model must get event: wake, not full payload (naive "has a read rule" check would regress this) — got: ${written.join("|")}`,
    );
    ok(!written.some((f) => f.includes("event: change")), "must not emit a full-payload frame");
    const dataLine = wakeFrame.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice("data: ".length));
    deepStrictEqual(payload, { table: "Invoice", op: "INSERT", lsn: "0/111", seq: 1 });
  },
);

// ── B1.2 — composite PK: wake frame never leaks any part of it ────────────

await check("B1.2: composite-PK model's wake frame omits pk entirely, no partial leak", async () => {
  const { engine, emit } = makeEngine([{ name: "Membership", realtime: true, allow: [readRule()] }]);
  const event = {
    table: "Membership",
    op: "DELETE",
    // Composite PK — ownerId is itself sensitive.
    pk: { ownerId: "u-42", teamId: "t-9" },
    old: { ownerId: "u-42", teamId: "t-9", role: "admin" },
    ts: "2026-01-01T00:00:00.000Z",
    lsn: "0/222",
  };
  const written = await subscribeAndDispatch(engine, emit, event);
  const wakeFrame = written.find((f) => f.includes("event: wake"));
  ok(wakeFrame, "expected an event: wake frame");
  const raw = wakeFrame;
  ok(!raw.includes("ownerId"), "wake frame must not leak the ownerId half of the composite pk");
  ok(!raw.includes("teamId"), "wake frame must not leak the teamId half of the composite pk");
  ok(!raw.includes("u-42"), "wake frame must not leak composite pk values");
  const dataLine = wakeFrame.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));
  deepStrictEqual(payload, { table: "Membership", op: "DELETE", lsn: "0/222", seq: 1 });
  ok(!("pk" in payload), "wake frame must not carry pk at all, composite or otherwise");
});

// ── RLE-1/RLE-3 — column-projected events at dispatch (realtime-column-
//    projection): `dispatch()` never re-derives or re-widens `new`/`old`; it
//    forwards whatever the source already narrowed (design decision 4/8) ──

await check("RLE-1: dispatch() forwards a pre-projected event's new/old verbatim — the frame's data key set equals the allowlist", async () => {
  const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
  const event = {
    table: "Post",
    op: "INSERT",
    pk: { id: "1" },
    // Already narrowed by the source — passwordHash was never here to widen.
    new: { id: "1", status: "ok" },
    txid: "42",
    ts: "2026-01-01T00:00:00.000Z",
    lsn: "0/ABC",
  };
  const written = await subscribeAndDispatch(engine, emit, event);
  const changeFrame = written.find((f) => f.includes("event: change"));
  ok(changeFrame, `expected an event: change frame, got: ${written.join("|")}`);
  const dataLine = changeFrame.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));
  deepStrictEqual(Object.keys(payload.new).sort(), ["id", "status"]);
  ok(!("passwordHash" in payload.new), "dispatch() must not re-widen a projected new payload");
});

await check("RLE-3: column projection and @@allow row scoping compose — allow wins (wake-only), non-allow gets the narrowed frame", async () => {
  // With @@allow: still wake-up-only, regardless of projection.
  {
    const { engine, emit } = makeEngine([{ name: "Order", realtime: true, allow: [readRule()] }]);
    const event = {
      table: "Order",
      op: "UPDATE",
      pk: { id: "7" },
      new: { id: "7", status: "shipped" },
      old: { id: "7", status: "pending" },
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/DEF",
    };
    const written = await subscribeAndDispatch(engine, emit, event);
    ok(written.some((f) => f.includes("event: wake")), "an @@allow model must still get wake-only SSE, projection changes nothing");
    ok(!written.some((f) => f.includes("event: change")), "must not additionally emit a full/change frame");
  }
  // Without @@allow: the narrowed change frame passes through untouched.
  {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
    const event = {
      table: "Post",
      op: "UPDATE",
      pk: { id: "1" },
      new: { id: "1", status: "ok" },
      old: { id: "1", status: "pending" },
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/GHI",
    };
    const written = await subscribeAndDispatch(engine, emit, event);
    const changeFrame = written.find((f) => f.includes("event: change"));
    ok(changeFrame, "a non-allow projected model must get the narrowed event: change frame");
    const dataLine = changeFrame.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice("data: ".length));
    deepStrictEqual(Object.keys(payload.new).sort(), ["id", "status"]);
    deepStrictEqual(Object.keys(payload.old).sort(), ["id", "status"]);
  }
});

// RCP-13 reachability guard: fails loudly if a case above is skipped/omitted.
strictEqual(ran, 6, "expected exactly 6 check() cases to run in dispatch.mjs");

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nPASSED");
}
