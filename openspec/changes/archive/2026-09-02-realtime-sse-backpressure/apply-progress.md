# Apply Progress: Realtime SSE backpressure

**Mode**: Strict TDD
**Status**: 26/26 tasks complete. Ready for verify.

## Safety Net

Baseline run of `node packages/realtime/test/dispatch.mjs` before any edit: **8/8 checks passing**
(B1.1a, B1.1b, B1.1c, B1.2, RLE-1, RLE-3, RSC-14, DESIGN-ONLY-1). Nothing pre-existing was broken.

## Phase 1 — RED (task 1.1–1.8)

`fakeSubscriber()` upgraded with mutable `writableLength`, `refuse` mode, `hwm` (default 65536),
`isEnded()`, `drain(n)`. Added `makeEngine(tables, extra)` (extra engine options) and a `sleep()`
helper.

Six new `check()` cases added for RSB-1, RSB-3/RSB-5, RSB-6, RSB-7, RSB-10, RSB-11. Ran
`node packages/realtime/test/dispatch.mjs` against the untouched `engine.ts` — **all six FAILED
exactly as predicted**, for the predicted reason (no eviction logic exists yet), not for an
unrelated fixture bug:

```
FAIL - RSB-1: heartbeat tick over a stalled subscriber evicts it via the same bounded path
  AssertionError: stalled subscriber must not receive a :ping frame, got: event: ready ... |:ping| x7
FAIL - RSB-3/RSB-5: over-cap subscriber is evicted instead of written to, and stays evicted on a second dispatch
  AssertionError: over-cap subscriber must not receive the change frame, got: event: ready ... |event: change ...
FAIL - RSB-6: eviction removes and ends the subscriber even when the socket refuses every write
  AssertionError: subscriber must still be ended even though no frame could be flushed
FAIL - RSB-7: eviction reports through onError exactly once
  AssertionError: onError must be invoked exactly once for one eviction — 0 !== 1
FAIL - RSB-10: a healthy subscriber registered after the evicted one still receives the frame
  AssertionError: B must not receive the change frame
FAIL - RSB-11: a healthy subscriber registered after the evicted one still receives the heartbeat
  AssertionError: B must not receive the heartbeat
8 check(s) passed. (the 8 pre-existing ones; 6 new ones FAILED)
```

RED confirmed (task 1.8).

## Phase 2 — GREEN (task 2.1–2.8)

`packages/realtime/src/engine.ts`:
- `DEFAULT_MAX_BUFFERED_BYTES = 1_048_576` (exported), `RealtimeEngineOptions.maxBufferedBytes?`
  with the doc comment stating the `.live()`/`useLiveTable` vs raw `subscribe()` distinction
  (RSB-8's doc home).
- `private send(sub, frame): boolean` — re-entrancy guard (`!subscribers.has(sub)`), probes
  `sub.res.writableLength ?? 0` against the cap before writing, evicts on over-cap, otherwise
  `res.write(frame)`.
- `private evict(sub, buffered): void` — idempotence guard (`!subscribers.delete(sub)` → return),
  best-effort `event: overflow` write, best-effort `res.end()`, `onError` with a message starting
  `[backpressure] SSE subscriber evicted:` carrying buffered bytes, cap, and `tables`.
- All four write sites (heartbeat, `ready`, `wake`, `change`) rerouted through `send()`.
- Both iteration loops (heartbeat, `dispatch()`'s fan-out) snapshot via `[...this.subscribers]`.
- `dispatch()` signature confirmed unchanged: `private dispatch(event: RealtimeEvent): void` — no
  `async`, no `await`, no queue.
- `stop()` confirmed unmodified — still its own `res.end()` + `clear()` loop, not routed through
  `evict()` (design decision 11).

Rebuilt (`pnpm --filter @indigodb/realtime build`) and reran: all 6 new checks turned GREEN, no
regression on the 8 pre-existing ones (14/14 total). Task 2.8 confirmed.

## Phase 3 — RSB-2, RSB-4 (task 3.1–3.3)

- **RSB-2**: written as a combined RED+regression-guard case — the "A evicted / A has no frame"
  half is genuinely RED against the untouched tree; the synchrony half (asserted immediately after
  `emit()` returns, no `await`) passes today by construction and is labelled as a regression guard
  in the test's comment, per design. Both halves pass post-Phase-2.
- **RSB-4**: negative control at `writableLength: 999` vs cap `1000` — passes by construction, not
  RED, as stated in its comment.
- **Task 3.3 — mandatory mutation proof.** During the mutation pass a genuine finding surfaced: the
  `999`-only fixture does NOT distinguish `buffered > cap` from `buffered >= cap` (both evaluate to
  `false` at `999` vs `1000`). Per the task's own instruction ("an unbitten mutation is a finding
  about the test, not a reason to move on"), the fixture was strengthened with a companion case,
  **RSB-4b**, asserting a subscriber buffered at EXACTLY `maxBufferedBytes` (`1000`) is also not
  evicted — the true boundary where `>` and `>=` disagree. Both RSB-4 and RSB-4b's fake `hwm` were
  also pinned to `maxBufferedBytes` (not the default `65536`) so the fixture would additionally be
  sensitive to mutation B.

  **Mutation A** (`>` → `>=`): `RSB-4b` FAILED (`a subscriber buffered at exactly the cap must
  still receive the frame`); `RSB-4` (cap−1) still passed since both operators agree there — 16/17
  green, 1 failed. Reverted; reran clean (17/17).

  **Mutation B** (probe swapped from `sub.res.writableLength` before the write to
  `sub.res.write(frame)`'s boolean return after the write): BOTH `RSB-4` and `RSB-4` `b` FAILED
  (`... must not be evicted`), along with every other eviction-expecting case (9/17 passed, 8
  failed) — because with the fake's default `hwm`, `write()` never returns `false` at the cap
  values used elsewhere, so mutation B additionally broke eviction entirely for those cases; for
  RSB-4/RSB-4b specifically, pinning `hwm` to the cap made `write()`'s own internal counter cross
  `hwm` mid-write and evict a non-stalled subscriber. Reverted.

  **Final clean run**: `node packages/realtime/test/dispatch.mjs` → 17/17 green, `PASSED`.

  Full transcript of both mutation outcomes and the final clean run is recorded verbatim in
  `tasks.md` under task 3.3.

## Phase 4 — Documentation (RSB-8) and reachability guard (task 4.1–4.3)

- RSB-8: no executable test written (by design — a grep-for-a-sentence assertion would test the
  string, not the guarantee). Coverage is the spec's already-authored
  `### Requirement: Raw subscribe() consumers are a documented lossy path under eviction` section
  plus the `maxBufferedBytes` doc comment added in task 2.1 (verbatim `.live()`/`useLiveTable` vs
  raw `subscribe()` distinction). Both confirmed present.
- `ran` count: counted directly — **17** total `check()` calls in `dispatch.mjs` (confirmed via
  `rg -c 'await check\('`). Added
  `strictEqual(ran, 17, "expected exactly 17 check() cases in dispatch.mjs")` as the new trailing
  guard, appended after the untouched `strictEqual(ran, 6, ...)` RCP-13 guard (left exactly as-is).
  Message text and number agree with each other and with the counted total.
- `scripts/check-realtime-projection-db-gate.mjs` run directly: **PASSED** — `dispatch.mjs` was
  already in `GUARDED_FILES`; no edit needed.

## Phase 5 — Cross-package verification (task 5.1–5.4)

- `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root: **all green**
  (10/10 build tasks, 19/19 lint tasks, 18/18 test tasks — exit code 0). `--force` used as
  mandated.
- `node packages/realtime/test/dispatch.mjs` standalone: **17/17 green, PASSED**. Also confirmed
  inside `pnpm test`'s full chain (`packages/realtime` test script runs `dispatch.mjs` last).
- `scripts/check-realtime-projection-db-gate.mjs` reconfirmed on the final built/linted tree:
  **PASSED**.
- `openspec/changes/realtime-sse-backpressure/proposal.md` Success Criteria checkboxes updated to
  `[x]`, each referencing the exact `tasks.md` task as evidence. The original "verified by a
  typecheck-level guard" wording for the `dispatch()`-stays-sync criterion was explicitly replaced
  per the design's documented correction (no typecheck guard exists — no compiler error trips when
  `dispatch` is made `async`, since the sole call site accepts a value-returning callback where
  `void` is expected); RSB-2's runtime synchrony assertion plus the review-time constraint stand in
  its place.

## TDD Cycle Evidence

| Task(s) | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 1.1–1.8 (RSB-1, RSB-3/5, RSB-6, RSB-7, RSB-10, RSB-11) | `packages/realtime/test/dispatch.mjs` | Unit | ✅ 8/8 | ✅ Written, confirmed FAILED for the predicted reason | ✅ Passed post-Phase-2 | ✅ 6 distinct scenarios, each with independent fixtures | ➖ None needed — `send()`/`evict()` written directly against the full scenario set |
| 3.1 (RSB-2) | `packages/realtime/test/dispatch.mjs` | Unit | ✅ 14/14 | ✅ Written (partial RED — eviction half) | ✅ Passed | ➖ Single scenario per spec | ➖ None needed |
| 3.2/3.3 (RSB-4, RSB-4b) | `packages/realtime/test/dispatch.mjs` | Unit | ✅ 15/15 | N/A — negative control, not RED (stated explicitly) | ✅ Passed by construction | ✅ RSB-4b added as a second boundary case after the mutation task exposed the first fixture's blind spot | ➖ None needed |
| 4.2 (`ran` guard) | `packages/realtime/test/dispatch.mjs` | N/A (reachability guard) | N/A | N/A | ✅ `strictEqual(ran, 17, ...)` passes | N/A | N/A |

### Test Summary
- **Total tests written**: 9 new `check()` cases (RSB-1, RSB-3/RSB-5, RSB-6, RSB-7, RSB-10, RSB-11,
  RSB-2, RSB-4, RSB-4b) + 1 reachability guard (`strictEqual(ran, 17, ...)`)
- **Total tests passing**: 17/17 `check()` cases + reachability guard, standalone and inside the
  full `pnpm test` chain
- **Layers used**: Unit (17), Integration (0), E2E (0) — no DB, per spec requirement
- **Approval tests** (refactoring): None — no refactoring tasks, this is additive indirection
  over 4 existing call sites
- **Pure functions created**: 0 — `send()`/`evict()` are necessarily impure (mutate the
  `subscribers` registry and the response stream), matching the design's stated approach

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/realtime/test/dispatch.mjs` → `17 check(s) passed.` / `PASSED` |
| Runtime harness command/scenario and exact result | `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root → 10/10 build, 19/19 lint, 18/18 test, exit code 0; `scripts/check-realtime-projection-db-gate.mjs` → `PASSED` |
| Rollback boundary | Single-commit revert restores unguarded `res.write()` at the 4 call sites in `packages/realtime/src/engine.ts`; `send()`/`evict()` are pure additive indirection. `dispatch.mjs`'s new checks can be reverted independently of `engine.ts` (Phase 1 predates Phase 2) |

## Files Changed

| File | Action | What Was Done |
|---|---|---|
| `packages/realtime/src/engine.ts` | Modified | `DEFAULT_MAX_BUFFERED_BYTES`, `maxBufferedBytes` option + doc comment, `send()`, `evict()`, 4 write sites rerouted, 2 loops snapshotted |
| `packages/realtime/test/dispatch.mjs` | Modified | `fakeSubscriber()` upgraded (writableLength/refuse/hwm/isEnded/drain), `makeEngine(tables, extra)`, `sleep()`, 9 new `check()` cases, new `strictEqual(ran, 17, ...)` reachability guard |
| `openspec/changes/realtime-sse-backpressure/tasks.md` | Modified | All 26 tasks marked `[x]`; task 3.3 filled in with the mutation proof's observed results |
| `openspec/changes/realtime-sse-backpressure/proposal.md` | Modified | Success Criteria checkboxes checked with evidence references |

## Deviations from Design

None on the production-code approach — `send()`/`evict()`, the cap semantics, the doc comment
text, and the 4-site rerouting all match the design exactly.

One test-fixture deviation from the tasks artifact's literal instruction, disclosed per the
mandatory-finding rule in task 3.3: the specified `writableLength: 999` fixture alone cannot
distinguish `buffered > cap` from `buffered >= cap` (both agree at `999` vs cap `1000`). Added a
companion case (RSB-4b) at the true boundary (`buffered === cap`) rather than silently accepting an
unbitten mutation. This is a strengthening, not a scope change — RSB-4's original assertions are
unchanged.

## Issues Found

None beyond the RSB-4 fixture gap documented above, which was resolved within Phase 3 before
proceeding.

## Remaining Tasks

None — 26/26 complete.

## Workload / PR Boundary

- Mode: single PR (per tasks.md forecast — `400-line budget risk: Low`, `Chained PRs recommended: No`)
- Current work unit: N/A — full change applied in one pass (all 3 suggested work units landed
  together, no PR slicing needed)
- Boundary: this apply batch starts from an untouched tree and ends with the full change
  implemented, tested, and cross-package-verified
- Estimated review budget impact: ~347 authored lines across `engine.ts` (+90/-8) and
  `dispatch.mjs` (+~250, net of the mutation-only edits which were reverted) — within the 800-line
  session budget as a single PR

## Status

26/26 tasks complete. Ready for verify.

---

## Orchestrator independent reproduction of the task 3.3 mutation proof

The apply phase's mutation transcript was not taken on trust. Both mutations were re-run
independently by the orchestrator on the committed tree (`7f9e0b7`), rebuilding
`@indigodb/realtime` between each so the suite ran against the mutated `dist/`, then reverting.

**Mutation A — probe comparison `>` → `>=`** (suite exit 1):

```
ok   - RSB-4:  buffered at cap - 1 is NOT evicted (negative control)
FAIL - RSB-4b: buffered at EXACTLY cap is NOT evicted — the >/>= distinguishing case
```

This is the empirical confirmation of the apply phase's finding, and it is worth stating
plainly: **RSB-4 alone does not detect this mutation.** At `cap - 1`, `>` and `>=` evaluate
identically, so the originally specified fixture would have passed a mutated build and reported
the negative control as proven. Only RSB-4b, sitting on the exact boundary, fails. The
design's and tasks' `writableLength: 999` fixture was too weak, and the mutation pass is what
exposed it — which is the entire reason the mutation task is mandatory rather than advisory.

**Mutation B — probe source `res.writableLength` → `res.write()`'s boolean return** (suite exit 1):
seven cases fail (RSB-1, RSB-3/5, RSB-7, RSB-10, RSB-11, RSB-2, RSB-4, RSB-4b). RSB-6 correctly
still passes: its subscriber refuses every write, so `write()` returns `false` and eviction still
occurs — the one case whose outcome is genuinely invariant under this mutation.

**After revert**: `node packages/realtime/test/dispatch.mjs` → `17 check(s) passed. PASSED`,
`git status packages/` clean.
