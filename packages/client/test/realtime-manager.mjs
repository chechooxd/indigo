/**
 * @indigodb/client — `RealtimeConnectionManager` open-state suite
 * (`client-live-queries` spec, design.md D1, tasks.md Phase 2, tasks 2.1-2.6).
 *
 * Plain Node, no test framework, mirroring `live.mjs`'s `check()`/`assert()`
 * style. Exercises `realtime.ts`'s connection manager directly against a
 * fake `RealtimeTransport` (no network, no SSE parsing) — this suite proves
 * D1's channel-state model and replay-on-subscribe contract in isolation.
 *
 * `packages/client/test/live.mjs` MUST stay green, unmodified, alongside
 * this file — it is the load-bearing regression fence for `.live()`'s
 * dependency on this exact class (design.md D1 "what must not move").
 */

import { RealtimeConnectionManager } from "../dist/realtime.js";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * A fake `RealtimeTransport` that hands its caller direct access to the
 * `TransportHandlers` it was given, so a test can fire `onOpen`/`onError`
 * synchronously on demand — no real SSE stream involved.
 */
function makeFakeTransport() {
  const calls = { connect: 0, close: 0 };
  let handlers = null;
  const transport = {
    connect(_tables, h) {
      calls.connect++;
      handlers = h;
      return () => {
        calls.close++;
      };
    },
  };
  return {
    transport,
    calls,
    fireOpen(reconnected) {
      handlers.onOpen(reconnected);
    },
    fireError(error) {
      handlers.onError(error);
    },
  };
}

console.log("@indigodb/client: RealtimeConnectionManager open-state (D1)");

// ─── 2.1: first onOpen(false) reaches all listeners ─────────────────────────

await check("2.1: first onOpen(false) reaches all listeners (no longer swallowed)", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  const observedA = [];
  const observedB = [];
  manager.subscribe("Order", { onEvent: () => {}, onOpen: (r) => observedA.push(r) });
  manager.subscribe("Order", { onEvent: () => {}, onOpen: (r) => observedB.push(r) });

  // Both subscriptions happened while the channel was still "connecting",
  // so neither replay fired yet — this exercises the live transport event.
  fake.fireOpen(false);

  assert(observedA.length === 1 && observedA[0] === false, `listener A expected one onOpen(false), got ${JSON.stringify(observedA)}`);
  assert(observedB.length === 1 && observedB[0] === false, `listener B expected one onOpen(false), got ${JSON.stringify(observedB)}`);
});

// ─── 2.2: late subscriber on an already-open channel is replayed synchronously ──

await check("2.2: subscribing to an already-open channel replays onOpen(false) synchronously before subscribe() returns", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  manager.subscribe("Order", { onEvent: () => {} });
  fake.fireOpen(false); // channel is now "live"

  const observed = [];
  let observedBeforeReturn = false;
  const stubListener = {
    onEvent: () => {},
    onOpen: (r) => {
      observed.push(r);
      observedBeforeReturn = true;
    },
  };
  observedBeforeReturn = false; // subscribe() call below must flip this synchronously
  manager.subscribe("Order", stubListener);

  assert(observedBeforeReturn, "expected the replay to run synchronously inside subscribe()");
  assert(observed.length === 1 && observed[0] === false, `expected one replayed onOpen(false), got ${JSON.stringify(observed)}`);
});

// ─── 2.3: replay never fires onResync ────────────────────────────────────────

await check("2.3: replaying an already-open channel to a late subscriber never fires onResync", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  manager.subscribe("Order", { onEvent: () => {} });
  fake.fireOpen(false); // channel is now "live"

  let resyncCount = 0;
  manager.subscribe("Order", { onEvent: () => {}, onOpen: () => {}, onResync: () => resyncCount++ });

  assert(resyncCount === 0, `expected zero onResync calls from replay, got ${resyncCount}`);
});

// ─── 2.4: a genuine reconnect fires onOpen(true) + exactly one onResync ─────

await check("2.4: a genuine reconnect fires onOpen(true) and exactly one onResync per listener", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  const opens = [];
  let resyncCount = 0;
  manager.subscribe("Order", {
    onEvent: () => {},
    onOpen: (r) => opens.push(r),
    onResync: () => resyncCount++,
  });

  fake.fireOpen(false); // first open — no resync
  assert(resyncCount === 0, `expected zero resyncs after the first open, got ${resyncCount}`);

  fake.fireOpen(true); // genuine reconnect
  assert(opens.length === 2 && opens[1] === true, `expected the second onOpen to report true, got ${JSON.stringify(opens)}`);
  assert(resyncCount === 1, `expected exactly one onResync after a genuine reconnect, got ${resyncCount}`);

  fake.fireOpen(true); // a second reconnect fires exactly one more resync
  assert(resyncCount === 2, `expected two total resyncs after two reconnects, got ${resyncCount}`);
});

// ─── 2.5: a listener joining an "error" channel is replayed the stored Error ──

await check("2.5: a listener joining an errored channel is replayed the exact same stored Error instance", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  manager.subscribe("Order", { onEvent: () => {} });
  const originalError = new Error("connection reset");
  fake.fireError(originalError);

  let observedError;
  manager.subscribe("Order", { onEvent: () => {}, onError: (e) => (observedError = e) });

  assert(observedError === originalError, "expected the exact same Error instance to be replayed, not a reconstructed one");
});

// ─── 2.6: refcount unchanged — one connect for N listeners, close on last ───

await check("2.6: refcount unchanged — one connect for N listeners, close only on the last unsubscribe", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);

  const unsubA = manager.subscribe("Order", { onEvent: () => {} });
  const unsubB = manager.subscribe("Order", { onEvent: () => {} });
  const unsubC = manager.subscribe("Order", { onEvent: () => {} });

  assert(fake.calls.connect === 1, `expected exactly one connect() for 3 listeners, got ${fake.calls.connect}`);

  unsubA();
  unsubB();
  assert(fake.calls.close === 0, "expected the connection to stay open while a listener remains");

  unsubC();
  assert(fake.calls.close === 1, `expected exactly one close() on the last unsubscribe, got ${fake.calls.close}`);
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
