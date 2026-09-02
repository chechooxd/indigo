# Proposal: Bound SSE write buffering in `RealtimeEngine`

## Intent

Four `res.write()` sites in `packages/realtime/src/engine.ts` (`:177` heartbeat, `:237` ready,
`:407` wake, `:411` change) discard the boolean return value. When a socket stops draining, Node
buffers every subsequent frame in the process heap with no cap. One stalled SSE subscriber grows
server memory until the process dies. Success = a stalled subscriber costs a bounded, configurable
number of bytes and is then dropped, observably.

**The LSN-acknowledgment stall is REFUTED, not confirmed.** `dispatch()` is
`private dispatch(event): void` — synchronous. `WalSource.flushCommit` calls `onEvent(event)`
synchronously (`wal-source.ts:551`) *then* `await service.acknowledge(commitLsn)` (`:556`).
Subscriber slowness is already decoupled from replication ack. **Constraint, not preference: any
design that makes `dispatch()` async introduces coupling that does not exist today.** Unbounded
heap growth is the whole defect.

## Scope

### In Scope
- `Subscriber` gains no queue; all four write sites route through one `send(sub, frame)` helper.
- `send()` probes `sub.res.writableLength` **before** writing; over cap → evict.
- Eviction = remove from `this.subscribers`, best-effort `event: overflow` frame, `res.end()`.
- Operator signal: each eviction reports through the existing `onError` hook.
- New option `RealtimeEngineOptions.maxBufferedBytes` (default 1 MiB).
- Coverage extended **inside `packages/realtime/test/dispatch.mjs`** (see Testing).

### Out of Scope / Non-Goals
- Making `dispatch()` async or awaiting `drain` (approach 3 — reintroduces the refuted coupling).
- A userland per-subscriber queue (approach 4) — see Approach.
- Event coalescing (approach 2) — helps only data-free `wake`; `change` frames carry distinct rows.
- Auto-resync for raw `RealtimeModelDelegate.subscribe()`. **Recommended position: defer.** It is a
  `packages/client` change, pre-existing, and outside this engine scope. Recorded as a follow-up.
- Wiring `REALTIME_LOG_PATH` replay. It has **zero client call sites**; eviction is NOT justified
  by "the client can replay."

## Capabilities

### New Capabilities
- `realtime-sse-backpressure`: bounded per-subscriber write buffering, eviction policy, eviction
  observability, and heartbeat-as-liveness-probe.

### Modified Capabilities
- None. Per exploration, `realtime-wal-source`'s log→dispatch→ack requirement constrains call
  order only; `realtime-live-endpoint` frame shapes are unchanged; `studio-live-view`'s
  reconnect-refetches requirement already covers post-eviction behavior.

## Approach

**Chosen: approach 1, refined into a pre-write watermark probe.** Rejecting approach 4 is the
load-bearing call: a userland queue **does not reduce memory, it relocates it** — the same bytes
move from Node's socket buffer into our array, plus drain-listener lifecycle and leak risk. Node's
socket buffer is already a queue; it only lacks a bound. `res.writableLength` supplies the exact
buffered byte count, so the fix is to read it and stop. `dispatch()` stays synchronous trivially,
with no new lifecycle state.

Probing *before* the write means a single oversized frame cannot self-evict a healthy socket; a
subscriber is evicted only when prior frames are already unflushed past the cap.

### Policy decisions this proposal settles (design to specify normatively)

| Question | Decision | Justification |
|---|---|---|
| Cap unit | **Bytes** | A `wake` frame is ~80 B fixed; a `change` frame carries an unbounded projected row body. An event-count cap bounds N × unbounded = unbounded. `writableLength` is natively bytes. |
| Cap value | **1 MiB**, configurable | Node's default socket highWaterMark is **64 KiB** (`writableHighWaterMark` measured as 65536 on both `net.Socket` and `http.ServerResponse` under this repo's Node v22.23.2 — NOT the 16 KiB figure that appears in older Node documentation). A healthy socket sits near 0 and spikes to ~64 KiB. 1 MiB is 16x above that, so it separates "busy" from "stalled". Load justification: `useLiveTable` reconnect triggers a **full table refetch**, so an aggressive cap converts a memory problem into a query-load problem. 1 MiB ≈ 13k queued `wake` frames or ~1k 1 KB `change` frames — unreachable by jitter. |
| What the evicted client observes | **Stream termination**, mandatory | This repo already shipped a UI reading `live` over a dead stream (`realtime-start-contract` defect 3). Silently dropping frames on an open connection repeats that exact failure. `res.end()` makes `SseTransport.readStream()` see `done: true` → reconnect → `onOpen(reconnected)` → full refetch. The `event: overflow` frame is best-effort only; the contract must not depend on a backed-up socket flushing it. |
| Heartbeat (`:177`) | **Same path, same cap** | It is the only site writing to *every* subscriber on a timer, so for an idle subscriber it is the sole probe that will ever detect a stalled socket. Excluding it leaves idle stalled sockets undetected and lets pings accumulate unbounded. |

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/realtime/src/engine.ts` | Modified | `send()` helper, `evict()`, `maxBufferedBytes` option, 4 call sites rerouted |
| `packages/realtime/test/dispatch.mjs` | Modified | Backpressure scenarios + updated `ran` count |
| `openspec/specs/realtime-sse-backpressure/` | New | New capability spec |

## Testing (must actually bite)

Every promised test must fail against the current tree:

1. Fake `res` with `writableLength` above cap → dispatch → assert `res.end()` called and subscriber
   removed (a second dispatch writes nothing). **Today**: `end` is never called and the second
   write lands. Fails.
2. Heartbeat tick over a stalled subscriber evicts it. **Today**: `:177` writes unconditionally. Fails.
3. **Negative control**: `writableLength` at cap − 1 is NOT evicted. Guards against a rule that
   evicts everyone — the repo's recurring "green signal that verifies nothing" failure mode.
4. Eviction reports through `onError`.

Coverage goes **into `dispatch.mjs`**, not a new file: `scripts/check-realtime-projection-db-gate.mjs`
greps a **fixed file list**, so a new file would be unguarded. Suite ends with an updated
`strictEqual(ran, <exact count>)` reachability guard. Passes with `INDIGODB_TEST_DATABASE_URL` unset.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cap too low → eviction storm → full-refetch query load | Med | 1 MiB is 16x the measured 64 KiB highWaterMark; configurable; `onError` makes evictions countable |
| Raw `subscribe()` consumers silently lose events more often | Med | Pre-existing; documented in spec as a known lossy path; filed as follow-up |
| A design drifts toward async `dispatch()` | Low | Stated as a hard constraint here and to be a normative spec requirement |
| Fake `ServerResponse` diverges from real `ServerResponse` semantics | Low | `writableLength` is a plain readable number on real streams — trivially faithful, unlike simulating `drain` events |

## Rollback Plan

Single-commit revert. `send()` is a pure additive indirection over four call sites; reverting
restores unguarded `res.write()`. No schema, migration, wire-format, or client change — the
`event: overflow` frame is optional and unknown event types are ignored by `SseTransport`.

## Dependencies

None. No new packages, no client-side change required.

## Delivery Forecast

Estimated authored change: ~200–260 lines (engine ~+75/−8, tests ~+130, spec ~+60).
**Fits the 800-line review budget as a single PR.** No chaining needed.

## Success Criteria

- [x] All four write sites route through the bounded `send()` path. Evidence:
      `openspec/changes/realtime-sse-backpressure/tasks.md` task 2.4 — heartbeat, `ready`, `wake`,
      and `change` all reroute to `this.send(sub, frame)` in `packages/realtime/src/engine.ts`.
- [x] `dispatch()` remains synchronous and `void`-returning. **The original wording ("verified by a
      typecheck-level guard") was replaced per the design's documented correction** — no such
      typecheck guard is achievable (a value-returning callback still satisfies `void` in TS; see
      design's "Two input corrections" section). Evidence instead: `dispatch()`'s signature is
      unchanged (task 2.6) and RSB-2's runtime synchrony assertion in `dispatch.mjs` (task 3.1)
      asserts the stalled subscriber is evicted and the healthy one delivered immediately after
      `emit()` returns, with no `await` in between — plus the review-time constraint recorded in
      the design.
- [x] A stalled subscriber's buffered bytes never exceed `maxBufferedBytes` + one frame. Evidence:
      `tasks.md` tasks 1.2–1.4, 1.6, 1.7 (RSB-1, RSB-3, RSB-6, RSB-10, RSB-11) confirm eviction
      triggers before an over-cap write lands.
- [x] An evicted subscriber's stream is terminated, never left open-and-silent. Evidence: `tasks.md`
      task 1.3/1.4 (RSB-3/RSB-5/RSB-6) — `isEnded()` is asserted `true` and the registry no longer
      holds the subscriber, including when the overflow frame cannot be flushed.
- [x] New coverage passes with `INDIGODB_TEST_DATABASE_URL` unset and is inside the DB-gate guard's
      file list. Evidence: `tasks.md` tasks 4.3 and 5.3 —
      `scripts/check-realtime-projection-db-gate.mjs` passes; `dispatch.mjs` was already in
      `GUARDED_FILES`.
- [x] The negative control (cap − 1 not evicted) passes, proving the guard is not trivially true.
      Evidence: `tasks.md` task 3.3's mandatory mutation proof — flipping the probe comparison
      (`>` → `>=`) and separately swapping the probe source (`writableLength` → `write()`'s boolean
      return) both made the negative control fail, then both were reverted and the suite confirmed
      clean (17/17) again.

## Proposal question round

Execution mode is `auto`, so these assumptions were decided rather than asked. Flag for correction
before design if any is wrong:

1. 1 MiB default cap — is a stalled subscriber holding 1 MiB acceptable for the standalone
   `indigodb realtime` daemon's expected subscriber count?
2. Deferring raw `subscribe()` auto-resync — accepted as a documented lossy path?
3. Eviction is per-subscriber only; no global memory ceiling across all subscribers. In scope?

---

## Orchestrator correction (post-authoring, measured not assumed)

The cap justification above originally anchored on a 16 KiB default socket highWaterMark. That is
wrong for this repo's runtime. Measured directly on Node v22.23.2:

```
net.Socket        writableHighWaterMark = 65536  (64 KiB)
http.ServerResponse writableHighWaterMark = 65536  (64 KiB)
```

The 1 MiB cap therefore sits 16x above the watermark, not two orders of magnitude above it. The
decision stands — 16x still cleanly separates a busy socket from a stalled one — but the design
phase must use the measured 64 KiB figure when reasoning about how much jitter headroom the cap
actually buys, and must not inherit the 16 KiB number.

Also measured, and relevant to the probe's semantics: `res.writableLength` on an
`http.ServerResponse` includes HTTP chunk framing and header bytes, not only the payload written
(a 100-byte `write()` produced `writableLength = 270` on a fresh response). The probe is therefore
conservative by a small constant — acceptable for a 1 MiB cap, but the design must not claim
`writableLength` equals bytes-of-SSE-payload-pending.
