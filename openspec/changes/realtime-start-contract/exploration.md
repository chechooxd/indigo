# Exploration: `realtime-start-contract`

**Engram**: `sdd/realtime-start-contract/explore`

> Persisted by the orchestrator. The `sdd-explore` agent has no Write/Edit tool by definition,
> and in this run had no Bash tool either — so its findings are established by code inspection,
> which it disclosed. The orchestrator had already measured the runtime behaviour independently
> against real Postgres 17 (see "Runtime measurements" below); the two agree.

## Runtime measurements (orchestrator, real Postgres 17)

| Probe | Result |
|---|---|
| `WalSource.start()` on a healthy stream, slot exists | **still pending at 8s** |
| `RealtimeEngine.start()` with a source bound to an existing slot | **still pending at 10s** |
| `RealtimeEngine.start()` with the slot MISSING | resolves in 17ms after logging `replication slot "indigo_realtime" does not exist` |

That third row is the trap: it reports a false all-clear. Exploration then found *why*, and it is
not the reason anyone assumed — see bug 2.

## 1. Both consequences confirmed

**A — every DB-gated suite that awaits `start()` hangs unconditionally.** `parity.mjs:114`,
`resume.mjs:51,67,88,127`, `log.mjs:75,109,148` all `await source.start(...)` against a genuinely
existing slot from `pg-harness.mjs`'s `withReplicationFixture`. `start()` (`wal-source.ts:173-182`)
awaits `connect()`, which at `wal-source.ts:286` awaits `service.subscribe(plugin, this.slot)` —
and line 287's own comment says that resolves "once the stream ends". A healthy stream never ends.

**B — production.** `packages/cli/src/studio-server.ts:823` (`if (engine) await engine.start();`,
before `createServer`) and `packages/cli/src/index.ts:269` (`await engine.start()` then
`server.listen`) both gate port binding on this. For a schema with `@@realtime` and a correctly
provisioned slot, neither `indigodb studio` nor `indigodb realtime` ever binds.

## 2. Two bugs, not one

### Bug 1 — the `RealtimeSource` seam has no shared contract

`PgNotifySource.start()` (`source.ts:54-96`) resolves as soon as `client.connect()` +
`client.query('LISTEN ...')` succeed. `WalSource.start()` resolves only at stream end. The two
implementations of the same interface mean opposite things by "started", while
`wal-source.ts:178-180`'s comment explicitly claims parity between them. `protocol.ts`'s
`start(onEvent, onError): Promise<void>` therefore has no honest meaning. **This is the real bug
underneath the symptom.**

### Bug 2 — `start()` never rejects on an initial connect failure (previously unnoted)

`connect()`'s catch block (`wal-source.ts:307-320`) contains dead code. The first
`if (this.service !== service || this.stopped) return;` already exhausts every path where
`this.stopped` is true, so the later `if (!this.stopped) this.scheduleReconnect(...); else throw
err;` can never reach `throw err` on a normal, non-superseded initial attempt — `!this.stopped` is
always true there. `WalSource.start()` therefore **silently resolves** on a missing slot or an auth
failure, via the schedule-reconnect fallthrough.

So `wal-source.ts:178-180`'s "initial connect failures throw so a daemon fails fast with a clear
error" is **currently false**. `PgNotifySource.connect()` has no try/catch around
`client.connect()`/`client.query()` at all, so it genuinely does propagate — independent
confirmation of the asymmetry.

This is also the true explanation of the missing-slot probe resolving fast: not that fail-fast
works, but that the throw path is unreachable.

## 3. Consumer map — what "started" must guarantee

| Consumer | Needs |
|---|---|
| `engine.ts:156` | the source *accepting a live stream*, then it wires the heartbeat. Never needs "stream ended". |
| `studio-server.ts:823` | blocks the **entire** Studio server — schema, table and query routes included, none of which touch realtime. Overly conservative even after the fix; only the SSE endpoint and dispatch need a live stream. Flagged as a possible follow-on simplification, not required here. |
| `cli/index.ts:269` | same shape for the standalone daemon; `listen()` should follow "stream confirmed live". |
| `parity.mjs`, `resume.mjs`, `log.mjs` | need no edits — they simply start completing. |

## 4. Reconnect machinery — leave it alone

Recommended shape: leave `connect()`'s internals **completely unchanged** — the `subscribe()`
await, both supersession checks (`wal-source.ts:279,300`), the orphaned-socket guard whose comment
cites the 46-minute CI hang and `process._getActiveHandles()`, and `scheduleReconnect()`.

**None of those guards exist because `start()` awaits `subscribe()`.** They exist for `connect()`'s
own reconnect bookkeeping regardless of what the outer caller awaits. That answers the orchestrator's
concern directly: detaching the promise does not undermine them.

Instead add a one-shot **ready deferred**: resolve it inside the existing
`service.on("start", ...)` handler (`wal-source.ts:238`, already fires once Postgres acks
`START_REPLICATION`); reject it from the catch path — but **only for the first `connect()` issued
directly by `start()`**, never for later `scheduleReconnect()`-driven attempts. `start()` awaits
only that deferred; the outer `connect()` promise keeps running detached and needs a
`.catch(() => {})` once nothing awaits it, to avoid an unhandled rejection.

Additive only, and as a side effect it finally implements the fail-fast contract that never worked.
**The one way to reintroduce bugs is getting the "first attempt only" scoping wrong** — resolving
or rejecting the deferred again on a later reconnect. That needs its own unit test.

## 5. Preserving the initial-failure signal

Race `service.on("start")` (readiness) against the `subscribe()` promise's own rejection (failure);
whichever fires first is authoritative. The library's semantics guarantee the stream cannot end
before it starts, so `subscribe()` cannot spuriously win. This reuses wiring that already exists
rather than adding an `onReady` callback, which would break `RealtimeSource`'s `start`/`stop`-only
surface — and `realtime-wal-source`'s spec (`spec.md:13-14`) explicitly requires no interface change.

## 6. Test-shape consequences — nothing pins the defect

- `wal-source.mjs` (unit, no DB) never calls `.start()`; it drives `handleMessage` directly. Does **not** pin the broken behaviour.
- `dispatch.mjs` uses a fake source whose `start()` resolves synchronously (`test/dispatch.mjs:43-46`). Also does not pin it.
- `parity.mjs`, `resume.mjs`, `log.mjs` need no code changes — they will simply complete.

**Caveat that matters:** none of those three has ever run to completion, so their first real run
post-fix is a discovery step. Budget for secondary findings unrelated to this bug.

## 7. Specs to amend

`openspec/specs/realtime-wal-source/spec.md`'s "`WalSource` implements the `RealtimeSource`
contract" requirement (lines 11-20) is **silent on resolve timing** — nothing normatively
contradicts the fix, but it should gain a requirement: `start()` resolves once the stream is
confirmed live (the server acks `START_REPLICATION`), matching `PgNotifySource`'s "`LISTEN`
succeeded" semantics, and rejects on an initial connect failure.

`realtime-live-endpoint` and `studio-live-view` have zero mentions of `start()`/`engine.start()`
blocking semantics — no contradiction, optional additive requirements only.

## 8. Impact on the held branch

`feat/realtime-column-projection-2-enforcement` (`1c03ae0`) is unmerged specifically because RLE-2's
merge gate cannot run. Per that change's verify report, `log.mjs`'s hang was the **only** blocker
found for RLE-2's DB-gated leg. Fixing this therefore genuinely unblocks it. Recommend running
`log.mjs` — for the first time ever — as part of this change's own verify.

## Slice recommendation

**Single PR**, comfortably under budget: ~40-70 production lines in `wal-source.ts` (the ready
deferred plus resolve/reject wiring); most of the diff is new unit tests in `wal-source.mjs`
(readiness timing, first-attempt-only rejection scoping) plus the spec delta. Do **not** bundle the
held branch's merge — this change only removes the environmental blocker.

## Risks / open questions

- No live-Postgres confirmation in the exploration run itself (tooling gap, disclosed). Apply and verify must run the real docker probe.
- Scoping the ready deferred to the first attempt only is the main reintroduction risk; needs an explicit unit test.
- `log.mjs`/`parity.mjs`/`resume.mjs` have never completed; their first execution may surface unrelated follow-ups.
