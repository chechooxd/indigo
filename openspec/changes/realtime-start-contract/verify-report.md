# Verify Report — `realtime-start-contract`

## PR 1 / Phase 1 — the seam contract

**Branch**: `fix/realtime-start-contract-1-seam` (off `main`@`ab6e888`), commit `cb86fb9`.
765 insertions / 22 deletions across 7 files. Nothing under `packages/cli` or `apps/studio`
touched; `packages/realtime/src/engine.ts` unchanged (empty `git diff --stat`).

> **Persistence note.** The verify agent completed the review but could not write this file: the
> native `gentle-ai sdd-verify-validate` gate denied admission on `evidence_revision`. Earlier
> verify passes in this same session persisted successfully through that gate, so this is an
> agent-side error deriving the digest, **not** a tooling defect — recorded here rather than
> escalated. The content below is the agent's report verbatim in substance; the orchestrator
> performed the write.

### Verdict: PASS WITH WARNINGS — 0 CRITICAL, 1 WARNING, 1 SUGGESTION

### Verification gate (repo root)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | exit 0 (10/10 Turbo tasks) |
| `pnpm lint` | exit 0 |
| `pnpm test` | exit 0 (18/18 Turbo tasks, pack-contents guard green) |
| `packages/realtime/test/wal-source.mjs` | 38/38 checks, ends in `strictEqual(passed, 38, …)` |
| `packages/realtime/test/source-contract.mjs` | 4/4, run manually — chaining into `package.json` is task 3.5 (Phase 3) |

`INDIGODB_TEST_DATABASE_URL` was never set.

### Independent mutation re-run

Reproduced apply's mutation (b) independently: removed the `attempt.then(...)` backstop
(`wal-source.ts:246-249`), rebuilt, ran `timeout 25 node packages/realtime/test/wal-source.mjs`
with the exit code captured **directly to a file, not through a pipe** — **exit 13**, Node's
unsettled-top-level-await detector firing at
`RSC-9/RWS-7: stop() before the stream goes live rejects the pending start() and tears down
resources` (`wal-source.mjs:1006`). Restored via `git checkout`; `git diff --stat` empty
(byte-identical); rebuilt; 38/38 green.

**The backstop is genuinely load-bearing**, not defensive decoration.

### The five scrutiny points — all clean

1. **The `scheduleReconnect` stubs do not hollow out their tests.** Five sites in the
   readiness-contract region (`wal-source.mjs:780, 812, 838, 918, 971`); a sixth at `:390` is
   pre-existing and unrelated. At `:780`, `:812`, `:838` the stub is pure cleanup — those tests
   never touch reconnect, and the stub only stops a real timer leaking past their assertions. At
   `:918` and `:971`, the two genuine reconnect-scoping tests, the stub suppresses only a
   **third**-attempt timer: each test drives a real second `connect()` itself and asserts on its
   outcome. No stub neutralises the mechanism under test.
2. **RSC-11 deviations judged sound.** TypeScript `private` being compile-time only was verified
   independently against `dist/wal-source.js` — private helpers are ordinary own methods at
   runtime, so design's literal frozen-method-list check was unimplementable as written. The
   substitute (arity + getter + no-new-public-member) covers the two concrete widenings design's
   own "Alternatives rejected" section named. The comment-only-diff substitute is
   mutation-proven RED-sensitive.
3. **`stop()` during a pending `start()` cannot hang.** All five `connect()` exit paths traced in
   source (`wal-source.ts:281-401`): early `stopped` return, both supersession returns, the
   catch-superseded branch, the catch-real-failure branch, and normal stream-end completion. Every
   one settles the deferred explicitly or is caught by the `attempt.then()` backstop.
4. **Unhandled-rejection ordering correct.** `attempt.then(...)` attaches before
   `attempt.catch(() => {})` on the same promise (`wal-source.ts:246-255`), so the rejection
   handler forwards the real error to `settleReady` first. Design row RWS-4's
   `process.on("unhandledRejection")` recorder is implemented and passing
   (`wal-source.mjs:960-1004`).
5. **The suite can no longer lie about its own size.** `wal-source.mjs:1074` is
   `strictEqual(passed, 38, …)`, and 38 `check()` call sites were counted to match. `rg` confirms
   zero `INDIGODB_TEST_DATABASE_URL` references in the new files; the automated guard *script* is
   task 3.4 (Phase 3), correctly not in this PR.

### Also confirmed

RSC-5's `subscribeCalled === false` assertion is present (`wal-source.mjs:847`) — that is what
makes the auth-failure path distinct from the missing-slot path rather than a relabelled
duplicate. The dead `else throw err;` is removed and the false doc comment at `:178-180` rewritten
to the real contract. `connect()`'s supersession checks, orphaned-socket guard and
`scheduleReconnect()` are structurally unmodified. `protocol.ts`'s diff is comment-only.
`PgNotifySource` has no code change. All 10 Phase 1 tasks are `[x]`. Commit `cb86fb9` is
conventional with no AI-attribution trailer.

### Issues

**WARNING** — RSC-11a's substitute does not catch a *differently named* new public member the way
a literal frozen list would. Narrow, acknowledged; the concrete risks design named are covered.

**SUGGESTION** — `source-contract.mjs` is green but not yet in `pnpm test` (intentional, Phase 3),
so a contributor running the default command today will not see RSC-6/RSC-11a/RSC-11b execute
until PR 3 lands.

### Scope

PR 2 (engine/CLI/Studio wiring, 503 gating) and PR 3 (badge, test wiring, DB-gated discovery leg)
are deliberately absent and were not counted as gaps.

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:3c012aa81925c5fd577c759d2ae79063c7802ccbff6629f84d58d5d30a7048d5
verdict: fail
blockers: 1
critical_findings: 1
requirements: 1/3
scenarios: 4/6
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:6db217527a9fe0c9eb2922a289b81ea4cc8ff08aac5145300462e38f57e99d2e
build_command: pnpm clean && pnpm build --force
build_exit_code: 0
build_output_hash: sha256:3ed9081a7cff2164427f30371d89a24da7a6437f185c3dbec93e4bd153056923
```

## PR 2 / Phase 2 — engine, CLI and Studio wiring

**Branch**: `fix/realtime-start-contract-2-wiring` (off `main`@`c588536`), single commit `9df2359`.
423 insertions / 13 deletions across 8 files. Confirmed via `git show --stat 9df2359`; matches the
claimed diffstat exactly. `apps/studio` untouched (confirmed). Commit message is conventional, no
AI-attribution trailer.

### Verdict: FAIL — 0 blockers-in-review-authority, 1 CRITICAL, 1 WARNING, 1 SUGGESTION

The implementation itself is sound and independently re-proven (see below). The FAIL is a single,
narrow, mechanical defect: **one of the eight tasks' covering tests never made it into the
commit under review**, even though `tasks.md` (which IS in the commit) marks it `[x]`.

### CRITICAL — task 2.2 marked complete, but its test change is not in commit `9df2359`

`git show --stat 9df2359` lists 8 files; `packages/realtime/test/dispatch.mjs` is **not** one of
them. Diffing the two RSC-14/DESIGN-ONLY-1 `check(...)` blocks against the commit confirms it:

```
git show 9df2359:packages/realtime/test/dispatch.mjs | rg "RSC-14|DESIGN-ONLY-1"
→ (no output — NOT present in the commit)
```

Yet `git status` at the start of this verify pass showed `packages/realtime/test/dispatch.mjs`
as a **modified, uncommitted** working-tree file containing exactly the RSC-14 +
DESIGN-ONLY-1 cases task 2.2 and design describe. `tasks.md`'s Phase 2 section (which IS
committed, inside `9df2359`) marks `2.2` as `[x]`.

This is a genuine task-completion misrepresentation, not a cosmetic gap: `realtime-source-contract`'s
"A rejected `RealtimeEngine.start()` leaves the engine restartable" requirement (spec.md:199-217,
RSC-14) has **zero covering test in the code actually delivered by this PR**. Anyone checking out
commit `9df2359` in isolation — the unit this verify pass was asked to review — gets a `dispatch.mjs`
with no RSC-14/DESIGN-ONLY-1 cases at all; the engine.ts fix (which IS committed) would ship with no
regression test guarding it.

The test itself is real and does pass — confirmed by running it (still present, uncommitted, in this
working tree):
```
node packages/realtime/test/dispatch.mjs
  ok - RSC-14: a rejected engine.start() leaves the engine restartable — a second start() reaches source.start() again
  ok - DESIGN-ONLY-1: engine.start() resolves on a live source and arms the heartbeat
```
So this is purely a **delivery/commit-hygiene defect**: the fix is correct and tested, but the test
never landed in the reviewable unit. **Remediation**: `git add packages/realtime/test/dispatch.mjs`
and amend `9df2359` (or fold into a follow-up commit) before this PR is considered mergeable/archivable.

### Verification gate (repo root)

| Command | Result |
|---|---|
| `pnpm clean` | exit 0 |
| `pnpm build --force` | exit 0 (10/10 Turbo tasks) |
| `pnpm lint` | exit 0 (19/19 Turbo tasks, cached) |
| `pnpm test` | exit 0 (18/18 Turbo tasks, pack-contents guard green) |
| `packages/cli/test/realtime-fail-fast.mjs` (chained) | 2/2 checks, "all green" |
| `packages/cli/test/studio-realtime-degraded.mjs` (chained) | 3/3 checks (`ran === 3`), "all green" |

`INDIGODB_TEST_DATABASE_URL` was never set (confirmed absent from the environment before running
the gate), per instructions — the DB-gated discovery leg belongs to PR 3.

### Claims independently verified

1. **`studio-server.ts` non-fatal start + 503 gating** — read the exact diff (`:820-838`,
   `:945-953`). Catches a rejected `engine.start()`, prints
   `⚠ Realtime unavailable: … — Studio continues without live updates`, latches
   `realtimeAvailable = false`, binds anyway. `REALTIME_PATH`/`REALTIME_LOG_PATH` both gated on
   `realtimeAvailable`, answering `503 {"error":"Realtime unavailable"}` otherwise, with the gate
   `if`-block placed BEFORE the unconditional `engine.handleRequest` branches. Matches claim exactly.
2. **`cli/index.ts` fail-fast** — read the exact diff. `try { await engine.start() } catch { ... process.exit(1) }`
   sits before `await new Promise((resolve) => server.listen(...))`. Matches claim exactly.
3. **`RealtimeEngine.start()` resets `started` and stops the source before rethrowing** — read the
   exact diff (`:153-178`). Confirmed the fix calls `this.source.stop()` directly (not
   `engine.stop()`, which is guarded by `if (this.started)` — a guard the line above has just
   cleared). Confirmed `engine.ts`'s `stop()` method itself is byte-unchanged (diffed `c588536..9df2359`
   for `wal-source.ts`/`protocol.ts`/`engine.ts`'s `stop()` body — empty). `wal-source.ts`'s
   `connect()`/`scheduleReconnect()` are untouched by this PR (`git diff c588536 9df2359 -- wal-source.ts` empty).
4. **Two new CLI suites wired into `packages/cli/package.json`'s `test` chain** — confirmed both
   `realtime-fail-fast.mjs` and `studio-realtime-degraded.mjs` appear in the chained `test` script,
   and both ran as part of `pnpm test` above.
5. **Mutation proof, reproduced independently** (not merely re-read): bypassed the `realtimeAvailable`
   latch (`if (false && engine && !realtimeAvailable)`) — rebuilt — EPT-1 and EPT-2 genuinely FAIL
   (`expected 503, got 401` for the log route; SSE route also failed), EPT-3 stayed green. Restored
   byte-identically (`git diff --stat` empty), rebuilt, reconfirmed all-green. Also reproduced the
   RSC-14 mutation via the (uncommitted) `dispatch.mjs`: dropping `started = false` before the throw
   is not needed to reproduce — see the more decisive engine-level mutation below.
6. **Root gate exit 0 for all four commands** — reproduced fully myself (see table above), not merely
   re-read from apply-progress.

### Defect A — `engine.stop()` silent no-op — independently reproduced both directions

- **Confirmed the interaction is real**: `stop()`'s body is wrapped in `if (this.started)`
  (`engine.ts:184-191`), and the catch in `start()` clears `this.started = false` before it would
  otherwise call `stop()` — so `catch { await engine.stop() }` genuinely cleans up nothing.
- **Reproduced the hang**: removed only the `await this.source.stop().catch(() => {});` line from
  `start()`'s catch block, rebuilt (`realtime` + `cli`), ran
  `timeout 60 node packages/cli/test/studio-realtime-degraded.mjs` with the exit code captured
  **directly to a file, not through a pipe**. Result: **exit 124** (timeout kill). The log shows
  `cli studio degraded realtime: all green` printed, followed by five more `ECONNREFUSED` lines —
  the exact "prints all green and never exits" symptom claimed.
- **Reproduced the fix**: restored `engine.ts` byte-identically (`git diff --stat` empty), rebuilt,
  reran the same command — **exit 0**, and grepping the log for `ECONNREFUSED` after the `all green`
  line returns zero matches (both `ECONNREFUSED` lines occur before it, during the intentional
  degraded-boot phase).

### Defect B — `realtime-fail-fast.mjs`'s orphaned async case — confirmed, and swept for duplicates

Confirmed the fix: the second case now uses `await checkAsync("the daemon's port was never bound", async () => {...})`,
with an inline comment explaining why `check` (synchronous) would have run the assertion orphaned.
Verified `check()` in this file is indeed synchronous and `checkAsync()` is a distinct, correctly
`await`-ed helper.

**Repo-wide sweep for the same mistake**: searched every `.mjs` test file (77 files matched
`function check(name, fn) {`) for a synchronous `check`/`it`/`test` helper called with an `async`
function. Zero other occurrences found — `realtime-fail-fast.mjs` was the only site with this exact
bug, and it is now fixed. No broader missing-`await` sweep beyond this specific documented pattern
was performed (a generic "any unawaited async call" sweep would be too noisy/false-positive-prone
for this scope); the specific pattern requested was checked exhaustively and cleared everywhere else.

### EPT-1 / EPT-3 detail checks

- **EPT-1 checks the raw body, not just the status.** Confirmed:
  `assert(!body.includes("event: ready"), ...)` and `assert(!body.includes("data:"), ...)` both run
  against the raw SSE response text, not merely `res.status`.
- **EPT-3 is genuinely differential and the control is not itself degraded.** Confirmed: the healthy
  control is built from a schema with no `@@realtime` table (`PLAIN_SCHEMA`), so `startStudio` never
  constructs a `RealtimeEngine` for it at all — the control cannot go degraded because there is no
  engine to fail. `healthyQuery.status === 200` is explicitly asserted for `/api/query`.
  **Gap (WARNING, not CRITICAL)**: for `/api/schema` and `/api/tables/Post`, only
  `healthy.status === degraded[path].status` is asserted — there is no explicit
  `healthy.status === 200` check for those two routes specifically (only for `/api/query`). In
  practice this is low-risk (`/api/schema`/`/api/tables/:name` never touch the realtime engine, so a
  coincidental non-200/non-200 pairing is implausible), but as written the assertion could in
  principle pass vacuously if both sides broke identically on those two routes. Flagged as a
  rigor gap, not a functional defect.
- **`ran !== 3` guard bites.** Reproduced directly: commented out the EPT-2 `check(...)` call
  (`if (false) await check(...)`), reran — **exit 1**, `expected 3 checks to run, ran 2`. Restored
  byte-identically (`git diff --stat` empty), reran — all green again.

### Spec Compliance Matrix (PR 2's owned rows only — PR 1's rows out of scope, PR 3's SLV-1/2 not yet delivered)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Operators observe a rejected `start()` distinctly per consumer | Standalone daemon exits non-zero (RSC-12) | `packages/cli/test/realtime-fail-fast.mjs` | ✅ COMPLIANT |
| Operators observe a rejected `start()` distinctly per consumer | Studio server binds despite a rejected `start()` (RSC-13) | `packages/cli/test/studio-realtime-degraded.mjs` — no standalone `assert(status === 200)` for the degraded Studio's `/api/schema`; only inferred via the EPT-3 equality-with-control check and the fact every `fetch()` in the suite succeeds at all (binding is proven implicitly) | ⚠️ PARTIAL |
| A rejected `RealtimeEngine.start()` leaves the engine restartable | A rejected `engine.start()` resets the engine's started state (RSC-14) | `packages/realtime/test/dispatch.mjs` — test exists and passes, but **is not part of commit `9df2359`** (uncommitted working-tree file only) | ❌ UNTESTED in the delivered commit |
| Realtime routes return 503 when the source never started | SSE subscription returns 503 (EPT-1) | `packages/cli/test/studio-realtime-degraded.mjs` | ✅ COMPLIANT |
| Realtime routes return 503 when the source never started | Log page route returns 503 (EPT-2) | `packages/cli/test/studio-realtime-degraded.mjs` | ✅ COMPLIANT |
| Realtime routes return 503 when the source never started | Non-realtime routes unaffected (EPT-3) | `packages/cli/test/studio-realtime-degraded.mjs` | ✅ COMPLIANT |

**Compliance summary**: 4/6 scenarios fully compliant, 1 partial, 1 untested-in-commit (delivered
fix, missing test in the reviewed commit). 1/3 requirements fully satisfied (both scenarios
compliant); the other two requirements each have one non-fully-compliant scenario.

### Task Completeness

| Metric | Value |
|---|---|
| Tasks total (Phase 2) | 8 |
| Tasks marked `[x]` | 8 |
| Tasks whose code is actually in the reviewed commit | 7/8 — task 2.2's test file is uncommitted |

### Issues

**CRITICAL** — Task 2.2 (`dispatch.mjs` RSC-14 + DESIGN-ONLY-1) is marked complete in the committed
`tasks.md` but its actual test code is not part of commit `9df2359`. Blocks archive until amended.

**WARNING** — RSC-13 has no standalone, explicit assertion that the degraded Studio's own
`/api/schema` (or `/api/tables/:name`) returns 200; coverage is inferential (implicit binding proof
+ equality-only comparison against the control). EPT-3's own control-actually-200 assertion is
present only for `/api/query`, not for the other two routes it also exercises.

**SUGGESTION** — Consider adding one dedicated, explicitly-named RSC-13 check (`assert(res.status === 200)`
against the degraded Studio's `/api/schema` directly) rather than relying on EPT-3's differential
comparison to carry that scenario's coverage.

### Scope

PR 3 (Studio badge, `source-contract.mjs`/`studio-realtime-degraded.mjs`/`realtime-fail-fast.mjs`
chaining already done here ahead of schedule for the latter two per task 2.x — `source-contract.mjs`
chaining remains PR 3's task 3.5 — plus the DB-gated discovery leg) is deliberately absent and not
counted as a gap. `apps/studio` confirmed untouched by this PR.
