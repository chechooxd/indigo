# Exploration: SSE backpressure in `RealtimeEngine`

**Change**: `realtime-sse-backpressure`
**Phase**: `sdd-explore`
**Engram**: `sdd/realtime-sse-backpressure/explore` (obs #873)

---

## Current State

`packages/realtime/src/engine.ts` has four `res.write()` call sites and ignores the
boolean return value of every one:

| Site | Frame | Trigger |
|---|---|---|
| `:177` | `:ping\n\n` | heartbeat loop over `this.subscribers` |
| `:237` | `event: ready` | on connect |
| `:407` | `event: wake` | `@@allow`-protected models (data-free) |
| `:411` | `event: change` | ordinary projected payload |

There is no `drain` handling, no `writableLength`/`writableHighWaterMark` check, and no
per-subscriber buffer cap anywhere in the file. The `Subscriber` record is `{res, tables, seq}`
— it carries no state that backpressure could hang off today.

When `res.write()` returns `false`, Node buffers the unwritten bytes in the process heap for
that socket, unbounded. One slow or stalled SSE subscriber accumulates every subsequent event
in server memory with nothing to bound it.

## Refuted: the LSN-acknowledgment stall

The orchestrator hypothesized a more serious second-order failure — that a slow subscriber could
stall replication acknowledgment and grow the Postgres replication slot, filling the user's disk.

**This does not exist in the current code.** `dispatch()` is declared `private dispatch(event:
RealtimeEvent): void` (`engine.ts:397`) — synchronous and fire-and-forget. `WalSource.flushCommit`
calls `onEvent(event)` synchronously at `wal-source.ts:551` and only then `await
service.acknowledge(commitLsn)` at `:556`. `res.write()` never blocks, so subscriber slowness is
decoupled from ack timing. The `realtime-wal-source` spec's "log write precedes dispatch, which
precedes acknowledgment" constrains **call order only**, not downstream I/O completion.

The only real failure is unbounded process-heap growth.

**This refutation is load-bearing for design**: any approach that makes `dispatch()` async would
*introduce* the coupling that does not exist today. Preserving the non-blocking property is a
constraint, not a nice-to-have.

## Blast Radius — per consumer, verified

1. **`apps/studio/.../useLiveTable.ts`** — safe under eviction. Reconnect
   (`onOpen(reconnected=true)`) forces an immediate full `fetchTableRows`, bypassing the debounce.
   Never uses the replay log.
2. **`.live()`** (`packages/client/src/live.ts`) — safe under eviction. `onResync` forces an
   immediate full `findMany` refetch. Documented as never calling `GET ?handle&offset`.
3. **Raw `RealtimeModelDelegate.subscribe()`** — **unsafe**. Exposes `onResync` but has no
   built-in refetch; an evicted subscriber silently misses events unless the application supplies
   its own resync logic, and none does today. Pre-existing gap, but eviction makes it fire more often.
4. **`REALTIME_LOG_PATH` replay log** — fully implemented server-side but **unused by any shipped
   client path**. `packages/client/src` re-exports `REALTIME_PATH` only; the log path has zero
   client call sites.

**Consequence**: "eviction is safe because the client can replay" is the wrong framing for every
current consumer. Eviction is safe for two of them because they *refetch from scratch*, not
because they replay.

## Existing Test Surface

`packages/realtime/test/dispatch.mjs`'s fake `ServerResponse`/fake `RealtimeSource` pattern
extends naturally to simulate `write()` returning `false` and later emitting `drain`. It ends with
a `strictEqual(ran, 6, ...)` reachability guard plus two further checks.

`scripts/check-realtime-projection-db-gate.mjs` greps a **fixed file list** for zero
`INDIGODB_TEST_DATABASE_URL` references. A new backpressure test file is not in that list — so
design must either extend `dispatch.mjs` (auto-covered) or extend the guard's list. Otherwise the
repo's "new realtime coverage runs without a database" guarantee is unenforced for this change.

## Prior Art

None. No backpressure, queue-cap, or slow-consumer handling exists anywhere in `packages/`.

## Design Space (options, not a decision)

| # | Approach | Pros | Cons | Effort |
|---|---|---|---|---|
| 1 | Bounded buffer + evict on overflow (`res.end()`) | Simple; lossless for `.live()`/`useLiveTable` | Lossy for raw `subscribe()` | Low–Med |
| 2 | Coalesce pending events per table | Cheap for data-free `wake` frames | Does not help `change` frames — each carries distinct row data | Med |
| 3 | `await`-drain with timeout, evict on timeout | Bounds memory precisely | Requires making `dispatch()` async — reintroduces the ack coupling refuted above | Med–High |
| 4 | Bounded per-subscriber queue + drain-driven flush, `dispatch()` stays sync | Best isolation; preserves the non-blocking property | Most code | High |

## Relevant Specs

Reviewed `realtime-live-endpoint`, `realtime-source-contract`, `realtime-wal-source`, and
`studio-live-view`. **No existing requirement contradicts a backpressure eviction policy.** The one
that sounded relevant (`realtime-wal-source`'s log→dispatch→ack ordering) constrains call order
only. No spec currently covers SSE backpressure at all, so this needs a new capability rather than
only modifications.

## Risks Carried Forward

1. Any async-drain design must preserve `dispatch()`'s non-blocking property, or it newly couples
   slow subscribers to WAL ack timing — the exact failure this exploration refuted.
2. New coverage must be wired into the DB-gate guard convention or the no-database guarantee is
   unenforced.
3. Raw `subscribe()` consumers get no automatic resync on eviction — silent data loss. Pre-existing
   and out of scope, but this change increases how often it fires.
4. `useLiveTable` reconnects with a *full table refetch*: an eviction policy that evicts often turns
   a memory problem into a query-load problem. Whatever cap is chosen must be justified against that.

## Ready for Proposal

Yes. Open questions (buffer cap as bytes vs. event count; whether to also close raw `subscribe()`'s
missing resync) are proposal/design decisions, not exploration blockers.
