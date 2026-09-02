# Archive Report: `realtime-sse-backpressure`

**Change**: `realtime-sse-backpressure`
**Archived to**: `openspec/changes/archive/2026-09-02-realtime-sse-backpressure/`
**Status**: Complete, single PR merged to main, 0 CRITICAL issues remain open

---

## Final State Authority

| Commit | Scope |
|---|---|
| `7f9e0b7` | `feat(realtime): bound SSE write buffering with per-subscriber eviction` — implementation + 9 test cases |
| `addaaa1` | `docs(sdd): record independent reproduction of the RSB-4 mutation proof` |
| `291348d` | `test(realtime): prove evict()'s idempotence guard with a mutation-checked case` — closes verify's WARNING |

**Base**: `main`@`d889745`
**Implementation tasks**: 26 complete (Phases 1–5)
**Verification verdict**: PASS WITH WARNINGS — 0 CRITICAL, 1 WARNING (closed post-verify), 1 SUGGESTION (open)
**Suite**: `packages/realtime/test/dispatch.mjs` — 18/18, guard `strictEqual(ran, 18, …)` counted from an actual run
**Root gate**: `pnpm clean && pnpm build --force && pnpm lint && pnpm test` → exit 0, `Tasks: 18 successful, 18 total`

---

## What This Change Did

`RealtimeEngine` had four `res.write()` call sites (`:177` heartbeat, `:237` ready, `:407` wake,
`:411` change) that ignored the boolean return value of every one. No `drain` handling, no buffer
cap. When `res.write()` returns `false`, Node buffers the unwritten bytes in the process heap for
that socket, unbounded — so one slow or stalled SSE subscriber accumulated every subsequent event
in server memory with nothing to stop it. A memory leak wearing a feature's clothes.

All four sites now route through one `send(sub, frame)` that reads `res.writableLength` **before**
writing and compares it against a configurable `maxBufferedBytes` (default 1 MiB). Over cap, the
frame is not written and the subscriber is evicted via `evict()`: removed from the registry, sent a
best-effort `event: overflow` frame, and `res.end()`. `dispatch()` stays synchronous.

### Design decisions worth carrying forward

- **Bound Node's own buffer; do not build a second one.** A userland per-subscriber queue does not
  reduce memory, it *relocates* it — the same bytes move from the socket buffer into an array, plus
  drain-listener lifecycle and leak risk. The socket buffer is already a queue; it only lacked a
  bound, and `writableLength` supplies the exact figure.
- **Probe before the write, not after.** Probing after means a single oversized frame can evict an
  otherwise-healthy socket.
- **`dispatch()` MUST stay synchronous — and nothing enforces it.** `WalSource.flushCommit` calls
  `onEvent(event)` synchronously (`wal-source.ts:551`) and only then `await
  service.acknowledge(commitLsn)` (`:556`), so subscriber slowness is decoupled from replication
  acknowledgment. An async dispatch would introduce that coupling and convert a bounded memory
  problem into an unbounded replication-slot/disk problem. **There is no typecheck that catches the
  drift**: the only call site is a callback in `void` position, where TypeScript accepts a
  value-returning function. The constraint is stated in the spec, the design, the tasks and the code
  comment because the compiler cannot hold it.
- **Eviction is lossless for `.live()` and `useLiveTable` because they REFETCH, not because they
  replay.** Both force a full refetch on reconnect/resync. `REALTIME_LOG_PATH` has zero client call
  sites — never justify eviction with replay availability.
- **Cap measured in bytes, not events.** A `wake` frame is data-free and fixed-size; a `change`
  frame carries an unbounded projected row body, so an event-count cap bounds N × unbounded.

---

## Refuted During Exploration

The orchestrator hypothesized that a slow subscriber could stall LSN acknowledgment and grow the
Postgres replication slot until the user's disk filled — a far more serious failure than heap
growth. **This was refuted, not confirmed**, and verified directly: `dispatch()` is
`private dispatch(event: RealtimeEvent): void`. The hypothesis is recorded here because the
refutation became the change's single most important design constraint — the one approach that
would have "fixed" backpressure by awaiting drain is precisely the one that would have created the
failure that did not exist.

---

## What the Mutations Found — three green signals that verified nothing

This change's real yield was not the eviction logic. It was three tests, criteria and assumptions
that looked correct, passed, and proved nothing until something forced them to fail.

1. **The negative control at `cap - 1` could not detect its own mutation.** RSB-4 asserts a
   subscriber one byte below the cap is not evicted. Under the mutation `>` → `>=`, `cap - 1`
   evaluates identically, so RSB-4 passed against a mutated build and would have reported the
   control as proven. Found by the apply phase, which added **RSB-4b** on the exact boundary and
   pinned the fixture's `hwm` to the cap. Confirmed independently: mutation `>` → `>=` fails
   RSB-4b **only**.
2. **A success criterion the compiler could not enforce.** The proposal promised `dispatch()`'s
   synchrony would be "verified by a typecheck-level guard". The design established no such guard
   can exist and replaced it with a runtime assertion plus a stated review-time constraint, rather
   than carrying an unenforceable guarantee into implementation.
3. **A test aimed at a code path that does not exist.** RSB-12 was first written to reach `evict()`'s
   idempotence guard through the teardown sequence, on the design's claim that `res.end()` →
   `req.on("close")` re-enters `evict()`. It passed — and still passed with the guard mutated away.
   `handleRequest`'s close listener calls `this.subscribers.delete(sub)` **directly**
   (`engine.ts:252-254`); it never re-enters `evict()`. The guard is defensive, no black-box path
   reaches it, and RSB-12 was rewritten as an honest white-box double-call. It now fails when the
   guard is removed.

The common thread: each was answered only by asking *would this go red if the code were wrong?* —
a question a passing suite never answers on its own.

---

## Specs Synced to Source of Truth

### NEW Capability
- **`realtime-sse-backpressure`** — 8 requirements, 12 scenarios: the single bounded write path,
  `dispatch()`'s synchrony, the pre-write probe and eviction thresholds, iteration safety during a
  broadcast, stream termination as the observable signal, `onError` reporting, the documented raw
  `subscribe()` lossy path, and the no-database coverage guarantee.

No MODIFIED deltas. `realtime-live-endpoint`, `realtime-source-contract`, `realtime-wal-source` and
`studio-live-view` were each reviewed; none of their requirements changed meaning.

---

## Open Follow-Ups (deliberately out of scope)

- **RSB-6 covers only a `write()` that returns `false`, not one that THROWS** (verify's SUGGESTION).
  `evict()` wraps both the overflow write and `res.end()` in `try/catch`, so the behavior is
  implemented but the throwing path is unproven by test.
- **No global memory ceiling across subscribers.** The cap is per-subscriber, so N stalled
  subscribers still hold N × `maxBufferedBytes`. Scoped deliberately; a fleet-wide ceiling is a
  separate decision.
- **Raw `RealtimeModelDelegate.subscribe()` has no auto-resync**, so an evicted subscriber silently
  misses events unless the application supplies its own recovery. Pre-existing and documented in the
  `maxBufferedBytes` doc comment — but this change makes it fire more often, which raises its
  priority.
- **`useLiveTable` reconnects with a full table refetch**, so an aggressive cap trades a memory
  problem for a query-load problem. 1 MiB sits 16x above the measured 64 KiB `writableHighWaterMark`
  (Node v22.23.2 — the widely-cited 16 KiB figure is stale), which is the headroom that argument
  rests on. Revisit if evictions are ever observed in practice; `onError` makes them countable.
