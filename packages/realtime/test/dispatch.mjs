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
 * FAIL-CLOSED (SEVERE fix, Judgment Day): the SSE route (`handleRequest`) is
 * completely unauthenticated and sets `access-control-allow-origin: "*"`, so
 * it MUST NEVER carry row data — for ANY table, `@@allow` or not. Every SSE
 * subscriber only ever gets a data-free `event: wake` frame now; the old
 * "`@@allow` scopes to wake, no `@@allow` gets the full `event: change`
 * payload" branch is gone. In-process listeners (`on("change")`) are NOT on
 * the wire and are unaffected — they still get the full, unscoped event.
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

/**
 * Minimal duck-typed `IncomingMessage`/`ServerResponse` for `handleRequest`,
 * upgraded for `realtime-sse-backpressure`: simulates a socket buffer via a
 * mutable `writableLength` that only rises on `write()` and falls on an
 * explicit `drain(n)` — no timing dependence needed to reproduce "stalled".
 *
 * `hwm` mirrors the measured 64 KiB `writableHighWaterMark` on a real
 * `http.ServerResponse` (design decision 1) purely so `write()`'s boolean
 * return value stays realistic; production code does not consume it
 * (decision 2) — only the backpressure suite's mutation task (3.3) reads it.
 */
function fakeSubscriber(urlPath = "/", { writableLength = 0, refuse = false, hwm = 65536 } = {}) {
  const written = [];
  let ended = false;
  // Node fires the request's 'close' event once the response is ended. The engine
  // registers a 'close' listener that deletes the same `sub` that `evict()` just
  // deleted, so the real teardown sequence re-enters removal. A no-op `on()` makes
  // that path unreachable from tests, which is exactly how an idempotence guard
  // rots unnoticed (RSB-12).
  let closeListener = null;
  const req = {
    url: urlPath,
    on(eventName, listener) {
      if (eventName === "close") closeListener = listener;
    },
  };
  const res = {
    status: null,
    headers: null,
    writableLength,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    write(chunk) {
      if (refuse) return false; // socket accepts nothing at all (RSB-6)
      written.push(chunk);
      res.writableLength += Buffer.byteLength(chunk); // never drains unless drain() is called
      return res.writableLength < hwm;
    },
    end(chunk) {
      if (chunk !== undefined) written.push(chunk);
      ended = true;
      // Mirror Node: ending the response fires the request's 'close' event.
      if (closeListener) closeListener();
    },
  };
  return {
    req,
    res,
    written,
    isEnded: () => ended,
    drain: (n) => {
      res.writableLength = Math.max(0, res.writableLength - n);
    },
  };
}

function makeEngine(tables, extra = {}) {
  const { source, emit } = fakeSource();
  const engine = new RealtimeEngine({
    connectionString: "postgres://unused/unused",
    schema: { tables },
    source,
    ...extra,
  });
  return { engine, emit };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ── B1.1(a) — REGRESSION GUARD: no `allow` at all still gets ONLY a
//    data-free `event: wake` frame over SSE — row data must never reach an
//    unauthenticated subscriber, `@@allow` or not (fail-closed) ───────────

await check(
  "B1.1a (fail-closed regression guard): model with no @@allow gets a data-free event: wake frame, never event: change, and the frame carries no new/old/pk",
  async () => {
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
    ok(!written.some((f) => f.includes("event: change")), `must NEVER emit event: change over SSE, allow or not — got: ${written.join("|")}`);
    const wakeFrame = written.find((f) => f.includes("event: wake"));
    ok(wakeFrame, `expected an event: wake frame for a non-allow model, got: ${written.join("|")}`);
    const dataLine = wakeFrame.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice("data: ".length));
    deepStrictEqual(payload, { table: "Post", op: "INSERT", lsn: "0/ABC", seq: 1 });
    ok(!("pk" in payload), "wake frame must not carry pk");
    ok(!("new" in payload), "wake frame must not carry new");
    ok(!("old" in payload), "wake frame must not carry old");
  },
);

// ── B1.1(a-listener) — the SAME event, over the in-process fan-out, is NOT
//    scoped: `on("change")` listeners are never on the wire, so they keep
//    receiving the full, unscoped `RealtimeEvent` regardless of `@@allow` ──

await check(
  "B1.1a-listener: in-process on(\"change\") listeners still receive the full event, unscoped, for a non-allow model",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
    const received = [];
    engine.on("change", (e) => received.push(e));
    const event = {
      table: "Post",
      op: "INSERT",
      pk: { id: "1" },
      new: { id: "1", title: "hi" },
      txid: "42",
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/ABC",
    };
    await engine.start();
    emit(event);
    strictEqual(received.length, 1, "the in-process listener must receive exactly one event");
    deepStrictEqual(received[0], event, "the in-process listener must receive the full, unmodified event");
    await engine.stop();
  },
);

// ── B1.1(b-listener) — same, for an @@allow model: in-process listeners are
//    unaffected by the SSE wake-only scoping applied to that model ────────

await check(
  "B1.1b-listener: in-process on(\"change\") listeners still receive the full event for an @@allow model too",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Order", realtime: true, allow: [readRule()] }]);
    const received = [];
    engine.on("change", (e) => received.push(e));
    const event = {
      table: "Order",
      op: "UPDATE",
      pk: { id: "7" },
      new: { id: "7", status: "shipped" },
      old: { id: "7", status: "pending" },
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/DEF",
    };
    await engine.start();
    emit(event);
    strictEqual(received.length, 1, "the in-process listener must receive exactly one event");
    deepStrictEqual(received[0], event, "the in-process listener must receive the full, unmodified event, including new/old");
    await engine.stop();
  },
);

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

await check("RLE-1: dispatch() forwards a pre-projected event's new/old verbatim to in-process listeners — the frame's data key set equals the allowlist", async () => {
  const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
  const received = [];
  engine.on("change", (e) => received.push(e));
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
  await engine.start();
  emit(event);
  strictEqual(received.length, 1, "the in-process listener must receive exactly one event");
  deepStrictEqual(Object.keys(received[0].new).sort(), ["id", "status"]);
  ok(!("passwordHash" in received[0].new), "dispatch() must not re-widen a projected new payload");
  await engine.stop();
});

await check("RLE-3: over SSE, a non-allow model gets wake-only too now (fail-closed) — column projection still applies verbatim to the in-process fan-out for both allow and non-allow models", async () => {
  // Over SSE: both an @@allow model AND a non-allow model get wake-only,
  // never a payload-carrying frame — projection is irrelevant to the wire
  // now, since the wire never carries row data at all.
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
    ok(written.some((f) => f.includes("event: wake")), "an @@allow model must get wake-only SSE, projection changes nothing");
    ok(!written.some((f) => f.includes("event: change")), "must not additionally emit a full/change frame");
  }
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
    ok(written.some((f) => f.includes("event: wake")), "a non-allow model must ALSO get wake-only SSE now (fail-closed)");
    ok(!written.some((f) => f.includes("event: change")), "must never emit event: change over SSE");
  }
  // In-process: the projected new/old still reach the listener verbatim,
  // for both models, regardless of @@allow.
  {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
    const received = [];
    engine.on("change", (e) => received.push(e));
    const event = {
      table: "Post",
      op: "UPDATE",
      pk: { id: "1" },
      new: { id: "1", status: "ok" },
      old: { id: "1", status: "pending" },
      ts: "2026-01-01T00:00:00.000Z",
      lsn: "0/GHI",
    };
    await engine.start();
    emit(event);
    strictEqual(received.length, 1, "the in-process listener must receive exactly one event");
    deepStrictEqual(Object.keys(received[0].new).sort(), ["id", "status"]);
    deepStrictEqual(Object.keys(received[0].old).sort(), ["id", "status"]);
    await engine.stop();
  }
});

// RCP-13 reachability guard: fails loudly if a case above is skipped/omitted.
// (was 6 before the fail-closed fix added 2 in-process-listener regression
// checks — B1.1a-listener, B1.1b-listener.)
strictEqual(ran, 8, "expected exactly 8 check() cases to run in dispatch.mjs so far");
// ── RSC-14 — a rejected engine.start() resets the engine's started state,
//    and a SECOND start() genuinely reaches source.start() again ─────────

await check(
  "RSC-14: a rejected engine.start() leaves the engine restartable — a second start() reaches source.start() again",
  async () => {
    let startCalls = 0;
    const source = {
      async start() {
        startCalls++;
        if (startCalls === 1) {
          throw new Error("boom: first attempt fails");
        }
        // Second call succeeds — engine.start() must resolve.
      },
      async stop() {},
    };
    const engine = new RealtimeEngine({
      connectionString: "postgres://unused/unused",
      schema: { tables: [{ name: "Post", realtime: true }] },
      source,
    });

    await engine.start().then(
      () => {
        throw new Error("expected engine.start() to reject on the first attempt");
      },
      (err) => {
        ok(err instanceof Error, "rejection must carry an Error");
      },
    );
    deepStrictEqual(startCalls, 1, "source.start() must have been called exactly once so far");

    // The critical assertion: a SECOND engine.start() must not be
    // short-circuited by leftover "started" state — it must genuinely reach
    // source.start() again, not merely report engine["started"] === false.
    await engine.start();
    deepStrictEqual(startCalls, 2, "a second engine.start() must reach source.start() again after a rejection");
  },
);

// ── DESIGN-ONLY-1 — engine.start() resolves on a live source and arms the
//    heartbeat (no spec scenario covers this; labelled explicitly) ────────

await check(
  "DESIGN-ONLY-1: engine.start() resolves on a live source and arms the heartbeat",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }]);
    void emit;
    ok(engine["heartbeat"] === null, "heartbeat must be unarmed before start()");
    await engine.start();
    ok(engine["heartbeat"] !== null, "heartbeat must be armed once start() resolves on a live source");
    await engine.stop();
  },
);

// ── realtime-sse-backpressure ──────────────────────────────────────────────
// Bounded per-subscriber write buffering. Every engine below is constructed
// with an explicit small `maxBufferedBytes` (never a megabyte) so the fake
// socket's `writableLength` can be driven directly instead of by volume.

// ── RSB-1 — heartbeat is subject to the same cap as data frames ───────────

await check(
  "RSB-1: heartbeat tick over a stalled subscriber evicts it via the same bounded path",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], {
      heartbeatMs: 5,
      maxBufferedBytes: 1000,
    });
    void emit;
    const { req, res, written, isEnded } = fakeSubscriber("/", { writableLength: 5000 });
    engine.handleRequest(req, res);
    await engine.start();
    await sleep(40);
    await engine.stop();
    ok(!written.some((f) => f.includes(":ping")), `stalled subscriber must not receive a :ping frame, got: ${written.join("|")}`);
    ok(isEnded(), "stalled subscriber's stream must be ended by the heartbeat eviction");
    strictEqual(engine["subscribers"].size, 0, "evicted subscriber must be removed from the registry");
  },
);

// ── RSB-3 / RSB-5 — over-cap subscriber evicted instead of written to ─────

await check(
  "RSB-3/RSB-5: over-cap subscriber is evicted instead of written to, and stays evicted on a second dispatch",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const { req, res, written, isEnded } = fakeSubscriber("/", { writableLength: 5000 });
    engine.handleRequest(req, res);
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    ok(!written.some((f) => f.includes("event: wake")), `over-cap subscriber must not receive the wake frame, got: ${written.join("|")}`);
    ok(isEnded(), "over-cap subscriber's stream must be ended");
    strictEqual(engine["subscribers"].size, 0, "evicted subscriber must be removed from the registry");
    const writtenLengthAfterFirst = written.length;
    emit(event);
    strictEqual(written.length, writtenLengthAfterFirst, "a second dispatch to the now-removed subscriber must write nothing");
    await engine.stop();
  },
);

// ── RSB-6 — eviction proceeds even if the overflow frame cannot be flushed ─

await check(
  "RSB-6: eviction removes and ends the subscriber even when the socket refuses every write",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const { req, res, written, isEnded } = fakeSubscriber("/", { writableLength: 5000, refuse: true });
    engine.handleRequest(req, res);
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    strictEqual(written.length, 0, "not even the overflow frame should land when the socket refuses every write");
    ok(isEnded(), "subscriber must still be ended even though no frame could be flushed");
    strictEqual(engine["subscribers"].size, 0, "subscriber must still be removed from the registry");
    await engine.stop();
  },
);

// ── RSB-7 — eviction invokes onError ───────────────────────────────────────

await check("RSB-7: eviction reports through onError exactly once", async () => {
  const errors = [];
  const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], {
    maxBufferedBytes: 1000,
    onError: (err) => errors.push(err),
  });
  const { req, res } = fakeSubscriber("/", { writableLength: 5000 });
  engine.handleRequest(req, res);
  await engine.start();
  const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
  emit(event);
  strictEqual(errors.length, 1, "onError must be invoked exactly once for one eviction");
  ok(errors[0] instanceof Error, "onError must be called with an Error");
  ok(
    errors[0].message.includes("[backpressure] SSE subscriber evicted"),
    `onError message must identify the eviction, got: ${errors[0].message}`,
  );
  await engine.stop();
});

// ── RSB-10 — eviction mid-dispatch() does not skip a later subscriber ─────

await check(
  "RSB-10: a healthy subscriber registered after the evicted one still receives the frame",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const a = fakeSubscriber("/", { writableLength: 0 });
    const b = fakeSubscriber("/", { writableLength: 5000 });
    const c = fakeSubscriber("/", { writableLength: 0 });
    engine.handleRequest(a.req, a.res);
    engine.handleRequest(b.req, b.res);
    engine.handleRequest(c.req, c.res);
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    strictEqual(a.written.filter((f) => f.includes("event: wake")).length, 1, "A must receive exactly one wake frame");
    strictEqual(c.written.filter((f) => f.includes("event: wake")).length, 1, "C must receive exactly one wake frame — must not be skipped as a side effect of B's eviction");
    ok(!b.written.some((f) => f.includes("event: wake")), "B must not receive the wake frame");
    ok(b.isEnded(), "B must be evicted");
    strictEqual(engine["subscribers"].size, 2, "only B is removed — A and C remain registered");
    await engine.stop();
  },
);

// ── RSB-11 — eviction mid-heartbeat does not skip a later subscriber ──────

await check(
  "RSB-11: a healthy subscriber registered after the evicted one still receives the heartbeat",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], {
      heartbeatMs: 5,
      maxBufferedBytes: 1000,
    });
    void emit;
    const a = fakeSubscriber("/", { writableLength: 0 });
    const b = fakeSubscriber("/", { writableLength: 5000 });
    const c = fakeSubscriber("/", { writableLength: 0 });
    engine.handleRequest(a.req, a.res);
    engine.handleRequest(b.req, b.res);
    engine.handleRequest(c.req, c.res);
    await engine.start();
    await sleep(40);
    ok(a.written.some((f) => f.includes(":ping")), "A must receive the heartbeat");
    ok(c.written.some((f) => f.includes(":ping")), "C must receive the heartbeat — must not be skipped as a side effect of B's eviction");
    ok(!b.written.some((f) => f.includes(":ping")), "B must not receive the heartbeat");
    ok(b.isEnded(), "B must be evicted");
    // Asserted BEFORE stop() — stop() clears every remaining subscriber
    // (A and C included), so checking registry size after stop() would
    // read 0 regardless of eviction correctness.
    strictEqual(engine["subscribers"].size, 2, "only B is removed — A and C remain registered");
    await engine.stop();
  },
);

// ── RSB-2 — a stalled subscriber does not delay dispatch to others ────────
// The "A evicted / A has no frame" half of this case IS RED against the
// untouched tree (fails until Phase 2 lands). The synchrony half (asserted
// immediately after emit() returns, no `await` in between) already passes
// today by construction — it is a REGRESSION GUARD for a future async
// drift in dispatch(), not a RED scenario. Both halves must hold now.

await check(
  "RSB-2: a stalled subscriber (A) is evicted without delaying delivery to a healthy one (B); dispatch() stays synchronous",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const a = fakeSubscriber("/", { writableLength: 5000 });
    const b = fakeSubscriber("/", { writableLength: 0 });
    engine.handleRequest(a.req, a.res);
    engine.handleRequest(b.req, b.res);
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    // Synchrony regression guard: these must already be true the instant
    // emit() (→ dispatch()) returns, with no await in between.
    ok(b.written.some((f) => f.includes("event: wake")), "B must have its wake frame immediately after emit() returns");
    ok(!a.written.some((f) => f.includes("event: wake")), "A must not have received the wake frame");
    ok(a.isEnded(), "A must be evicted");
    strictEqual(engine["subscribers"].size, 1, "only B remains registered");
    await engine.stop();
  },
);

// ── RSB-4 — negative control: cap − 1 is NOT evicted ───────────────────────
// This test PASSES against the untouched tree by construction (no
// production code exists yet to evict anyone) — it is deliberately not RED.
// Its only proof of value comes from the mutation task (3.3), recorded in
// tasks.md, not from this test failing on the untouched tree.

await check(
  "RSB-4: a subscriber buffered at exactly maxBufferedBytes - 1 is NOT evicted (negative control)",
  async () => {
    // hwm pinned to the cap (not the default 65536) so this fixture is
    // sensitive to BOTH candidate probes (task 3.3, mutation B): if `send()`
    // ever acted on write()'s boolean return instead of `writableLength`,
    // writing the ~90-byte frame on top of writableLength=999 would push
    // past this hwm and make write() itself report "rejected", which must
    // NOT translate into an eviction here.
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const { req, res, written, isEnded } = fakeSubscriber("/", { writableLength: 0, hwm: 1000 });
    engine.handleRequest(req, res);
    // Pin the probe to exactly cap - 1 for the change frame below, after the
    // ready frame's own (small) contribution has already landed — this
    // isolates the boundary condition under test from the ready write's
    // incidental byte cost.
    res.writableLength = 999;
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    ok(written.some((f) => f.includes("event: wake")), "a subscriber at cap - 1 must still receive the frame");
    ok(!isEnded(), "a subscriber at cap - 1 must not be evicted");
    strictEqual(engine["subscribers"].size, 1, "subscriber at cap - 1 must remain registered");
    // Simulate the socket draining back to the same boundary before the next
    // frame — a healthy (non-stalled) subscriber's buffer does not grow
    // without bound between frames. Without this, the fake's monotonic
    // `writableLength` would make ANY second write cross the cap regardless
    // of eviction logic, which would test drain simulation, not the probe.
    res.writableLength = 999;
    const writtenLengthAfterFirst = written.length;
    emit(event);
    strictEqual(written.length, writtenLengthAfterFirst + 1, "a second dispatch must also land for a non-evicted subscriber");
    ok(written[written.length - 1].includes("event: wake"), "the second landed frame must be the real wake frame, not an overflow frame");
    ok(!isEnded(), "subscriber must still not be evicted after the second dispatch");
    await engine.stop();
  },
);

// ── RSB-4b — boundary-exact companion: buffered == cap is also NOT evicted.
// This is the assertion that actually distinguishes `buffered > cap` from
// `buffered >= cap`: at `cap - 1` BOTH operators agree (not evicted), so
// that fixture alone cannot bite the `>` → `>=` mutation. Only `buffered ===
// cap` disagrees between the two operators (spec: "at or under the cap, the
// frame MUST be written normally"). Kept as a separate `check()` — not
// folded into RSB-4 above — so a reader sees exactly which assertion the
// mutation task (3.3) is proving.

await check(
  "RSB-4b: a subscriber buffered at EXACTLY maxBufferedBytes (boundary) is NOT evicted — the >/>=  distinguishing case",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const { req, res, written, isEnded } = fakeSubscriber("/", { writableLength: 0, hwm: 1000 });
    engine.handleRequest(req, res);
    res.writableLength = 1000; // exactly at cap, not over it
    await engine.start();
    const event = { table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" };
    emit(event);
    ok(written.some((f) => f.includes("event: wake")), "a subscriber buffered at exactly the cap must still receive the frame");
    ok(!isEnded(), "a subscriber buffered at exactly the cap must not be evicted");
    strictEqual(engine["subscribers"].size, 1, "subscriber at exactly the cap must remain registered");
    await engine.stop();
  },
);

await check(
  "RSB-12: evict() is idempotent — a second call reports no second eviction",
  async () => {
    const { engine, emit } = makeEngine([{ name: "Post", realtime: true }], { maxBufferedBytes: 1000 });
    const errors = [];
    engine["onError"] = (err) => errors.push(err);
    const { req, res, isEnded } = fakeSubscriber("/", { writableLength: 0, hwm: 1000 });
    engine.handleRequest(req, res);
    const sub = [...engine["subscribers"]][0];
    res.writableLength = 5000; // over the 1000 cap
    await engine.start();
    emit({ table: "Post", op: "INSERT", pk: { id: "1" }, new: { id: "1" }, ts: "2026-01-01T00:00:00.000Z" });

    ok(isEnded(), "the over-cap subscriber must be evicted and its stream ended");
    strictEqual(engine["subscribers"].size, 0, "the evicted subscriber must be removed");
    strictEqual(errors.length, 1, "the first eviction reports exactly once");

    // Call evict() directly a second time for the SAME, already-removed `sub`.
    // `if (!this.subscribers.delete(sub)) return;` is what absorbs this. Without
    // that early return, the body runs again: a second `event: overflow` write, a
    // second `res.end()`, and a second onError — a duplicate outage report for one
    // subscriber. Reached deliberately rather than through the teardown sequence,
    // because `handleRequest`'s close listener deletes `sub` directly and never
    // re-enters evict(): the guard is defensive, so only a direct call proves it.
    engine["evict"](sub, 5000);
    strictEqual(errors.length, 1, "a second evict() for the same subscriber must not report again");
    strictEqual(engine["subscribers"].size, 0, "a second evict() must not disturb the registry");
    await engine.stop();
  },
);

// realtime-sse-backpressure reachability guard: fails loudly if a case
// above is skipped/omitted. Counted from an actual run (20 total
// `check()` calls in this file — 18 pre-existing + 2 in-process-listener
// regression checks added by the fail-closed SSE fix), not carried forward
// from provisional design-phase arithmetic.
strictEqual(ran, 20, "expected exactly 20 check() cases in dispatch.mjs");

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nPASSED");
}
