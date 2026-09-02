# Apply Progress: Realtime `start()` Readiness Contract — PR 1 (Phase 1)

## Mode

Strict TDD Mode (active). Every task followed RED → GREEN → REFACTOR; both mutation-testing
sanity checks below re-confirm RED sensitivity of the two riskiest mechanisms.

## Completed Tasks (Phase 1 — PR 1, 10/10)

- [x] 1.1 RED: `wal-source.mjs` — added RSC-1,2,4,5,7,8a,8b,9,10 / RWS-1..9 cases; failed against
      unmodified `wal-source.ts` (28/38 passed — the 10 new integration cases failed as expected;
      `RWS-1` passed trivially since the "no I/O before start()" assertion holds vacuously on
      unmodified code too). RED evidence: `git stash push -- packages/realtime/src/wal-source.ts`
      + rerun, restored via `git stash pop`.
- [x] 1.2 GREEN: `wal-source.ts` — `private ready: {resolve;reject}|null`, `settleReady(outcome,
      err?)` (settles then nulls the field), `start()` rewritten: reject stale `ready`, create a
      fresh deferred, run `connect()` detached as `attempt`, `attempt.then(...)` backstop
      (rejects on ANY normal completion or forwarded error), `attempt.catch(() => {})` attached
      strictly after `.then()`, `await ready` as the only await.
- [x] 1.3 GREEN: `connect()` — `service.on("start")` now also calls `this.settleReady("resolve")`;
      the catch block wraps the error, calls `onError`, then `this.settleReady("reject", wrapped)`
      immediately after.
- [x] 1.4 GREEN: removed the dead `else throw err;` tail in `connect()`'s catch; rewrote `start()`'s
      doc comment (formerly claiming a fail-fast contract that never held) to state the real one.
- [x] 1.5 GREEN: added private `createService()`/`createWriter()` factory seams; `connect()` now
      calls `this.createService()` / `this.createWriter()` instead of constructing
      `LogicalReplicationService`/`pg.Client` directly. No interface change.
- [x] 1.6 Verified: all 38 `wal-source.mjs` checks pass; the existing A4 backoff suite
      (`RSC-10`/`RWS-9`, line ~660) is byte-unchanged and still green.
- [x] 1.7 `protocol.ts` — added a normative doc comment on `RealtimeSource.start()` (comment-only;
      `interface` body's non-comment text is unchanged). RSC-11b guard lives in
      `source-contract.mjs` (see deviation note below — implemented as a stripped-comment exact
      match rather than a literal `rg`/git-diff invocation).
- [x] 1.8 Created `packages/realtime/test/source-contract.mjs` (new, 4 checks): RSC-6
      (`PgNotifySource` against `postgres://127.0.0.1:1/db` rejects with the real ECONNREFUSED,
      no DB, no seam), RSC-11a (arity + surface-shape checks for both `WalSource` and
      `PgNotifySource` — see deviation note).
- [x] 1.9 `pnpm --filter @indigodb/realtime lint` (`tsc --noEmit`) passes clean.
- [x] 1.10 `parity.mjs` (DB-gated, self-skips without `INDIGODB_TEST_DATABASE_URL`) — added an
      explicit "no event arrived before `start()` settled" assertion around the existing
      `notifySource.start()` call (RSC-3). Syntax-checked (`node --check`) and confirmed it
      SKIPs cleanly in a default checkout; cannot be exercised RED→GREEN without a real Postgres
      in this environment.

## TDD Cycle Evidence

| Task | RED evidence | GREEN evidence | REFACTOR |
|---|---|---|---|
| 1.1–1.6 (`wal-source.ts`/`.mjs`) | `git stash` unmodified `wal-source.ts` → 28/38 passed, 10 new cases FAIL (listed below) | Restored via `git stash pop`, rebuilt → 38/38 pass, clean exit | Extracted `fakeReplicationService`/`fakeReplicationWriter`/`afterMicrotasks` helpers; two dedicated `settleReady` unit tests isolate bug-class 1 from the integration tests |
| 1.7 (`protocol.ts` comment) | Mutated interface to add an `extra(): void;` member → RSC-11b failed with an exact diff | Reverted mutation → RSC-11b passes | — |
| 1.8 (`source-contract.mjs`) | New file — RED is "did not exist"; first run against the (then-unmodified) `protocol.ts`/sources passed trivially since RSC-6/RSC-11a assert pre-existing behavior, not this PR's new mechanism (RSC-11b is the row with genuine RED sensitivity, proven via the mutation above) | 4/4 pass, clean exit (0.15s, no leaked handles) | — |
| 1.10 (`parity.mjs`) | N/A — DB-gated, cannot run in this environment | `node --check` passes; self-skips cleanly without a DB | — |

RED failures observed at task 1.1 (unmodified `wal-source.ts`, 28/38 passed):

```
FAIL - RSC-1/RWS-2: start() resolves once the stream is confirmed live, not at stream end
FAIL - RSC-4/RWS-3: start() rejects on a missing replication slot, carrying the underlying error
FAIL - RSC-5/RWS-4: start() rejects on an authentication failure without ever calling subscribe()
FAIL - settleReady: resolve nulls the field, so a later reject call is a no-op (bug-class 1, direction resolve-then-reject)
FAIL - settleReady: reject nulls the field, so a later resolve call is a no-op (bug-class 1, direction reject-then-resolve)
FAIL - RSC-7/RWS-5: a reconnect failure after a successful start does not reject the already-resolved start()
FAIL - RSC-8a/RWS-6a: a reconnect success after a successful start does not re-resolve start()
FAIL - RSC-8b/RWS-6b: a reconnect success after a rejected start does not re-settle it, and raises no unhandled rejection
FAIL - RSC-9/RWS-7: stop() before the stream goes live rejects the pending start() and tears down resources
FAIL - RWS-8: a superseded connect() closes its own writer and does not overwrite this.writer
```

## Mutation-Testing Proof (per the seven-things-that-will-fail-this-PR brief)

**Mutation 1 — `settleReady()` no longer nulls the field** (removed `this.ready = null;`):
rebuilt, ran `wal-source.mjs` → 33/38 passed, 5 FAIL:
`settleReady: resolve nulls...` (direct unit), `settleReady: reject nulls...` (direct unit),
`RSC-7/RWS-5`, `RSC-8a/RWS-6a`, `RSC-8b/RWS-6b` (all three reconnect-scoping integration cases).
Restored byte-identically (`git diff --stat` back to 91 insertions / 11 deletions, matching
pre-mutation); reran → 38/38 green.

**Mutation 2 — `start()`'s backstop removed** (deleted the `attempt.then(...)` call that settles
`ready` on any connect() exit path not covered by `service.on("start")`/the catch block):
rebuilt, ran `wal-source.mjs` → hung on `RSC-9/RWS-7` (`stop()` before the stream goes live).
Node's own "unsettled top-level await" detector fired at the timeout kill, pointing directly at
that check — proving `RSC-9`'s "never remains pending forever" claim is genuinely load-bearing on
the backstop, not accidentally satisfied some other way. Restored, rebuilt, reran → 38/38 green.

## Files Changed

| File | Action | Lines (+/-) |
|------|--------|-------------|
| `packages/realtime/src/wal-source.ts` | Modified | +91/-11 |
| `packages/realtime/src/protocol.ts` | Modified | +10/-0 (comment-only) |
| `packages/realtime/test/wal-source.mjs` | Modified | +372 (11 new checks: RWS-1 extension, RSC-1/4/5/7/8a/8b/9, RWS-8, two `settleReady` unit tests; tail `console.log` replaced with `strictEqual(passed, 38, ...)`) |
| `packages/realtime/test/source-contract.mjs` | Created | ~104 lines, 4 checks |
| `packages/realtime/test/parity.mjs` | Modified | +17/-2 (RSC-3 assertion; DB-gated) |
| `openspec/changes/realtime-start-contract/tasks.md` | Modified | Phase 1 checkboxes marked `[x]` |

Not modified: `packages/realtime/package.json`'s `test` script (chaining `source-contract.mjs` in
is task 3.4/3.5, explicitly Phase 3/PR 3 per the design's file-changes table) — verified manually
instead (`node packages/realtime/test/source-contract.mjs`).

## Deviations from Design

1. **RSC-11b ("comment-only diff") implemented without `rg`/git-diff.** The design describes an
   `rg` guard "asserting the `RealtimeSource` interface body diff is comment-only (no line outside
   `/** */` changed)" — a true diff needs a base ref, which isn't reliably available inside a test
   run. Implemented instead as: extract the `interface RealtimeSource { ... }` body from
   `protocol.ts`, strip every `/** ... */` block, collapse whitespace, and assert the result
   equals the exact known two-signature text. This is executable and RED-sensitive (proven above
   by mutating in a third `extra(): void;` member, which failed the check with an exact diff) but
   is a structural-equality check against a frozen expected string, not a literal git diff against
   a historical base. Functionally equivalent for this PR's purpose (catching any non-comment
   change to the interface body, past or future) but worth flagging as a substitution.

2. **RSC-11a "frozen own-method-name list" (`["models","start","stop"]`) not implemented
   literally.** TypeScript's `private` modifier is compile-time only — it does not hide a method
   from `Object.getOwnPropertyNames(WalSource.prototype)` at runtime, which already includes many
   pre-existing "private" methods (`connect`, `scheduleReconnect`, `handleMessage`,
   `closeWriter`, `flushCommit`, `teardownAfterLogFailure`, `decodeRow`, plus this PR's own
   `settleReady`/`createService`/`createWriter`) for both classes — a literal reflection diff
   against that three-item list would already fail before this PR touched anything. Implemented
   the substantive intent instead: `start`/`stop` are asserted to be functions with the documented
   arity (2 and 0 respectively — RSC-11a's actually-stated first bullet, unaffected by this
   deviation), `models` is asserted to remain a getter (not demoted to a plain method), and the
   prototype is asserted to gain no new public `resolve`/`onReady` member (the two concrete
   widenings the design's "Alternatives rejected" section explicitly named and rejected).

## Issues Found (process, not design)

- **Two RED-test hygiene bugs found and fixed during this PR's own TDD cycle** (both in the new
  test file, not production code): `RSC-4`/`RSC-5`/`RSC-1` originally didn't override
  `scheduleReconnect()`, so their first-attempt-rejection/resolve paths armed a REAL, ever-doubling
  `setTimeout` reconnect loop against the same always-failing/always-pending fake — invisible via
  `process._getActiveHandles()` at the moment of inspection (timing-dependent), but reliably
  reproduced as a `timeout`-killed hang on every full-suite run. Fixed by overriding
  `scheduleReconnect` to a no-op in those three tests, with an inline comment explaining why.
  Bisected via isolated single-test extraction (`node --check` + `timeout`-wrapped runs) rather
  than guesswork.
- **`RWS-8`'s original draft called `connect()` directly without first setting `source["stopped"]
  = false`** — `connect()`'s very first line (`if (this.stopped) return;`) made both connect()
  calls no-ops, so the test's assertions were checking nothing. Fixed by setting `stopped = false`
  before driving `connect()` directly, matching the pattern the other reconnect-scoping tests
  already use.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/realtime/test/wal-source.mjs && node packages/realtime/test/source-contract.mjs` — 38/38 and 4/4 pass, both exit 0, no leaked handles (`process._getActiveHandles()` verified empty at completion) |
| Runtime harness command/scenario and exact result | `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root — 18/18 Turbo tasks successful, workspace pack-contents guard green, exit code 0 (`pnpm test --filter=@indigodb/realtime` also re-run standalone with `--force`, same result) |
| Rollback boundary | Revert `packages/realtime/src/wal-source.ts`, `packages/realtime/src/protocol.ts`, `packages/realtime/test/wal-source.mjs`, `packages/realtime/test/parity.mjs`, and delete `packages/realtime/test/source-contract.mjs` — no other file touched, `connect()`'s internals are unmodified per design so a revert restores prior behavior with no state to undo |

## Review Workload Forecast (per tasks.md)

Chain strategy: `stacked-to-main`. This batch is PR 1's complete, self-contained slice (Unit 1 of
3 from the forecast table). Estimated changed lines this PR: ~503 authored (protocol.ts +10,
wal-source.ts +91/-11, wal-source.mjs +372, parity.mjs +17/-2, source-contract.mjs new ~104) —
above the 400-line budget on its own, consistent with the tasks artifact's own "High" risk
forecast and pre-accepted `auto-chain`/`stacked-to-main` decision; not re-litigated here.

## Status

10/10 Phase 1 (PR 1) tasks complete. Phases 2–3 (PR 2/PR 3) untouched. Ready for `sdd-verify`.
