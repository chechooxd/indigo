# Verification Report: add-postgres-integration-tests

**Mode**: full (proposal + specs + design + tasks all present)
**Verdict**: PASS

## Completeness

27/28 tasks complete. Task 5.5 (promote the `migration-golden-tests` spec delta into
`openspec/specs/`) is legitimately deferred to `sdd-archive` — confirmed by inspection:
`openspec/specs/migration-golden-tests/spec.md` still carries the OLD wording
("Golden fixtures pin generated text, not applicability"), and the delta at
`openspec/changes/add-postgres-integration-tests/specs/migration-golden-tests/spec.md`
is present, well-formed, and content-consistent with what shipped. This is standard
SDD archive-time promotion, not a gap.

## Gate Evidence (verbatim / summarized)

### `pnpm build` — PASS (10/10 tasks, FULL TURBO cache)
```
 Tasks:    10 successful, 10 total
Cached:    10 cached, 10 total
```

### `pnpm lint` — PASS (18/18 tasks, `tsc --noEmit`, FULL TURBO cache)
```
 Tasks:    18 successful, 18 total
Cached:    18 cached, 18 total
```

### `cd crates && cargo test` — PASS
```
running 4 tests ... test result: ok. 4 passed; 0 failed
running 19 tests ... test result: ok. 19 passed; 0 failed
Doc-tests indigo_compiler: 0 passed; 0 failed
```

### `pnpm test` — PASS, forced LIVE re-run (not cache replay)
Forced with `turbo run test --filter=@indigodb/migrator --force` to rule out a stale
cache pass: **6/6 tasks, 0 cached, wall time 1m35.7s** (matches the documented ~75-95s
PGlite WASM boot cost). All fixtures + regression + isolation checks green:
```
migrator regression: all green
...
migrator appliability: PostgreSQL execution suite (PGlite, in-process)
Scope: "appliability" — the emitted SQL executes without error on a single-connection
engine. This is NOT a proof of production correctness under concurrency: concurrent
deploys, advisory locking, and connection-pool behaviour stay explicitly out of scope.

  ok   harness self-test: invalid DDL rejects, nothing counted as executed
  ok   regression: FK-ordering stays fixed — ...
  ok   regression: enum ADD VALUE stays split — ...
  [21 fixtures × 3 checks: apply/refuse cleanly, round-trip invariant, pushSql idempotent]
  ok   fixture isolation: two fixtures reusing the same object name don't interfere

migrator appliability: all green
```
Root `pnpm test` (13 workspace tasks) also green, cache-consistent with the forced run.

## Requirement Traceability Matrix

| # | Requirement (spec) | Test evidence | Status |
|---|---|---|---|
| 1 | Non-refusal fixtures apply successfully against real PostgreSQL | `appliability.mjs` fixture loop, 18 non-refusal fixtures × `applyPlan` against PGlite | PASS |
| 2 | Refusal fixtures assert nothing executes | Same loop, `REFUSAL_FIXTURES` branch: `diagnostics>0`, `statements===0`, `sql===""`, `executed===0`; harness self-test proves the counter/error path is real (not swallowed) | PASS |
| 3a | Pre-transaction statement runs outside the transaction | `applyPlan` structurally executes `preTransaction` statements before `BEGIN`; `enum-add-value`/`enum-add-value-and-use` fixtures apply cleanly | PASS |
| 3b | Executing a pre-transaction statement inside a transaction fails | Hand-built `LEGACY_ENUM_SINGLE_TX_SQL` + `assertRejects(/unsafe use of new value/)` — empirically re-verified live (see Adversarial Findings) | PASS |
| 4 | `renderPushSql` output is idempotent | All 21 fixtures: `pushSql` applied twice to a clean DB, both assert success | PASS |
| 5a | FK-ordering historical-bug regression stays fixed | `assertRejects(LEGACY_FK_ORDER_SQL, /relation "User" does not exist/)` + `assertApplies` on current `fk-order-declaration` emission | PASS |
| 5b | Enum-transaction historical-bug regression stays fixed | `assertRejects(LEGACY_ENUM_SINGLE_TX_SQL, ...)` + `assertApplies` via real split on `enum-add-value-and-use` | PASS |
| 6 | Each fixture runs against isolated, clean DB state | Fresh `new PGlite()` per `withDatabase` call (structural, not reset-based); explicit same-object-name cross-fixture test | PASS |
| 7 | Suite wired into workspace test fan-out | `package.json` `test` script chains `migrator.mjs && appliability.mjs`; confirmed present in both filtered and root `pnpm test` output | PASS |
| 8 | Concurrency/pool behaviour stay out of scope, stated honestly | Runner banner + spec + design all state "appliability", explicitly disclaiming concurrency/advisory-locking/pool proof (banner uses "NOT a proof of ... correctness" as an explicit disclaimer, consistent with design's own phrasing) | PASS |
| 9 (delta) | Golden fixtures pin text; applicability proven separately | Delta file present, correctly narrows the old "not applicability" disclaimer, cross-references the new capability; promotion correctly deferred to archive (task 5.5) | PASS (deferred promotion is legitimate) |

9 requirements, 11 scenarios across both specs — all have runtime-passing covering tests. No requirement found without test backing.

## Adversarial Findings (empirically verified, not just read)

I did not take the "regression test would fail if reverted" claim on file; I actually
reverted the fix and re-ran the suite live.

1. **Bug was real and previously undetected** — confirmed. The pre-fix `splitMigrationSql`
   silently classified a LAST marker block's final line as `""` instead of
   `NO_TRANSACTION_END`, because `renderMigrationSql`'s single trailing `\n` survives a
   `\n\n`-split when the marker block is the file's last chunk. Confirmed by direct code
   reading of `plan.ts` and by reverting.

2. **The fix is minimal and backward-compatible** — confirmed. ~10 lines. The change only
   strips one trailing blank line for *marker-shape detection*; the original `block`
   (untouched) is still what gets pushed to `transactionalBlocks` for the unmarked branch,
   so unmarked output stays byte-identical. Both pre-existing `splitMigrationSql` unit
   tests (no-marker, marker-not-last) pass unchanged.

3. **Regression test would fail if reverted** — confirmed empirically. I reverted
   `plan.ts` via `git apply -R` on commit `8619c4d`, rebuilt, and re-ran:
   - `migrator.mjs`'s new unit test ("marker block is the LAST block...") **FAILS** on
     revert (`expected []`, got the missing statement).
   - `appliability.mjs`'s round-trip invariant **FAILS** for both `enum-add-value` and
     `enum-value-mapped` (the two fixtures whose marker block is their only/last block).
   - Notably, **no execution-based ("prev applies, plan applies") test fails** on revert
     for those two fixtures — the statement still applies successfully, just inside the
     wrong transactional context, exactly as the design's own text predicts ("working
     only by luck because nothing in the same migration consumed the new enum value").
     This is a real, structural limitation of execution-only testing for this exact bug
     shape and is *why* the round-trip invariant exists — it is not decorative, it is the
     only test (besides the unit test) that catches this class of regression. This is
     consistent with, not contradicted by, the design document.
   - I restored `plan.ts` afterward; working tree confirmed clean.

4. **Would the suite catch a fully broken phase split (not just the last-block edge
   case)?** Tested directly: I patched `isMarked` to always be `false` (fully disabling
   marker detection), rebuilt, and re-ran. Result: the regression pair test
   ("regression: enum ADD VALUE stays split...") **FAILS with a real PostgreSQL error**
   (`unsafe use of new value "B" of enum type "S"`), and the `enum-add-value-and-use`
   fixture's own "prev applies, plan applies" test **also fails with the same real PG
   error** — this is a genuine execution-based rejection, not a structural-only catch.
   This directly answers the "could the suite pass while the migrator is broken"
   question: for a full break of the phase-split mechanism, no — it is caught by a live
   PostgreSQL rejection. Only the narrow last-block edge case relies on the structural
   round-trip invariant instead of a live rejection, and that is inherent to the bug
   shape (a fixture that reproduces it via execution failure cannot exist, because the
   bug only manifests when nothing in the same migration consumes the value — the moment
   something does, the marker block is no longer last, and the bug doesn't manifest).
   I restored `plan.ts` afterward; working tree confirmed clean.

5. **No other block-boundary edge case remains uncovered, with one WARNING** —
   - Marker-as-only/last block: covered (new unit test + round-trip invariant on
     `enum-add-value`/`enum-value-mapped`).
   - Marker-as-first-of-several block: given `renderMigrationSql`'s fixed header
     (`"-- Generated ...\n\n" + blocks.join("\n\n")`), a marker block is never literally
     the FIRST chunk after splitting on `\n\n` (the header always is) — so "marker is the
     first STATEMENT block" is exactly the marker-is-only-block case above, already
     covered.
   - Marker-block-not-last, i.e. followed by more blocks: covered by the pre-existing
     "one marker block" unit test and by `enum-add-value-and-use`'s fixture replay.
   - **Consecutive marker blocks (two `pre-transaction` statements back to back in one
     migration) — NOT covered by any fixture or unit test.** By code inspection this
     should work correctly (each block is self-contained with no internal blank lines, so
     `\n\n`-splitting cleanly separates them, and only the true last block needs the
     trailing-newline tolerance), but it is untested. WARNING, not CRITICAL — no known
     defect, but a real coverage gap for a plausible real-world shape (e.g. two enum
     `ADD VALUE` changes in one migration).

## Scope Check

`git diff 2e1736a..HEAD --stat` confirms exactly the expected footprint:
```
openspec/changes/add-postgres-integration-tests/{design,proposal,tasks}.md
openspec/changes/add-postgres-integration-tests/specs/{migration-appliability-tests,migration-golden-tests}/spec.md
packages/migrator/package.json
packages/migrator/src/plan.ts                      (+14 -5, the one production fix)
packages/migrator/test/appliability.mjs             (new)
packages/migrator/test/fixtures/enum-add-value-and-use/*  (new)
packages/migrator/test/lib.mjs
packages/migrator/test/migrator.mjs
packages/migrator/test/pg-harness.mjs               (new)
pnpm-lock.yaml
```
No leakage into `crates/`, `packages/core`, `packages/client`, `packages/cli`,
`apps/studio`, or `packages/generator`. Confirmed clean.

## Honesty Constraint

Confirmed: spec (`migration-appliability-tests/spec.md`), design, tasks, and the runner
banner in `appliability.mjs` all use "appliability" as the scope word and explicitly
state concurrency, advisory locking, and connection-pool behaviour are out of scope and
untested. The one place the word "correctness" appears is an explicit negation
("NOT a proof of production correctness under concurrency"), matching the design
document's own chosen phrasing — this is the honest disclaimer, not a claim.

## Issues

### CRITICAL
None.

### WARNING
1. **Consecutive pre-transaction marker blocks are untested.** No fixture or unit test
   exercises two `pre-transaction`-tagged statements in the same migration (e.g. two
   enum `ADD VALUE` changes). Code inspection suggests this works correctly given how
   `renderMigrationSql`/`splitMigrationSql` are structured, but it is unverified. Low
   likelihood, low blast radius (would surface immediately as a real PostgreSQL error on
   first application if broken) — recommend a follow-up fixture, not a blocker for
   archive.

### SUGGESTION
1. Consider documenting, in `plan.ts`'s comment or the design record, the structural
   reason the last-marker-block bug is provably unreachable via execution-only testing
   (as this report's Adversarial Finding #3 demonstrates) — useful context for future
   maintainers debugging a similar "works by luck" class of bug.

## Final Verdict: PASS

No CRITICAL issues. One WARNING (untested consecutive-marker-block shape) does not block
archive; it is a reasonable follow-up. All 27 completed tasks are genuinely reflected in
code and passing tests; task 5.5's deferral to archive is legitimate SDD promotion
practice, not a gap. All four gates pass with live (non-stale) evidence. The production
bug fix is real, minimal, backward-compatible, and empirically regression-tested — I
verified this by actually reverting the fix twice (narrow revert, full-disable revert)
and confirming the expected failures, then restoring the working tree.
