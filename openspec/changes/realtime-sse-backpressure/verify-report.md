# Verification Report: realtime-sse-backpressure

**Change**: `realtime-sse-backpressure`
**Mode**: Full artifacts (proposal, spec, design, tasks, apply-progress) — Strict TDD verify
**Branch**: `feat/realtime-sse-backpressure` @ `addaaa1` (base `main` @ `d889745`)

## Completeness

| Task phase | Tasks | Status |
|---|---|---|
| Phase 1 (RED) | 1.1–1.8 | ✅ all `[x]`, code present |
| Phase 2 (GREEN) | 2.1–2.8 | ✅ all `[x]`, code present |
| Phase 3 (RSB-2/RSB-4) | 3.1–3.3 | ✅ all `[x]`, mutation proof recorded and independently re-verified by the orchestrator |
| Phase 4 (docs/guard) | 4.1–4.3 | ✅ all `[x]` |
| Phase 5 (cross-package) | 5.1–5.4 | ✅ all `[x]` |

**26/26 tasks complete**, all `[x]`.

**Commit-landing check**: `git show --stat 7f9e0b7` includes BOTH `packages/realtime/src/engine.ts` and
`packages/realtime/test/dispatch.mjs` in the same commit (plus the SDD artifacts and `tasks.md`/`proposal.md`
updates). No task's code was left out of the commit — this repo's previous failure mode (narrow `git add`
splitting code from its test) did not recur here.

## Build/Test/Gate Evidence (executed by this verify pass, not trusted from the report)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | exit 0, 10/10 build tasks |
| `pnpm lint` | exit 0, 19/19 lint tasks (cached, content-hash identical to the fresh build) |
| `pnpm test` | exit 0, 18/18 test tasks; `@indigodb/realtime:test` → `17 check(s) passed. PASSED` |
| `node packages/realtime/test/dispatch.mjs` (standalone, re-run independently) | exit 0, **17/17 green**, `PASSED` |
| `node scripts/check-realtime-projection-db-gate.mjs` | `PASSED` — `dispatch.mjs`, `wal-source.mjs`, `realtime-projection.mjs` all carry no `INDIGODB_TEST_DATABASE_URL` reference |

`rg -c "await check\("` on `dispatch.mjs` → **17**, matching the `strictEqual(ran, 17, ...)` guard's number and
message. The pre-existing `strictEqual(ran, 6, "expected exactly 6 check() cases to run in dispatch.mjs")` line
(RCP-13's positional guard) is present unchanged — confirmed via `git diff d889745 7f9e0b7` showing no `-` line
for it, only the new `+strictEqual(ran, 17, ...)` addition at the end of the file.

## Spec Scenario Coverage (11 scenarios, spec.md)

| # | Scenario | Test | Verdict |
|---|---|---|---|
| 1 | Heartbeat subject to the same cap | RSB-1 | ✅ COVERED — RED confirmed in apply-progress, GREEN standalone |
| 2 | Stalled subscriber doesn't delay dispatch to others | RSB-2 | ✅ COVERED (partially RED, partially regression-guard, both stated honestly in-comment) |
| 3 | Over-cap subscriber evicted instead of written to | RSB-3 | ✅ COVERED |
| 4 | Cap−1 subscriber not evicted | RSB-4 + RSB-4b | ✅ COVERED — see mutation analysis below |
| 5 | Eviction during broadcast doesn't disturb remaining subscribers (dispatch fan-out) | RSB-10 | ✅ COVERED — genuine 3-subscriber A/B/C fixture, verified below |
| 5b | Eviction during broadcast doesn't disturb remaining subscribers (heartbeat) | RSB-11 | ✅ COVERED — same A/B/C shape, verified below |
| 6 | Evicted subscriber's connection is closed | folded into RSB-3 | ✅ COVERED |
| 7 | Eviction proceeds even if overflow frame can't flush | RSB-6 | ✅ COVERED for the "write returns false" case (see WARNING-2 below on the throw path) |
| 8 | Eviction invokes `onError` | RSB-7 | ✅ COVERED |
| 9 | Raw `subscribe()` is a documented lossy path | RSB-8 | ✅ COVERED as documentation-only, correctly declared unprovable by test — confirmed present in both `spec.md`'s `### Requirement: Raw subscribe() consumers are a documented lossy path under eviction` and `engine.ts`'s `maxBufferedBytes` doc comment (verbatim `.live()`/`useLiveTable` vs raw `subscribe()` distinction) |
| 10 | Backpressure suite passes with no DB | RSB-9 (structural) | ✅ COVERED — `check-realtime-projection-db-gate.mjs` PASSED |

Every scenario with a corresponding test executes and passes. RSB-8 is the one documentation-only scenario, and
its coverage is confirmed present (not merely claimed) in both locations required by the spec.

## Adversarial Test-Quality Checks

1. **RSB-2 synchrony half**: confirmed the test's own comment and apply-progress both explicitly label the
   synchrony assertion as "passes today by construction" / "a regression guard for a future async drift", not
   proof of RED or of synchrony as a capability. Verify pass concurs — the report does not overclaim it.

2. **RSB-10/RSB-11 three-subscriber fixture**: read the actual fixture, not the test name. Confirmed
   `dispatch.mjs:464-481` (RSB-10) and `:488-511` (RSB-11) register three subscribers `a` (writableLength 0),
   `b` (writableLength 5000), `c` (writableLength 0) in that literal order via three sequential
   `engine.handleRequest()` calls, then assert **both** `a` and `c` receive exactly one frame, `b` receives
   none, `b` is evicted, and `subscribers.size === 2`. This is a genuine three-party fixture with the healthy
   subscriber (`c`) registered strictly after the stalled one (`b`) in iteration order — the shape the spec's
   scenario requires to make a skip observable. A two-subscriber fixture could not have detected this defect
   class; this one can and does (both cases were independently reproduced as RED against the untouched design
   per apply-progress's Phase 1 evidence).

3. **RSB-6**: verified `evict()`'s actual code (`engine.ts:455-473`) — registry removal happens **first**
   (`this.subscribers.delete(sub)`), then a best-effort `event: overflow` write, then `res.end()`, both wrapped
   in `try/catch`. The test's `refuse: true` fixture makes `write()` return `false` (not throw), which the fake
   models as "the socket accepts nothing at all." The test does prove eviction proceeds when the write is
   rejected via a `false` return. It does **not** exercise the `catch` block for a write/end call that actually
   *throws* — no fixture in this suite makes `write()` or `end()` throw. This is a narrower claim than "RSB-6
   proves eviction survives any way the overflow frame can fail to flush"; it proves the more common
   `false`-return backpressure signal, not the throwing-socket case. **SUGGESTION**, not CRITICAL: the shipped
   `evict()` code handles the throw case defensively and correctly by inspection (removal precedes both writes,
   `catch {}` prevents propagation), and the throw path is a materially less likely real-world failure mode
   than a rejected write; the gap is in test breadth, not shipped behavior.

## Independent Construction — Double-Evict Path

Reviewed `engine.ts:252-254` — `req.on("close", () => { this.subscribers.delete(sub); })` — and confirmed the
**shipped test suite's fake `req.on()` is a no-op that never invokes the registered callback**
(`dispatch.mjs:72-76`), so no test in `dispatch.mjs` actually fires the real-world sequence "eviction calls
`res.end()`" → "Node fires the request's `close` event" → "the close handler calls `subscribers.delete(sub)` a
second time on an already-evicted subscriber." This path exists in production and its safety rests entirely on
`evict()`'s `if (!this.subscribers.delete(sub)) return;` idempotence guard (design decision 5), which is
correct by code inspection but was not exercised end-to-end by the shipped suite.

To resolve this rather than merely flag it, I constructed the scenario directly against the built artifact
(`packages/realtime/dist/index.js`) with a fake `req` that captures and exposes the real close callback:
evicted a subscriber via a normal over-cap dispatch, then manually invoked the captured close callback exactly
as Node would after `res.end()`. Result: `subscribers.size` stayed `0`, `onError` was invoked exactly once (not
twice), and no exception was thrown. **The double-evict path is genuinely safe** — this is a reproduced
finding, not an assumption — but the finding is that **the shipped test suite does not itself prove it**;
coverage of this path currently rests on code review plus this verify pass's manual reproduction. **WARNING**,
not CRITICAL: the behavior is correct and independently confirmed, but the regression protection for this
specific invariant is not encoded in `dispatch.mjs`, so a future change that weakens `evict()`'s idempotence
guard would not be caught by the checked-in suite.

## 4-Write-Site Coverage

Read the current file (not trusted from the design's line numbers, which had already shifted). Grep for
`.write(` in `engine.ts` returns exactly two call sites: `send()` (`:444`, `sub.res.write(frame)`) and
`evict()` (`:458`, the best-effort overflow frame). No other call site in the file calls `res.write()` directly.
Cross-referenced against the four logical sites: heartbeat (`:190`, `this.send(sub, ":ping\n\n")`), `ready`
(`:250`, `this.send(sub, ...)`), `wake` (`:420`, `this.send(sub, ...)`), `change` (`:424`,
`this.send(sub, ...)`). **All four route through `send()`; no hole in the cap.**

## Iteration Safety

Both loops confirmed to snapshot before iterating: heartbeat (`:190`,
`for (const sub of [...this.subscribers])`) and `dispatch()`'s fan-out (`:415`, same pattern). `send()` opens
with `if (!this.subscribers.has(sub)) return false;` (`:438`) and `evict()` opens with
`if (!this.subscribers.delete(sub)) return;` (`:456`). `dispatch()`'s signature confirmed unchanged:
`private dispatch(event: RealtimeEvent): void` (`:410`) — no `async`, no `await`, no queue.

## Regression Surface

- `strictEqual(ran, 6, ...)` (RCP-13's guard) confirmed present and unmodified via `git diff`.
- No pre-existing `check()` case's assertions were altered — `git diff d889745 7f9e0b7 -- dispatch.mjs` shows
  only additive changes (upgraded `fakeSubscriber()` signature is backward-compatible — existing calls use the
  default empty-options form) plus the new cases and the new trailing guard.
- No new test file was created; all new coverage lives inside `dispatch.mjs`, already in
  `check-realtime-projection-db-gate.mjs`'s fixed `GUARDED_FILES` list — confirmed by running the gate script
  directly (PASSED) rather than assuming.
- No new test references `INDIGODB_TEST_DATABASE_URL` — confirmed by the gate script's own check, which
  explicitly asserts this for `dispatch.mjs`.

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress's "TDD Cycle Evidence" table |
| All tasks have tests | ✅ | 26/26 tasks; RSB-8 (4.1) is the one documentation-only task, correctly declared as having no test |
| RED confirmed (tests exist) | ✅ | All 9 new `check()` cases + RSB-4b exist and were verified present in `dispatch.mjs` |
| GREEN confirmed (tests pass) | ✅ | 17/17 on independent standalone re-run |
| Triangulation adequate | ✅ | RSB-3/RSB-5 folded intentionally (documented, same eviction assertions, no second engine needed — legitimate consolidation, not under-triangulation) |
| Safety Net for modified files | ✅ | Baseline 8/8 recorded before any edit; engine.ts is additive indirection over 4 existing call sites |

**TDD Compliance**: 6/6 checks passed

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 17 | 1 (`dispatch.mjs`) | plain Node `assert` |
| Integration | 0 | 0 | not installed |
| E2E | 0 | 0 | not installed |
| **Total** | **17** | **1** | |

### Assertion Quality
No banned patterns found — no tautologies, no ghost loops over possibly-empty collections, no orphan
assertions without a production-code call, no ratio issue (no mocking library used). Every new `check()` case
drives real production code (`emit()` → `dispatch()`, `engine.handleRequest()`, `engine.start()`) and asserts
on observable output (`written`, `isEnded()`, `subscribers.size`, `onError` calls) rather than internal
implementation detail (the one private-field read, `engine["subscribers"]`, is pre-existing house style in this
file, already used by `DESIGN-ONLY-1`/`RSC-14` before this change, not new coupling introduced here).

**Assertion quality**: ✅ All assertions verify real behavior

### Quality Metrics
**Linter/Type Checker**: ✅ No errors (`pnpm lint` — `tsc --noEmit`/`tsc -b --noEmit`, 19/19 tasks green)
**Coverage tool**: not available in this repo (plain Node test scripts, no coverage instrumentation) — skipped
per protocol, not a failure

## Design Coherence

Read `design.md` including the "Orchestrator amendment" section, which is authoritative over the body for
RSB-10/RSB-11 (added after the design was first authored, when the spec grew from 9 to 11 scenarios). Code
matches the design's Technical Approach, all 12 Architecture Decisions, and the Interfaces section verbatim
(`DEFAULT_MAX_BUFFERED_BYTES`, `send()`/`evict()` signatures, doc comment text). No deviation found beyond the
one disclosed test-fixture strengthening (RSB-4b, added because the originally specified `writableLength: 999`
fixture could not distinguish `>` from `>=` — this is a strengthening, not a scope change, and was disclosed
per the tasks' own mandatory-finding rule).

## Issues

### CRITICAL
None.

### WARNING
1. **Double-evict path (`res.end()` → `req.on("close")` → second `subscribers.delete(sub)`) is not exercised
   by the shipped test suite.** The shipped fake's `req.on()` is a no-op, so no `check()` case in `dispatch.mjs`
   actually fires the real close-callback sequence. Verified safe by independent manual reproduction against
   the built artifact (see above) — `evict()`'s idempotence guard behaves correctly — but this specific
   invariant has no regression protection in the checked-in suite. Recommend a follow-up `check()` case using a
   `req.on()` fake that captures and can invoke the close callback.

### SUGGESTION
1. **RSB-6 proves the "write returns `false`" backpressure signal, not a throwing write/end.** `evict()`'s
   `try/catch` around both `sub.res.write("event: overflow...")` and `sub.res.end()` is correct by inspection
   but has no fixture that makes either call throw. Lower priority than the WARNING above since the shipped
   spec scenario language ("cannot accept any further writes at all") is reasonably satisfied by the
   `refuse: true`/return-`false` fixture already present; a throwing-socket fixture would close a narrower gap.

## Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING, 1 SUGGESTION.

All 26 tasks are complete and their code landed in the commits claimed. All 11 spec scenarios (10 executable +
1 documentation-only, both correctly classified) are covered by tests that pass on independent re-execution.
The mutation proof for RSB-4/RSB-4b was independently reproduced by both the orchestrator and cross-checked
during this verify pass (code inspection of the exact operator/probe-source lines named in the mutation
transcript). The root gate (`pnpm clean && pnpm build --force && pnpm lint && pnpm test`) is green, and the
DB-gate script passes. The two findings above are test-coverage gaps in already-correct shipped code, not
defects in shipped behavior — neither blocks archival, but the WARNING is worth a follow-up task before this
capability is extended further.

---

## WARNING closed by the orchestrator (post-verify)

Verify's WARNING — the `evict()` idempotence guard had no regression test, because the fake's
`req.on()` was a permanent no-op — is now closed by **RSB-12** in `dispatch.mjs`. The suite guard
moves 17 → 18, message aligned.

**The first attempt at this test did not bite, and the reason corrects the design.** RSB-12 was
first written to reach the guard through the teardown sequence: make the fake's `end()` fire the
registered `close` listener, the way Node does, and assert the re-entrant path reports only one
eviction. It passed — and it still passed with the guard mutated away
(`if (!this.subscribers.delete(sub)) return;` → `this.subscribers.delete(sub);`), which means it
proved nothing.

The cause is a factual error carried in the design and repeated in the apply and verify launch
prompts: `handleRequest`'s close listener does **not** re-enter `evict()`. It calls
`this.subscribers.delete(sub)` directly (`engine.ts:252-254`). There is therefore no reachable
re-entrant path into `evict()` at all — the guard is **defensive**, not a response to a live
double-call.

RSB-12 was rewritten to say that plainly: it evicts once through the ordinary over-cap path, then
calls `engine["evict"](sub, 5000)` a second time directly for the already-removed subscriber, and
asserts the second call reports no second eviction and does not disturb the registry. A white-box
call on a private method is the honest shape here, because no black-box path reaches it.

**Mutation-proved** (the mutation is what exposed the first version as worthless):

```
guard removed  → FAIL - RSB-12: evict() is idempotent — a second call reports no second eviction
                 AssertionError: a second evict() for the same subscriber must not report again
reverted       → 18 check(s) passed. PASSED
```

**Root gate after the change**: `pnpm clean && pnpm build --force && pnpm lint && pnpm test` →
exit 0, `Tasks: 18 successful, 18 total`.

Verify's SUGGESTION (RSB-6 proves only the write-returns-`false` path, not a *throwing* write or
`end()`) remains open and is recorded in the archive report as a follow-up.
