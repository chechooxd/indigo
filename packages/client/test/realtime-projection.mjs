/**
 * `RealtimeModelDelegate.subscribe()` — column-projection pass-through
 * (`realtime-column-projection`, spec `realtime-live-endpoint`, tasks.md
 * 4.5-4.9). No DB, no network: drives `subscribe()` with a fake
 * `RealtimeConnectionManager` whose `subscribe(model, listener)` calls
 * `listener.onEvent(event)` synchronously, following the same
 * `fakeSource`-style pattern `dispatch.mjs` uses for `RealtimeEngine`, and
 * `realtime-entry.mjs`'s plain-Node `check()`/`assert()` style.
 *
 * The events fed in here are already projected — narrowing happens once,
 * write-time, in `WalSource`/`PgNotifySource` (`packages/realtime`). This
 * suite proves the client-side delegate does not undo that: it forwards
 * `new`/`old` verbatim to `onInsert`/`onUpdate`/`onDelete`/`onChange`,
 * whether the event is narrow (RLE-4) or bare/full (RLE-5), and pins the
 * one place this codebase intentionally re-widens (RLE-4's sibling, DX-5).
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { RealtimeModelDelegate } from "../dist/index.js";

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

/** Fake `RealtimeConnectionManager`: `subscribe()` captures the listener and
 * exposes `emit(event)` to drive it synchronously — no transport, no DB. */
function fakeRealtime() {
  let listener = null;
  return {
    manager: {
      subscribe(_model, l) {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit(event) {
      ok(listener, "subscribe() must register a listener before an event can be emitted");
      listener.onEvent(event);
    },
  };
}

function makeDelegate() {
  const meta = { name: "Post", table: "Post", fields: {} };
  const exec = async () => {
    throw new Error("exec must not be called by this suite — no partial refetch is exercised");
  };
  const { manager, emit } = fakeRealtime();
  const delegate = new RealtimeModelDelegate(meta, exec, () => manager, "Post");
  return { delegate, emit };
}

// ── RLE-4 — subscriber receives fewer keys after adopting `columns` ────────

await check("RLE-4: onInsert receives only the projected keys the wire event already carries", async () => {
  const { delegate, emit } = makeDelegate();
  const received = [];
  delegate.subscribe({ onInsert: (e) => received.push(e) });
  emit({
    table: "Post",
    op: "INSERT",
    pk: { id: "1" },
    new: { id: "1", status: "ok" }, // already narrowed upstream — passwordHash never here
    ts: "2026-01-01T00:00:00.000Z",
  });
  await Promise.resolve();
  strictEqual(received.length, 1);
  deepStrictEqual(Object.keys(received[0].new).sort(), ["id", "status"]);
  ok(!("passwordHash" in received[0].new), "a projected-out field must be simply absent, not present as undefined");
});

await check("RLE-4: onUpdate receives projected new/old alike", async () => {
  const { delegate, emit } = makeDelegate();
  const received = [];
  delegate.subscribe({ onUpdate: (e) => received.push(e) });
  emit({
    table: "Post",
    op: "UPDATE",
    pk: { id: "1" },
    new: { id: "1", status: "ok" },
    old: { id: "1", status: "pending" },
    ts: "2026-01-01T00:00:00.000Z",
  });
  await Promise.resolve();
  strictEqual(received.length, 1);
  deepStrictEqual(Object.keys(received[0].new).sort(), ["id", "status"]);
  deepStrictEqual(Object.keys(received[0].old).sort(), ["id", "status"]);
});

// ── RLE-5 — non-projected model's subscriber is unaffected ─────────────────

await check("RLE-5: a bare-@@realtime event reaches onInsert/onUpdate/onDelete with every key intact", async () => {
  const { delegate, emit } = makeDelegate();
  const inserts = [];
  const updates = [];
  const deletes = [];
  delegate.subscribe({
    onInsert: (e) => inserts.push(e),
    onUpdate: (e) => updates.push(e),
    onDelete: (e) => deletes.push(e),
  });

  emit({
    table: "Post",
    op: "INSERT",
    pk: { id: "1" },
    new: { id: "1", status: "ok", passwordHash: "s" },
    ts: "2026-01-01T00:00:00.000Z",
  });
  emit({
    table: "Post",
    op: "UPDATE",
    pk: { id: "1" },
    new: { id: "1", status: "shipped", passwordHash: "s2" },
    old: { id: "1", status: "ok", passwordHash: "s" },
    ts: "2026-01-01T00:00:00.000Z",
  });
  emit({
    table: "Post",
    op: "DELETE",
    pk: { id: "1" },
    old: { id: "1", status: "shipped", passwordHash: "s2" },
    ts: "2026-01-01T00:00:00.000Z",
  });
  await Promise.resolve();

  strictEqual(inserts.length, 1);
  strictEqual(updates.length, 1);
  strictEqual(deletes.length, 1);
  deepStrictEqual(Object.keys(inserts[0].new).sort(), ["id", "passwordHash", "status"]);
  deepStrictEqual(Object.keys(updates[0].new).sort(), ["id", "passwordHash", "status"]);
  deepStrictEqual(Object.keys(updates[0].old).sort(), ["id", "passwordHash", "status"]);
  deepStrictEqual(Object.keys(deletes[0].old).sort(), ["id", "passwordHash", "status"]);
});

// ── DX-5 — the `partial` refetch re-widens on the v1 source (documented,
//    accepted current behaviour; explicitly out of scope to close here) ────

await check("DX-5: event.partial triggers a full findFirst refetch, which re-widens beyond any projection (documented, not closed)", async () => {
  const meta = { name: "Post", table: "Post", fields: {} };
  const fullRow = { id: "1", status: "ok", passwordHash: "s3cr3t-refetched" };
  let findFirstCalledWith = null;
  const exec = async () => {
    throw new Error("unused — findFirst is overridden below");
  };
  const { manager, emit } = fakeRealtime();
  const delegate = new RealtimeModelDelegate(meta, exec, () => manager, "Post");
  // `findFirst` is `ModelDelegate`'s own SQL-building method; stub it
  // directly rather than standing up a real executor, since this test's
  // only concern is what `subscribe()`'s dispatch loop does with the
  // refetched row, not SQL generation.
  delegate.findFirst = async ({ where }) => {
    findFirstCalledWith = where;
    return fullRow;
  };

  const received = [];
  delegate.subscribe({ onInsert: (e) => received.push(e) });
  emit({
    table: "Post",
    op: "INSERT",
    pk: { id: "1" },
    partial: true, // oversized NOTIFY payload — no `new` on the wire at all
    ts: "2026-01-01T00:00:00.000Z",
  });
  // dispatch() is async (awaits findFirst) — let its microtask settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  deepStrictEqual(findFirstCalledWith, { id: "1" }, "the refetch must key on event.pk");
  strictEqual(received.length, 1);
  deepStrictEqual(
    received[0].new,
    fullRow,
    "documented current behaviour: the partial refetch returns the FULL row via the caller's own DB access, " +
      "re-widening past any write-time column projection — recorded as an accepted risk in design.md, not closed here",
  );
});

// RCP-13 reachability guard: fails loudly if a case above is skipped/omitted.
// This whole file also runs unconditionally, with no database gate at all —
// enforced repo-wide by scripts/check-realtime-projection-db-gate.mjs.
strictEqual(ran, 4, "expected exactly 4 check() cases to run in realtime-projection.mjs");

console.log(`\n${passed}/${ran} passed`);
if (process.exitCode) process.exit(process.exitCode);
