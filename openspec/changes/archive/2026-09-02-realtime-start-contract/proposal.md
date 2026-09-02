# Proposal: Realtime `start()` Readiness Contract

## Intent

Production defect, not a test annoyance. `WalSource.start()` resolves only when the replication
stream *ends*, so `RealtimeEngine.start()` never settles on a healthy stream. Both
`studio-server.ts:823` and `cli/index.ts:269` await it before `listen()`, so **neither `indigodb
studio` nor `indigodb realtime` binds its port** for a schema with `@@realtime` once the slot
exists (measured: pending at 8s / 10s; resolves in 17ms only when the slot is *missing*). The
feature works only while it is broken.

Two distinct bugs:

1. **The `RealtimeSource` seam has no shared contract.** `PgNotifySource.start()` means "LISTEN
   succeeded"; `WalSource.start()` means "stream ended". `protocol.ts` gives `start()` no normative
   meaning, while `wal-source.ts:178-180` claims parity.
2. **`start()` never rejects on an initial connect failure.** `connect()`'s catch
   (`wal-source.ts:307-320`) is dead code: the earlier `if (this.service !== service ||
   this.stopped) return;` exhausts every `stopped` path, so `throw err` is unreachable. The
   documented fail-fast contract has never worked for `WalSource`.

## Scope

### In Scope

- **Normative seam contract**: `start()` resolves once the stream is confirmed live and rejects on
  the first attempt's connect failure — binding on both implementations, documented on
  `RealtimeSource` in `protocol.ts` as a comment only. **No signature change**
  (`realtime-wal-source/spec.md:13-14`).
- **`WalSource`**: one-shot *ready deferred*, resolved from the existing `service.on("start")`
  handler (`:238`), rejected from the catch path, **scoped to the first `connect()` issued by
  `start()` only**. `start()` awaits the deferred; the outer `connect()` runs detached with
  `.catch(() => {})`.
- **`PgNotifySource`**: no code change — v1 already conforms (resolves after `LISTEN`; no
  try/catch, so initial failures genuinely propagate). Confirmed, not assumed.
- **Fail-fast rejection is in scope**, as a side effect of the reject path. Operator-visible:
  `indigodb realtime` exits non-zero with the Postgres error (a daemon with no stream has no
  purpose). `studio-server.ts` treats the rejection as **non-fatal** — log a diagnostic, bind
  anyway, realtime unavailable. Without that guard a missing slot goes from "Studio boots,
  realtime silently dead" to "Studio dead": a regression, not honesty.
- **Default-checkout tests** in `wal-source.mjs`, fake transport per `dispatch.mjs:43-46`, no
  `INDIGODB_TEST_DATABASE_URL`: readiness timing, first-attempt rejection, and that a later
  `scheduleReconnect()` failure never re-settles the deferred.

### Out of Scope

- Narrowing `studio-server.ts:823` so schema/table/query routes never wait on realtime —
  **recorded follow-up**, deliberately not absorbed here.
- Merging `feat/realtime-column-projection-2-enforcement` (`1c03ae0`), unmerged because RLE-2's
  gate cannot run. This change removes that blocker only.
- Any rewrite of `connect()` beyond the additive deferred: both supersession checks, the
  orphaned-socket guard (46-minute CI hang), `scheduleReconnect()`.
- Backpressure, `@@allow`/RLS, any migrator/DDL change; Studio auth, pagination and write guards
  are untouched.

**Record explicitly**: none of `connect()`'s guards exist because `start()` awaits `subscribe()` —
they are `connect()`'s own reconnect bookkeeping. "Detaching the promise breaks the reconnect
guards" is the predictable wrong objection in review.

## Capabilities

### New Capabilities
- `realtime-source-contract`: normative meaning of `RealtimeSource.start()`/`stop()` resolve and
  reject timing, binding on `WalSource` and `PgNotifySource` alike.

### Modified Capabilities
- `realtime-wal-source`: the "`WalSource` implements the `RealtimeSource` contract" requirement
  (`spec.md:11-20`) is silent on resolve timing; it gains conformance to the seam contract.

## Approach

Race `service.on("start")` (readiness) against `subscribe()`'s own rejection (failure); whichever
fires first is authoritative — the library cannot end a stream before it starts, so `subscribe()`
cannot spuriously win. Reuses existing wiring instead of an `onReady` callback, which would widen
the seam the spec forbids widening.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/realtime/src/wal-source.ts` | Modified | Ready deferred + resolve/reject wiring (~40-70 lines) |
| `packages/realtime/src/protocol.ts` | Modified | Contract documented on `RealtimeSource` (comment only) |
| `packages/cli/src/studio-server.ts` | Modified | Rejected `engine.start()` becomes non-fatal |
| `packages/cli/src/index.ts` | Modified | Fail-fast exit with the underlying error |
| `packages/realtime/test/wal-source.mjs` | Modified | New default-checkout unit tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Deferred re-settled by a later reconnect | Med | Dedicated first-attempt-only unit test, default checkout |
| Detached `connect()` yields unhandled rejection | Med | `.catch(() => {})` on the detached promise |
| Studio silently loses realtime after the fix | Low | Non-fatal path logs a named diagnostic |
| `log.mjs`/`parity.mjs`/`resume.mjs` surface unrelated defects | High | See below — discovery, not a promise |

**These three suites have never run to completion.** Their first post-fix execution is a discovery
step. This change cannot promise they pass — only that this specific blocker is removed. Anything
else they surface is filed as a follow-up.

## Rollback Plan

Single revertable commit. `connect()`'s internals are unmodified, so reverting restores the exact
prior behaviour with no state, migration or artifact to undo.

## Dependencies

- A real Postgres via `INDIGODB_TEST_DATABASE_URL` for the DB-gated verification leg (six of nine
  realtime suites skip without it).
- No `crates/` change, so no `build:wasm` or WASM regression rerun is required.

## Success Criteria

- [ ] `indigodb studio` and `indigodb realtime` bind their port with `@@realtime` and an existing slot.
- [ ] `WalSource.start()` rejects on a missing slot; `indigodb realtime` exits non-zero, Studio still boots.
- [ ] New `wal-source.mjs` tests pass in a default checkout with no database configured.
- [ ] `pnpm build && pnpm lint && pnpm test` green from the repo root.
- [ ] `log.mjs` runs to completion against a real Postgres for the first time.
