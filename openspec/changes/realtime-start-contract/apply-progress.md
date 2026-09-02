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

## PR 2 — engine, CLI and Studio wiring (Phase 2)

The apply agent died to a provider rate limit partway through, having landed `engine.ts`'s
`started` reset, the `realtime` daemon's fail-fast catch, and `realtime-fail-fast.mjs`. The
orchestrator finished the Studio half, fixed two defects found doing so, ran the gate and
committed.

**Delivered.** `RealtimeEngine.start()` resets `started` and stops the source before rethrowing.
`cli/index.ts` catches, prints `❌ Realtime failed to start: <error>` and exits 1 before `listen`.
`studio-server.ts` catches, prints `⚠ Realtime unavailable: … — Studio continues without live
updates`, latches `realtimeAvailable = false`, binds anyway, and answers **503** on
`REALTIME_PATH`/`REALTIME_LOG_PATH` with no SSE frame in the body.

### Two defects found while finishing, neither in the original task list

**1. `engine.stop()` was a silent no-op exactly when it was needed.** `RealtimeEngine.stop()`
does all of its work inside `if (this.started)`, and PR 1's RSC-14 fix clears `started` when
`start()` rejects. So the obvious caller shape — `catch { await engine.stop() }`, which is what
the Studio path first used — cleaned up nothing, while `scheduleReconnect()`'s backoff timer
retried forever and kept the process alive. Observed directly: the degraded-Studio suite printed
`all green` and then never exited, spraying `ECONNREFUSED` retries.

Fixed in `engine.ts` rather than in the caller: a rejected attempt now stops its own source before
rethrowing, so no caller has to remember. `studio-server.ts` documents why it deliberately does
*not* call `engine.stop()` — calling it would read like cleanup while doing nothing.

This is an interaction defect: PR 1's fix is correct, `stop()`'s guard is correct, and together
they produced a hang. It surfaced only by running the real suite to completion.

**2. `realtime-fail-fast.mjs`'s second case could never fail.** The agent passed an `async` function
to the file's **synchronous** `check()`, so the returned promise was never awaited and the port
assertion ran orphaned — the case reported `ok` unconditionally. A `checkAsync` helper was defined
in the same file and never used. Switched to `await checkAsync(...)`, with an inline note.

### Mutation proof

| Mutation | Result |
|---|---|
| Bypass the `realtimeAvailable` latch so the realtime routes answer 200 again | EPT-1 and EPT-2 FAIL; EPT-3 stays green (it exercises ordinary routes, correctly unaffected) |
| Drop `started = false` from `start()`'s catch | RSC-14 FAILs: *"a second start() reaches source.start() again"* |

Both restored byte-identically (`cmp` clean), rebuilt, reconfirmed green.

### Coverage notes

`studio-realtime-degraded.mjs` ends with a `ran !== 3` guard so an omitted or skipped case fails
loudly instead of shrinking the run. EPT-3 is **differential**: it captures the degraded Studio's
status and body shape for `/api/schema`, `/api/tables/:name` and `/api/query`, then compares them
against a second Studio built from a **non-`@@realtime`** schema, and asserts the control actually
served 200 — a bare "expect 200" would pass vacuously in exactly the world where a blunt
implementation degraded the ordinary routes too.

Both new CLI suites are wired into `packages/cli/package.json`'s `test` chain; the repo has no
auto-discovering runner, so a file absent from the chain never runs.

### Gate

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` — all exit 0.
`INDIGODB_TEST_DATABASE_URL` was not set; the DB-gated discovery leg is PR 3.

## PR 3 — Studio badge + test wiring + discovery leg (Phase 3)

**Mode**: Strict TDD. Branch `fix/realtime-start-contract-3-badge` off `main` (`e22d7fd`). Not
merged/pushed. 8/8 tasks complete.

### TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 3.1 SLV-1 | New tests run once against unmodified `useLiveTable.ts` first PASSED (production already correct from PR 2's 503 gating) — legitimacy proven instead by mutation: removed `setStatus('error')` from `onError`, reran → SLV-1 and the pre-existing `onError` test both FAILED (`expected 'connecting'/'live' to be 'error'`) | Byte-identical revert (`git diff --stat` empty) restored 15/15 green | None needed |
| 3.2 SLV-2 | Same mutation (onError no-op) also broke SLV-2 (`expected 'live' to be 'error'`), proving it isn't vacuous | Reverted alongside 3.1's mutation, 15/15 green | None needed |
| 3.3 strictEqual tail guards | N/A — already delivered in PR 1 (`wal-source.mjs` `strictEqual(passed,38,...)`, `source-contract.mjs` `strictEqual(passed,4,...)`) | Verified present, ran green | — |
| 3.4 RWS-10b guard | Wrote `readiness-no-db-env-guard.mjs`, ran clean (2/2 pass) against unmodified files first | Deliberately appended a probe `INDIGODB_TEST_DATABASE_URL` reference to `wal-source.mjs`, reran → guard FAILED (exit 1, `1 !== 2`) proving it bites; reverted byte-identically (`git diff --stat` empty), reran → 2/2 green | None needed |

### SLV-1 test design (per the prompt's five failure modes)

- Drives a REAL `SseTransport` (no injected `deps.transport`) over `vi.stubGlobal('fetch', ...)`
  returning `{ ok: false, status: 503, body: null }` — the actual chain executes:
  `fetch` → `!res.ok` → `throw` → `run()`'s catch → `onError` → `setStatus('error')`.
- Records EVERY status via a wrapping `useTracked()` hook that pushes `r.status` on every render,
  not just the final read; asserts `statusHistory` never contains `'live'`.
- Never advances the fake timers active for this describe block, so the transport's 1s backoff
  sleep (`await sleep(retryMs)`) simply never fires; `unmount()` is still called explicitly after
  the assertion (aborts the transport) rather than relying on that as an accident.

### Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `apps/studio/src/features/studio/browser/__tests__/useLiveTable.test.tsx` | Modified | Added SLV-1 (real `SseTransport` + stubbed `fetch` 503 → `error`, never transient `live`) and SLV-2 (`fetchTableRows`/`updateTableRecords` still land rows with `status==='error'`) in a new `describe` block; +78/-0 |
| `packages/realtime/test/readiness-no-db-env-guard.mjs` | Created | RWS-10b — asserts `wal-source.mjs`/`source-contract.mjs` never reference `INDIGODB_TEST_DATABASE_URL`; ~50 lines |
| `packages/realtime/package.json` | Modified | Chained `source-contract.mjs` and `readiness-no-db-env-guard.mjs` into `test` (both were previously only run manually) |
| `packages/cli/package.json` | Not modified | `studio-realtime-degraded.mjs`/`realtime-fail-fast.mjs` were already chained ahead of schedule in PR 2 |
| `openspec/changes/realtime-start-contract/tasks.md` | Modified | Phase 3 checkboxes marked `[x]` |

### Discovery leg (RWS-11) — narrow claim, honestly reported

Container: `docker run -d --name indigo-wal-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=indigo_test
-p 55432:5432 postgres:17 -c wal_level=logical -c max_replication_slots=8 -c max_wal_senders=8`.
Waited on `psql -d indigo_test -c 'select 1'` (not `pg_isready`, which returns true before the
database exists) — ready after 1s. Each suite run individually, exit code captured **directly to a
file, never through a pipe**:

| Suite | Exit | Got past `await source.start(...)`? | Completed? | Result |
|---|---|---|---|---|
| `log.mjs` | 0 | Yes | Yes | 4/4 checks pass |
| `parity.mjs` | 0 | Yes | Yes | 2/2 checks pass — includes the RSC-3 resolve-timing assertion (`walSource.start()` at line 129, `notifySource.start()` at 117), both settle before any event arrives, exactly the historically-hanging call site |
| `resume.mjs` | 124 (timeout) | Yes | **Ambiguous — see below** | 3/3 checks *printed* pass, then the process never exits |

**`resume.mjs` finding (follow-up, not this change's promise)**: all three checks run to completion
and print `3 passed`, proving `start()` itself no longer blocks — the narrow RWS-11 claim holds.
But the Node process then hangs past that point until the 90s `timeout` kills it (exit 124). Root
cause not this change's scope: `resume.mjs` has no `process.exit(0)` on its success path (only on
`INDIGODB_TEST_DATABASE_URL`-unset skip and on `process.exitCode` failure, both at the bottom of
the file) — some handle (likely a replication slot connection or reconnect timer left open by the
suite itself, not by `WalSource.start()`) keeps the event loop alive. **Filed as a follow-up, not
fixed here** — RWS-11's claim is specifically "no longer blocks at `start()`", which is true for all
three suites; a post-completion process-exit hang is a distinct defect in the test file's own
cleanup, discovered by running these suites to completion for the first time in this repo's history.

Container removed after the run (`docker rm -f indigo-wal-test`).

### Root gate (default checkout, `INDIGODB_TEST_DATABASE_URL` unset)

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root — `clean:0 build:0
lint:0 test:0`, all four commands exit 0, run independently of and after the discovery leg (fresh
shell, var never set). `apps/studio` vitest: 20/20 test files, 125/125 tests, including the new
15-test `useLiveTable.test.tsx` (13 pre-existing + SLV-1 + SLV-2). Workspace pack-contents guard
green for all 10 packages.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm --filter @indigodb/studio exec vitest run src/features/studio/browser/__tests__/useLiveTable.test.tsx` — 15/15 pass; `pnpm --filter @indigodb/realtime test` — all suites pass/SKIP as expected, `source-contract.mjs` (4/4) and `readiness-no-db-env-guard.mjs` (2/2) now run inside the chain |
| Runtime harness command/scenario and exact result | `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root, `INDIGODB_TEST_DATABASE_URL` unset — exit 0 for all four commands; separately, the DB-gated discovery leg (see above) — narrow claim confirmed, one unrelated follow-up filed |
| Rollback boundary | Revert `apps/studio/src/features/studio/browser/__tests__/useLiveTable.test.tsx`, `packages/realtime/package.json`, and delete `packages/realtime/test/readiness-no-db-env-guard.mjs` — badge behavior in production code (`useLiveTable.ts`) is untouched by this PR, only test/wiring files changed |

### Deviations from Design

None in production code — SLV-1/SLV-2 verify behavior already delivered by PR 2's 503 gating; no
`useLiveTable.ts` or `SseTransport` change was needed. RWS-10b implemented as a `readFileSync`
string-search guard rather than shelling out to `rg`, same substitution already made for RSC-11b in
PR 1 (documented there) — avoids a test-time dependency on an external binary; equally
RED-sensitive (proven by the deliberate-trip-and-revert above).

### Issues Found

- **`resume.mjs` leaks a handle after its checks complete**, keeping the process alive past a
  successful run (see Discovery leg above). Filed as a follow-up; explicitly out of this change's
  scope (RWS-11 promises only "no longer blocks at `start()`").

### Status

8/8 Phase 3 (PR 3) tasks complete. **26/26 tasks across all three phases complete** (10 + 8 + 8; an earlier summary said 28, which never matched the checklist). Ready for
`sdd-verify`.
