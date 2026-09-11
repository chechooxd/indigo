# Archive Report: client-log-redaction

**Date**: 2026-09-11  
**Change**: client-log-redaction  
**Status**: ARCHIVED  
**Archive Location**: `openspec/changes/archive/2026-09-11-client-log-redaction/`

---

## Executive Summary

The `client-log-redaction` change has been fully implemented, verified (pass verdict), and archived. All 20 implementation tasks completed. Specification merged successfully into canonical `openspec/specs/client-query-extensions/spec.md`, maintaining exactly 6 requirements with one requirement modified to mandate parameter redaction. No CRITICAL issues detected. Change is ready for delivery.

---

## Requirement Count Verification (Critical Gate)

### Before Merge
The canonical `openspec/specs/client-query-extensions/spec.md` contained exactly **6 requirements**:

1. QueryExtension type and constructor-only registration (line 13)
2. Extension composition order and wrapLog placement (line 32)
3. Extensions may mutate sql/params or short-circuit (line 61)
4. Extension coverage on all executor paths, including transactions (line 79)
5. Per-query context via AsyncLocalStorage (line 104)
6. Error propagation is unwrapped (line 131)

### After Merge
The merged canonical spec contains exactly **6 requirements** (no change in count):

1. QueryExtension type and constructor-only registration (line 13) — UNCHANGED
2. Extension composition order and wrapLog placement (line 32) — **MODIFIED**
3. Extensions may mutate sql/params or short-circuit (line 92) — UNCHANGED
4. Extension coverage on all executor paths, including transactions (line 110) — UNCHANGED
5. Per-query context via AsyncLocalStorage (line 135) — UNCHANGED
6. Error propagation is unwrapped (line 162) — UNCHANGED

**Requirement count preserved**: 6 = 6 ✓

### MODIFIED Requirement: Verification

The requirement "Extension composition order and wrapLog placement" was modified as follows:

**Key new language added:**
- `wrapLog`'s `log: boolean` behavior now logs "one redacted positional placeholder per bound parameter (e.g. `$1=<redacted>, $2=<redacted>`), in call order"
- **CRITICAL**: `wrapLog` MUST NOT emit any bound parameter's runtime value under any circumstance, and no configuration option MAY restore raw value logging`
- Explanation of the change from prior behavior ("Previously: required logging ... which included raw parameter values")

**Scenario changes within this requirement:**
- "Extensions run in declared order" (unchanged)
- "wrapLog logs the SQL each extension actually forwards" (unchanged)
- "Absent extensions leaves composition overhead unchanged" (REWRITTEN) — now explicitly scopes "unchanged" to composition overhead only, not log payload; states: "it is NOT the pre-capability raw-value behavior"
- "Bound parameter values never appear in captured stdout" (NEW)
- "Redacted placeholders preserve arity and position" (NEW)
- "Redaction holds when an extension rewrites params" (NEW)

**No requirement** in the merged file still states "logging the exact SQL/params actually sent, with zero behavior change from today" that included raw parameter values. The old requirement has been superseded by the new redaction mandate. ✓

---

## Spec Merge Details

**Native Composition Command**: Invoked `gentle-ai sdd-archive-compose` (exit code 0)

```bash
gentle-ai sdd-archive-compose \
  --canonical "openspec/specs/client-query-extensions/spec.md" \
  --delta "openspec/changes/client-log-redaction/specs/client-query-extensions/spec.md" \
  --output "openspec/specs/client-query-extensions/spec.md.compose-tmp"
```

**Result**: Composition succeeded without error. The MODIFIED requirement's title "Extension composition order and wrapLog placement" was matched exactly between canonical and delta, triggering a MODIFIED (replace) operation rather than adding a new requirement. All unrelated requirements remained byte-for-byte unchanged.

**Merge verification**: Verbatim `diff -r` output between pre-move snapshot and archived directory shows **empty diff** (no differences), confirming mechanical copy integrity. ✓

---

## Implementation Summary

### Code Changes (per verify-report)

- **`packages/client/src/client.ts`**: 
  - Added module-scope function `redactParams(params: unknown[]): string` (lines 85–88)
  - Modified `wrapLog` to call `console.log("[indigodb]", sql, redactParams(params))` instead of including raw params
  - Updated doc comments at 3 sites to reflect redaction behavior
  - Base executor still receives real parameter values (unmodified `return run(sql, params)` at line 274)

- **`packages/client/test/extensions.mjs`**: 
  - Added 7 new test cases (additive only, no modifications to existing `:98–115` case)
  - All test cases carry the sentinel `hunter2-SENTINEL` or recognizable array values to verify redaction
  - Pre-existing empty-params case (`:98–115`) remains untouched, proving it never relied on parameter logging

### Verification Verdict: PASS

Per `verify-report.md`:
- **Build**: PASS (11/11 build tasks, 21/21 lint tasks, exit 0)
- **Tests**: PASS (20/20 Turbo test tasks; 27/27 checks in `extensions.mjs` standalone)
- **Coverage**: Not available — no coverage tool in this repo
- **Spec compliance**: 6/6 scenarios compliant
- **Requirements**: 1/1 (the MODIFIED requirement)
- **Test exit code**: 0
- **Critical findings**: 0
- **Blockers**: 0

### Mutation Proof (Two-Sided, Independently Reproduced)

Per verify-report, reverting `wrapLog` to `console.log("[indigodb]", sql, params)`:
- **Rows 1, 3, 5** (redaction-asserting scenarios): **RED** on sentinel-membership assertion, naming the leaked value exactly
- **Rows 2, 4, 6, 7** (shape/absence tests): stayed GREEN or flipped RED for their own distinct reasons, proving they test separate concerns (logging suppression and executor boundary), not redaction
- Restoration of `redactParams` restored all 27 cases to GREEN

This independently reproduced the mutation proof. ✓

---

## Archive Verification Checklist

- [x] Main specs updated correctly (canonical spec merged; requirement count preserved at 6; redaction mandate present)
- [x] Change folder moved to archive (`openspec/changes/archive/2026-09-11-client-log-redaction/`)
- [x] Archive contains all artifacts:
  - [x] proposal.md
  - [x] specs/client-query-extensions/spec.md
  - [x] design.md
  - [x] tasks.md (all 20 tasks marked complete with [x])
  - [x] verify-report.md
- [x] Archived tasks.md has no unchecked implementation tasks (all 20 complete)
- [x] Active changes directory no longer contains client-log-redaction
- [x] Verbatim `diff -r` readback output is empty (no differences) — mechanical copy integrity confirmed ✓

---

## Specification Contradiction Resolution

The canonical spec previously ratified the information leak in two places:
1. Requirement body (old wording): "logging the exact SQL/params actually sent, with zero behavior change from today"
2. "Absent extensions" scenario (old wording): "behavior (including `log`) MUST be identical to the client before this capability existed"

The delta's rewritten requirement:
- Replaces the ambiguous "exact SQL/params" with explicit redaction mandate: `$1=<redacted>, $2=<redacted>`
- Explicitly forbids raw value logging in any configuration
- Rewrites the "Absent extensions" scenario to narrow "unchanged" to composition overhead only, negating the pre-capability-behavior lock: "it is NOT the pre-capability raw-value behavior"

The pre-existing test at `:98–115` (`wrapLog logs the SQL each extension actually forwards`) only ever asserted call order and return-value identity, never log payload, so it required no rewrite to remain compatible with the new scenario text. This confirms the contradiction has been genuinely resolved, not papered over.

---

## Key Learnings for Future Changes

1. **Canonical spec contradiction identification**: This change fixed a defect where the specification itself ratified the buggy behavior in multiple places — both the requirement body and a scenario. When fixing long-standing behavior, check both the requirement text and any scenarios that may have locked in the defective contract.

2. **Empty-params fixtures hide untestable branches**: The pre-existing test used an empty params array (`[]`), which could never exercise the redaction branch. Reviewing old fixtures during new work catches why certain mutation-sensitive code paths were never tested.

3. **Two-sided mutation proof with falsifiable scenarios**: Every new scenario uses a recognizable sentinel (`hunter2-SENTINEL`) or multi-value array, ensuring that reverting the implementation produces clear, named failures (not `TypeError`s) that prove the test actually exercises the intended behavior.

4. **Merge-by-title requirement matching**: This repo's spec merge strategy relies on exact requirement title matches. A delta that expresses a MODIFIED requirement under a *new* title would be read as an addition, leaving the old requirement (with contradictory old text) untouched alongside it. This risk is mitigated by confirming requirement counts before and after merge.

---

## Defer-to-Follow-up Issues

These are out of scope for this change but warrant logging:

1. **PGlite adapter's missing rollback diagnostic** (`packages/client/src/adapters/pglite.ts`): Logs nothing where `pg.ts:88` logs errors on rollback failure. A real asymmetry, but a *missing* log rather than a leaking one. Consider for observability improvements.

2. **Structured logging, tracing, and metrics**: This redaction fix is localized to `console.log`. Broader observability infrastructure (structured logs, metrics, tracing) would benefit from a separate feature epic that this defect revealed.

---

## Artifact Locations

**Archived change folder**: `openspec/changes/archive/2026-09-11-client-log-redaction/`
- proposal.md
- specs/client-query-extensions/spec.md (delta, archived for audit trail)
- design.md
- tasks.md
- verify-report.md

**Canonical spec (merged)**: `openspec/specs/client-query-extensions/spec.md`

**Archive report**: 
- Filesystem: `openspec/changes/archive/2026-09-11-client-log-redaction/archive-report.md`
- Engram: `sdd/client-log-redaction/archive-report`

---

## Final Audit Trail

- **Change name**: client-log-redaction
- **Branch**: client-log-redaction
- **Commits**: 2 (07e18c9, 528faac); tree clean apart from untracked verify-report.md
- **Tasks completed**: 20/20
- **Verification verdict**: pass
- **Specification requirements**: 6 (1 MODIFIED, 5 UNCHANGED; count preserved)
- **Scenarios**: 6 (within the 1 MODIFIED requirement)
- **Archive date**: 2026-09-11
- **Archived by**: SDD archive phase (sdd-archive)

---

## Status: ARCHIVED ✓

This change is fully archived and ready for delivery. All artifacts are in the archive folder, the canonical specification has been updated, and no CRITICAL issues remain.

The shipped behavior: `wrapLog` now emits `console.log("[indigodb]", sql, redactParams(params))`, where `redactParams` discards parameter values and emits only positional placeholders (`$1=<redacted>`, etc.) or `(0 params)` for empty arrays. The base executor still receives real parameter values — redaction is a logging concern only.
