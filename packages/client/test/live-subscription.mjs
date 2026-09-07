/**
 * @indigodb/client — `createLiveSubscription` + `SseTransport` terminal
 * classification suite (`realtime-live-subscription` spec, design.md D2/D3/
 * D4/D6, tasks.md Phase 3, tasks 3.1-3.11 + 3.13-3.14).
 *
 * Plain Node, no test framework, mirroring `live.mjs`/`realtime-manager.mjs`'s
 * `check()`/`assert()` style.
 *
 * Two layers of fake, matching the two things under test:
 *   - `createLiveSubscription` itself is driven through a fake
 *     `RealtimeTransport` (no network, no SSE parsing) — same shape as
 *     `realtime-manager.mjs`'s fake, extended with a `fireWake()` hook.
 *   - The terminal/transient classification (3.13/3.14) is driven directly
 *     against the real `SseTransport` over a mocked `global.fetch` — no
 *     `RealtimeConnectionManager`/primitive involved, since the
 *     classification lives entirely inside `SseTransport`'s own retry loop
 *     (design.md D6, `TransportHandlers.onTerminal`).
 *
 * `packages/client/test/live.mjs` MUST stay green, unmodified, alongside
 * this file.
 */

import { createLiveSubscription, createWakeDebouncer, RealtimeConnectionManager, SseTransport } from "../dist/realtime.js";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

/**
 * A fake `RealtimeTransport` that hands its caller direct access to the
 * latest `TransportHandlers` it was given, so a test can fire
 * `onOpen`/`onError`/`onWake` synchronously on demand — no real SSE stream
 * involved. Mirrors `realtime-manager.mjs`'s `makeFakeTransport`.
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
    fireOpen(reconnected = false) {
      handlers.onOpen(reconnected);
    },
    fireError(error) {
      handlers.onError(error);
    },
    /** Terminal classification signal — the transport fires this right
     * AFTER `onError` with the same instance (design.md D6). */
    fireTerminal(error) {
      handlers.onTerminal?.(error);
    },
    fireWake() {
      handlers.onWake?.();
    },
  };
}

console.log("@indigodb/client: createLiveSubscription (D2/D3/D4/D6)");

// ─── 3.1: inert until subscribe() ────────────────────────────────────────────

await check("3.1: constructing without subscribing is inert — zero connect calls, status idle", () => {
  const fake = makeFakeTransport();
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager: new RealtimeConnectionManager(fake.transport) });

  assert(sub.getStatus() === "idle", `expected status "idle", got "${sub.getStatus()}"`);
  assert(fake.calls.connect === 0, `expected zero connect calls, got ${fake.calls.connect}`);
});

// ─── 3.2: first subscribe opens, last unsubscribe closes ───────────────────

await check("3.2: first subscribe() opens, last unsubscribe closes", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });

  const unsubA = sub.subscribe(() => {});
  assert(fake.calls.connect === 1, `expected exactly one connect() on first subscribe, got ${fake.calls.connect}`);

  const unsubB = sub.subscribe(() => {});
  assert(fake.calls.connect === 1, `expected the second subscribe() to reuse the same connect, got ${fake.calls.connect}`);

  unsubA();
  assert(fake.calls.close === 0, "expected the channel to stay open while a subscriber remains");

  unsubB();
  assert(fake.calls.close === 1, `expected exactly one close() on the last unsubscribe, got ${fake.calls.close}`);
});

// ─── 3.3: full status sequence idle→connecting→live, live⇄error ────────────

await check("3.3: full sequence idle→connecting→live, then live⇄error on a transport error", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });

  const sequence = [];
  sub.subscribe(() => sequence.push(sub.getStatus()));

  assert(sequence[0] === "connecting", `expected "connecting" first, got ${JSON.stringify(sequence)}`);
  assert(sub.getStatus() === "connecting", `expected status "connecting" before open, got "${sub.getStatus()}"`);

  fake.fireOpen(false);
  assert(sub.getStatus() === "live", `expected status "live" after open, got "${sub.getStatus()}"`);
  assert(sequence[1] === "live", `expected "live" second, got ${JSON.stringify(sequence)}`);

  fake.fireError(new Error("boom"));
  assert(sub.getStatus() === "error", `expected status "error" after a transport error, got "${sub.getStatus()}"`);

  fake.fireOpen(true); // transient auto-recovery, no retry() call
  assert(sub.getStatus() === "live", `expected status "live" again after transient auto-recovery, got "${sub.getStatus()}"`);
});

// ─── 3.4: callback fires once per transition, not per identical status ─────

await check("3.4: subscribed callback fires once per transition, not for a repeated identical status", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });

  let calls = 0;
  sub.subscribe(() => calls++);
  const afterSubscribe = calls; // "connecting" transition already counted once

  fake.fireOpen(false); // live — one more call
  assert(calls === afterSubscribe + 1, `expected exactly one more callback for the live transition, got ${calls - afterSubscribe}`);

  // A second onOpen while already "live" is NOT a status change.
  fake.fireOpen(false);
  assert(calls === afterSubscribe + 1, `expected no additional callback for a repeated identical status, got ${calls - afterSubscribe}`);
});

// ─── 3.5-3.8: debounce (D3) ──────────────────────────────────────────────────

const TEST_DEBOUNCE_MS = 40;

await check("3.5: a burst of 5 wakes in one window produces exactly one onWake, timed to the first wake", async () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  let wakes = 0;
  let fireTime = null;
  const sub = createLiveSubscription({
    table: "Order",
    transport: fake.transport,
    manager,
    debounceMs: TEST_DEBOUNCE_MS,
    onWake: () => {
      wakes++;
      fireTime = Date.now();
    },
  });
  sub.subscribe(() => {});
  fake.fireOpen(false);

  const firstWakeAt = Date.now();
  for (let i = 0; i < 5; i++) {
    fake.fireWake();
    await sleep(5);
  }
  assert(wakes === 0, `expected no synchronous onWake during the burst, got ${wakes}`);
  await sleep(TEST_DEBOUNCE_MS + 20);
  assert(wakes === 1, `expected exactly one onWake for the whole burst, got ${wakes}`);
  const elapsedFromFirstWake = fireTime - firstWakeAt;
  // If the timer had re-armed on each of the later 4 wakes, it would fire
  // ~20ms (4 * 5ms) later than the first wake's own window.
  assert(
    elapsedFromFirstWake < TEST_DEBOUNCE_MS + 15,
    `expected onWake timed to the FIRST wake's window, not extended by the later four (fired ${elapsedFromFirstWake}ms after the first wake)`,
  );
});

await check("3.6: sustained wakes every debounceMs/2 still deliver on schedule — never starved", async () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  let wakes = 0;
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager, debounceMs: TEST_DEBOUNCE_MS, onWake: () => wakes++ });
  sub.subscribe(() => {});
  fake.fireOpen(false);

  const stopAt = Date.now() + TEST_DEBOUNCE_MS * 5;
  while (Date.now() < stopAt) {
    fake.fireWake();
    await sleep(TEST_DEBOUNCE_MS / 2);
  }
  await sleep(TEST_DEBOUNCE_MS + 20);
  assert(wakes >= 2, `expected sustained wakes to still deliver multiple onWake calls (never starve), got ${wakes}`);
});

await check("3.7: wakes more than debounceMs apart each trigger their own onWake call", async () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  let wakes = 0;
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager, debounceMs: TEST_DEBOUNCE_MS, onWake: () => wakes++ });
  sub.subscribe(() => {});
  fake.fireOpen(false);

  fake.fireWake();
  await sleep(TEST_DEBOUNCE_MS + 20);
  assert(wakes === 1, `expected one onWake after the first wake's window, got ${wakes}`);

  fake.fireWake();
  await sleep(TEST_DEBOUNCE_MS + 20);
  assert(wakes === 2, `expected a second, independent onWake, got ${wakes}`);
});

await check("3.8: debounceMs: 0 delivers every wake immediately", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  let wakes = 0;
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager, debounceMs: 0, onWake: () => wakes++ });
  sub.subscribe(() => {});
  fake.fireOpen(false);

  fake.fireWake();
  fake.fireWake();
  fake.fireWake();
  assert(wakes === 3, `expected 1:1 wake delivery with debounceMs: 0, got ${wakes}`);
});

// ─── 3.9: retry() ────────────────────────────────────────────────────────────

await check("3.9: retry() from error re-opens (connecting→live); no-op while live or connecting", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });
  sub.subscribe(() => {});
  assert(fake.calls.connect === 1, "sanity: one connect after first subscribe");

  // no-op while "connecting"
  sub.retry();
  assert(fake.calls.connect === 1, `retry() while "connecting" must be a no-op, connect calls: ${fake.calls.connect}`);

  fake.fireOpen(false);
  assert(sub.getStatus() === "live", "sanity: status is live");

  // no-op while "live"
  sub.retry();
  assert(fake.calls.connect === 1, `retry() while "live" must be a no-op, connect calls: ${fake.calls.connect}`);
  assert(sub.getStatus() === "live", "status must remain live throughout a no-op retry()");

  fake.fireError(new Error("boom"));
  assert(sub.getStatus() === "error", "sanity: status is error");

  sub.retry();
  assert(sub.getStatus() === "connecting", `expected status "connecting" right after retry(), got "${sub.getStatus()}"`);
  assert(fake.calls.connect === 2, `expected retry() from error to issue a fresh connect(), got ${fake.calls.connect}`);

  fake.fireOpen(false);
  assert(sub.getStatus() === "live", `expected status "live" once the revived connect opens, got "${sub.getStatus()}"`);
});

// ─── 3.10: close() ───────────────────────────────────────────────────────────

await check("3.10: close() twice does not throw; a pending timer never fires onWake; retry() after close() is a no-op", async () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  let wakes = 0;
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager, debounceMs: TEST_DEBOUNCE_MS, onWake: () => wakes++ });
  sub.subscribe(() => {});
  fake.fireOpen(false);

  fake.fireWake(); // arms the debounce timer
  sub.close();
  sub.close(); // must not throw

  await sleep(TEST_DEBOUNCE_MS + 20);
  assert(wakes === 0, `expected the pending wake to never reach onWake after close(), got ${wakes}`);
  assert(sub.getStatus() === "closed", `expected status "closed", got "${sub.getStatus()}"`);

  fake.fireError(new Error("stale")); // fired against the (already-closed-from-our-side) channel; must not resurrect status
  sub.retry();
  assert(fake.calls.connect === 1, `retry() after close() must be a no-op, connect calls: ${fake.calls.connect}`);
});

// ─── 3.11: return shape carries no row data ─────────────────────────────────

await check("3.11: return shape is exactly {getStatus,getError,subscribe,retry,close} — no rows field, onWake arity 0", () => {
  const fake = makeFakeTransport();
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager: new RealtimeConnectionManager(fake.transport) });

  const keys = Object.keys(sub).sort();
  assert(
    keys.length === 5 && keys.join(",") === "close,getError,getStatus,retry,subscribe",
    `expected exactly {getStatus,getError,subscribe,retry,close}, got [${keys.join(", ")}]`,
  );
  assert(sub.rows === undefined, "expected no `rows` property on the returned object");
  // The core promise survives the fifth key: getError() is a transport
  // diagnostic, never a carrier of rows or RealtimeEvent payloads.
  const err = sub.getError();
  assert(err === null, `expected getError() to hold nothing before an error, got ${JSON.stringify(err)}`);
});

// ─── 3.19: getError() (D4/D6) ────────────────────────────────────────────────

/** Drives a subscription to "error" and returns the handle + the raw error. */
function subscribedWithError(terminal) {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });
  sub.subscribe(() => {});
  fake.fireOpen(false);
  const raw = new Error("realtime subscribe failed: HTTP 404");
  fake.fireError(raw);
  if (terminal) fake.fireTerminal(raw); // transport order: onError, then onTerminal
  return { fake, sub, raw };
}

await check("3.19a: getError() is null before any error — unsubscribed, connecting, and live", () => {
  const fake = makeFakeTransport();
  const manager = new RealtimeConnectionManager(fake.transport);
  const sub = createLiveSubscription({ table: "Order", transport: fake.transport, manager });

  assert(sub.getError() === null, `expected null while unsubscribed, got ${JSON.stringify(sub.getError())}`);
  sub.subscribe(() => {});
  assert(sub.getError() === null, `expected null while "connecting", got ${JSON.stringify(sub.getError())}`);
  fake.fireOpen(false);
  assert(sub.getError() === null, `expected null while "live", got ${JSON.stringify(sub.getError())}`);
});

await check("3.19b: a terminal error is retrievable as {message, terminal: true, cause}", () => {
  const { sub, raw } = subscribedWithError(true);

  const err = sub.getError();
  assert(err !== null, "expected getError() to return the triggering error, got null");
  assert(err.message === raw.message, `expected message "${raw.message}", got "${err.message}"`);
  assert(err.terminal === true, `expected terminal === true after a terminal classification, got ${err.terminal}`);
  assert(err.cause === raw, "expected cause to be the original Error instance");
});

await check("3.19c: an unclassified (transient) error is retrievable as terminal: false", () => {
  const { sub } = subscribedWithError(false);

  const err = sub.getError();
  assert(err !== null, "expected getError() to return the triggering error, got null");
  assert(err.terminal === false, `expected terminal === false with no terminal signal, got ${err.terminal}`);
});

await check("3.19d: repeated getError() calls return a referentially identical object while unchanged", () => {
  const { sub } = subscribedWithError(true);

  const first = sub.getError();
  const second = sub.getError();
  const third = sub.getError();
  assert(first !== null, "sanity: an error is held");
  assert(
    first === second && second === third,
    "expected one stable object identity across repeated getError() calls (a fresh object per call tears useSyncExternalStore)",
  );
});

await check("3.19e: getError() is cleared to null on the next successful open", () => {
  const { fake, sub } = subscribedWithError(true);
  assert(sub.getError() !== null, "sanity: an error is held before the reopen");

  fake.fireOpen(true); // the channel opens again
  assert(sub.getStatus() === "live", `sanity: expected "live" after the reopen, got "${sub.getStatus()}"`);
  assert(sub.getError() === null, `expected getError() cleared to null on the next successful open, got ${JSON.stringify(sub.getError())}`);
});

await check("3.19f: retry() clears the retrievable error while the channel re-opens", () => {
  const { sub } = subscribedWithError(true);
  assert(sub.getError() !== null, "sanity: an error is held before retry()");

  sub.retry();
  assert(sub.getStatus() === "connecting", `sanity: expected "connecting" after retry(), got "${sub.getStatus()}"`);
  assert(sub.getError() === null, `expected retry() to clear the error, got ${JSON.stringify(sub.getError())}`);
});

// ─── createWakeDebouncer, exercised directly (support for 3.5-3.8 above) ────

await check("createWakeDebouncer: first-wake-armed, never re-armed within the burst", async () => {
  let fires = 0;
  const debouncer = createWakeDebouncer(TEST_DEBOUNCE_MS, () => fires++);
  debouncer.wake();
  await sleep(TEST_DEBOUNCE_MS / 2);
  debouncer.wake(); // must not extend the window
  await sleep(TEST_DEBOUNCE_MS / 2 + 20);
  assert(fires === 1, `expected exactly one fire, got ${fires}`);
});

console.log("\n@indigodb/client: SseTransport terminal/transient classification (D6)");

// ─── 3.13/3.14: terminal vs transient, against the real SseTransport ───────

async function withMockedFetch(fn) {
  const original = globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

await check("3.13: a non-2xx that is not 5xx/408/429 (404) is terminal and halts retrying", async () => {
  await withMockedFetch(async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: false, status: 404, body: null };
    };
    const transport = new SseTransport("http://example.test");
    const errors = [];
    const terminals = [];
    const stop = transport.connect(["Order"], {
      onEvent: () => {},
      onOpen: () => {},
      onError: (e) => errors.push(e),
      onTerminal: (e) => terminals.push(e),
    });
    await waitFor(() => terminals.length === 1);
    assert(errors.length === 1, `expected onError to fire once, got ${errors.length}`);
    // Give the loop more than its 1s backoff interval to prove it does NOT reconnect.
    await sleep(1_200);
    assert(fetchCalls === 1, `expected no further connect attempt after a terminal 404, got ${fetchCalls} fetch call(s)`);
    stop();
  });
});

await check("3.14: 5xx, stream end, and a fetch TypeError all stay transient and keep retrying", async () => {
  // 500 stays transient — a second attempt occurs after backoff.
  await withMockedFetch(async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: false, status: 500, body: null };
    };
    const transport = new SseTransport("http://example.test");
    const terminals = [];
    const stop = transport.connect(["Order"], {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
      onTerminal: (e) => terminals.push(e),
    });
    await waitFor(() => fetchCalls === 1);
    await sleep(1_100); // more than the 1s backoff
    assert(fetchCalls >= 2, `expected a further connect attempt after a transient 500, got ${fetchCalls}`);
    assert(terminals.length === 0, "expected 5xx to never classify terminal");
    stop();
  });

  // A stream that ends (no error at all) reconnects too — pre-existing
  // behavior, kept as a same-family regression guard.
  await withMockedFetch(async () => {
    let fetchCalls = 0;
    const emptyBody = {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    };
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, body: emptyBody };
    };
    const transport = new SseTransport("http://example.test");
    const stop = transport.connect(["Order"], { onEvent: () => {}, onOpen: () => {}, onError: () => {} });
    await waitFor(() => fetchCalls === 1);
    await sleep(1_100);
    assert(fetchCalls >= 2, `expected a further connect attempt after the stream ends, got ${fetchCalls}`);
    stop();
  });

  // A fetch TypeError (offline/DNS/CORS — indistinguishable) stays transient.
  await withMockedFetch(async () => {
    let fetchCalls = 0;
    const terminals = [];
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new TypeError("Failed to fetch");
    };
    const transport = new SseTransport("http://example.test");
    const stop = transport.connect(["Order"], {
      onEvent: () => {},
      onOpen: () => {},
      onError: () => {},
      onTerminal: (e) => terminals.push(e),
    });
    await waitFor(() => fetchCalls === 1);
    await sleep(1_100);
    assert(fetchCalls >= 2, `expected a further connect attempt after a fetch TypeError, got ${fetchCalls}`);
    assert(terminals.length === 0, "expected a fetch TypeError to never classify terminal, even though CORS can produce one");
    stop();
  });
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
