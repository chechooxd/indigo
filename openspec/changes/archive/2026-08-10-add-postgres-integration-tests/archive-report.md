# Archive Report: add-postgres-integration-tests

**Change**: `add-postgres-integration-tests`  
**Archived**: 2026-08-10  
**Status**: PASS, archive complete  
**Final Gate State**: All 28/28 tasks complete; pnpm build, pnpm lint, cargo test, pnpm test all green

---

## Executive Summary

This change successfully closed the gap left by the migrator's golden-text tests by executing emitted DDL against a real PostgreSQL engine (PGlite). On its first run, the suite uncovered and pinned a real production bug in `splitMigrationSql`: pre-transaction marker blocks misclassified when they were the LAST block in the rendered file, causing `ALTER TYPE ... ADD VALUE` statements to execute inside the migration transaction when they should run before it. The bug existed in shipped code and was undetectable by text-based goldens. Fixed with a minimal, backward-compatible change (`packages/migrator/src/plan.ts`), plus a regression unit test. All 21 golden fixtures plus the new appliability suite are now green.

---

## Headline Result: Real Production Bug Found

**The Bug**: `packages/migrator/src/plan.ts`'s `splitMigrationSql()` function failed to recognize a pre-transaction marker block when it was the LAST block in the rendered migration file.

**Symptom**: When a migration's only (or final) change is an enum `ADD VALUE`, the function would misclassify the marker block because `renderMigrationSql`'s single trailing `\n` survives the `\n\n`-split, placing that newline inside the marker block and breaking the shape check for `lines[lines.length-1] === NO_TRANSACTION_END`. Result: the statement silently executed INSIDE the migration transaction instead of before it — the exact defect that `fix-migrator-correctness` had already fixed for other shapes.

**Why It Was Undetected**: Text-based golden fixtures correctly recorded `phase: "pre-transaction"` in their JSON output, so the golden suite passed without ever executing the SQL. Only running the DDL against a real PostgreSQL engine could detect the discrepancy between recorded phase and actual execution context.

**Blast Radius**: Any migration whose ONLY or LAST change is an enum `ADD VALUE`. The statement happened to succeed for existing fixtures only because nothing in the same migration consumed the new enum value — the moment something does, PostgreSQL rejects with `unsafe use of new value "..."`. This is a latent defect that could corrupt user databases on a routine schema migration.

**Fix**: Minimal change to `plan.ts` (14 lines added, 5 removed) tolerating one trailing blank line in marker-shape detection. The original block content is unaffected, so unmarked-block output remains byte-identical and both pre-existing unit tests pass unchanged. New unit test added: "marker block is the LAST block...".

**Evidence of Detection Power**: 
- Reverting the fix to `plan.ts` causes the new unit test to fail.
- Reverting the fix also causes `appliability.mjs`'s round-trip invariant to fail for both `enum-add-value` and `enum-value-mapped` (the two fixtures whose marker block is their only/last block).
- Disabling marker detection entirely (`isMarked = false`) causes the regression pair test ("enum ADD VALUE stays split...") to fail with a live PostgreSQL error: `unsafe use of new value "B" of enum type "S"`.

---

## Verification Status

Per `verify-report.md` (observation snapshot at verification time):
- **PASS**: All 4 gates (build, lint, cargo test, pnpm test) green with live (non-stale) evidence
- **Verdict**: PASS, no CRITICAL issues
- **WARNING (SINCE RESOLVED)**: "Consecutive pre-transaction marker blocks are untested" — No fixture or unit test covers two `pre-transaction`-tagged statements in the same migration (e.g. two enum `ADD VALUE` changes). Code inspection suggested correct behaviour but was unverified.

  **Resolution**: The orchestrator reproduced the case directly and confirmed `splitMigrationSql` already recovers both blocks correctly. Pinned with a new fixture `enum-add-values-consecutive` in commit `cb86f2c`. Regenerating the golden moved no other fixtures. The fixture now appears in the full suite and is green.

- **SUGGESTION (REMAINS OPEN FOR FUTURE WORK)**: "Consider documenting, in `plan.ts`'s comment or the design record, the structural reason the last-marker-block bug is provably unreachable via execution-only testing" — useful context for future maintainers debugging a similar "works by luck" class of bug. Carry forward as a design follow-up, not a blocker.

**Final Test Results** (post-cb86f2c):
- `pnpm build`: 10/10 tasks successful
- `pnpm lint`: 18/18 tasks successful, all `tsc --noEmit`
- `cargo test`: 23 tests passed
- `pnpm test`: 13 Turbo tasks green, including 22 migrator golden fixtures + the PGlite appliability suite (21 fixtures × 3 checks: apply/refuse, round-trip invariant, pushSql idempotency) + 2 regression pairs + harness self-test + fixture isolation

**Task Completion**: 28/28 tasks complete. Task 5.5 (spec delta promotion) was legitimately deferred to this archive phase and is now complete.

---

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| `migration-appliability-tests` | Created | New capability: 8 requirements covering fixture replay, refusal assertions, phase separation, idempotency, regressions, isolation, wiring, and scope honesty. |
| `migration-golden-tests` | Modified | Narrowed requirement 7: old text "Golden fixtures pin generated text, **not applicability**... No PostgreSQL instance runs in this suite" is now "Golden fixtures pin generated text, **applicability is proven separately** ... [cross-references migration-appliability-tests]". Scenario also refined to clarify the split responsibility. |

Mechanical verification: `diff` of source change spec against destination `openspec/specs/` confirms byte-identity for all promoted files.

---

## Known Limitations (Honest Framing)

These limits must be stated in the spec and design, not buried, for future maintainers:

1. **PGlite is single-connection / single-user**: Concurrent deploys, advisory locking, and connection-pool behaviour remain genuinely untestable in this suite. If production concurrency testing ever becomes a real need, `testcontainers` is the named option.

2. **Appliability ≠ Correctness Under Production Load**: This suite proves "the emitted SQL executes without error against a single-connection PostgreSQL engine", NOT "the system behaves correctly under concurrent access". The suite and spec use "appliability" to mark this scope boundary explicitly; every mention of "correctness" in the codebase is paired with a negation ("NOT a proof of production correctness").

3. **WASM Version Lag**: PGlite is a WASM build of PostgreSQL 18.3. Server-specific features or version-specific behaviours that diverge between PGlite and a given production PostgreSQL version remain untested. Measured during exploration: PGlite rejects every DDL shape the migrator emits correctly and reproduced both historical bugs with their exact errors, so it has proven regression detection power for the migrator's scope, but it is not a perfect replica of every production deployment.

---

## Archive Contents Verified

- [x] `proposal.md` ✅
- [x] `design.md` ✅
- [x] `specs/migration-appliability-tests/spec.md` ✅ (promoted to `openspec/specs/`)
- [x] `specs/migration-golden-tests/spec.md` ✅ (delta applied to main spec)
- [x] `tasks.md` (28/28 complete) ✅
- [x] All 21 golden fixtures + new fixture `enum-add-values-consecutive` ✅
- [x] `archive-report.md` (this file) ✅

Source change folder moved from `openspec/changes/add-postgres-integration-tests` to `openspec/changes/archive/2026-08-10-add-postgres-integration-tests` with successful mechanical verification (empty diff).

---

## Follow-Up Items

### Open Suggestion (document structural reason for last-marker-block test limitation)
The last-marker-block bug in `splitMigrationSql` is provably unreachable via execution-only testing (because it only manifests when nothing in the same migration consumes the value; the moment something does, the marker block is no longer last). The round-trip invariant catches it structurally. Document this edge-case reasoning in `plan.ts` or the design record for future maintainers. Not urgent; low priority learning artifact.

---

## Final State Summary

**Cycle Complete**: The change has been fully planned, implemented, verified, and archived. Specs now reflect the new capability; production code is corrected and regression-tested; the warning (consecutive marker blocks) has been confirmed fixed; the suggestion (document structural limitation) is recorded for future work.

**Next Step**: None required. Archive is complete.
