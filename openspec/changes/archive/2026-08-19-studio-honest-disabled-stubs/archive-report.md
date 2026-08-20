# Archive Report: studio-honest-disabled-stubs

**Change**: `studio-honest-disabled-stubs`
**Archived**: 2026-08-19
**Archived to**: `openspec/changes/archive/2026-08-19-studio-honest-disabled-stubs/`

## Cycle Overview

This change removes simulated/fake UI controls from three Studio surfaces (dashboard, query engine, ERD designer) by replacing alert()-based stubs with honest disabled states, following the pattern established by the prior `studio-ui-honesty` change which scoped itself too narrowly to the data browser alone.

**Related Audit Findings**: This change closes 3 code-audit findings from 2026-08-18 related to Studio still shipping simulated/fake UI controls after the earlier `studio-ui-honesty` cleanup. Root cause of those findings: the earlier cleanup's spec scoped itself too narrowly to `features/studio/browser/` only. This change corrects the scope boundary going forward, widening `studio-ui-honesty` and `studio-ui-tests` specs to cover all Studio surfaces.

## Artifact Traceability

All artifacts retrieved from Engram (project: indigo):

| Artifact | Observation ID | Type | Status |
|----------|---|---|---|
| Proposal | #627 | architecture | Retrieved, merged into archive |
| Spec (delta) | #631 | architecture | Retrieved, merged into main specs |
| Design | #633 | architecture | Retrieved, merged into archive |
| Tasks | #636 | architecture | Retrieved, all 17/17 complete |
| Verify Report | #641 | architecture | Retrieved, PASS WITH WARNINGS |

## Task Completion Status

**All tasks complete** per `openspec/changes/archive/2026-08-19-studio-honest-disabled-stubs/tasks.md`:
- 17/17 checkboxes marked `[x]`
- No unchecked implementation tasks
- All verification gates passed

### Task Sections (Summary)

1. **Dashboard honesty** (openCli / viewAllSchemas) — COMPLETE
   - Removed alert() handlers
   - Wired disabled state + honest tooltip
   - Tests passing

2. **Schema Browser refresh gating** — COMPLETE
   - Extracted `lib/schema-loader.ts` with shared refetch logic
   - Delegated `useSchemaBootstrap.ts` to use shared loader
   - QueryEnginePage passes `canRefresh={isBackendAvailable()}` + `onRefresh` callback
   - SchemaBrowserPanel honors gating with disabled state + tooltip
   - Tests passing

3. **ERD Designer honesty** (History disabled + Copy feedback) — COMPLETE
   - Extracted DslEditorToolbar.tsx
   - History control honestly disabled with tooltip
   - Copy-to-clipboard shows transient "Copied" state, no alert()
   - Translated 3 Spanish layout-toggle titles to English
   - Tests passing

4. **Verification** — COMPLETE
   - `pnpm test`: 8 test files, 31 tests, ALL PASS
   - `pnpm build`: 10/10 Turbo tasks pass
   - `pnpm lint`: 18/18 Turbo tasks pass
   - Zero `alert()` remaining in touched code
   - Zero Spanish diacritics in fixed paths

## Specification Merge

### studio-ui-honesty

**Delta Applied**: MODIFIED Purpose + ADDED 3 requirements with 6 scenarios

**Changes**:
- **Purpose** widened from "data browser only" (`apps/studio/src/features/studio/browser/`) to "all Studio surfaces" (dashboard, query engine, ERD designer, data browser, docs)
- **Added Requirement**: "Unimplemented controls outside the data browser are disabled with a stated reason" (3 scenarios: Open CLI, Schema browser refresh, ERD History)
- **Added Requirement**: "View all schemas" is disabled honestly when no dedicated destination exists (1 scenario)
- **Added Requirement**: Copy-to-clipboard actions give inline, non-blocking feedback (2 scenarios)

**Source of Truth Updated**: `openspec/specs/studio-ui-honesty/spec.md` now reflects the widened scope and new requirements. All original 6 requirements preserved; 3 new requirements + 6 scenarios appended.

### studio-ui-tests

**Delta Applied**: MODIFIED Purpose + MODIFIED 2 requirements with new scenarios

**Changes**:
- **Purpose** updated to clarify harness covers all Studio surfaces, not just data browser
- **Modified Requirement 1**: Expanded scope to include dashboard, query engine, and ERD designer (not just data-browser). Retained explicit boundary: "MUST NOT be used to justify a general component-testing rollout across other Studio areas (docs browser, settings, etc.) beyond these named targets in this change."
- **Modified Requirement 2**: Updated to reference new requirement additions from studio-ui-honesty
- **Added Scenarios**: 3 new scenarios (Dashboard actions test, Schema browser refresh test, ERD History+copy-feedback tests) appended to the 6 inherited scenarios

**Source of Truth Updated**: `openspec/specs/studio-ui-tests/spec.md` now specifies testing for all four new honest-disabled targets plus the original data-browser scenarios.

## Verification Summary

**Status**: PASS WITH WARNINGS (0 CRITICAL, 1 WARNING, 1 SUGGESTION)

Per `verify-report` (#641) executed 2026-08-19 18:32:58:

### Critical Issues
None.

### Warnings

**WARNING (Process / Governance)**:
- **Item**: SchemaBrowserPanel refresh gating (isBackendAvailable()) reverses a spec-phase note marked "fixed by user, not open questions" without being escalated as a design open question.
- **Context**: The spec artifact's Resolved Scope (Engram #631, point 3) explicitly stated that Schema Browser refresh should be "unconditional, non-gated" disable — "gating on isBackendAvailable() would falsely imply it works when a backend IS connected." However, during design (Engram #633, decision 3), the implementation discovered that a real refetch path already exists and chose to gate the disable on `isBackendAvailable()`, making it a functional but gated refresh instead. Unlike the Spanish-string deviation (which design correctly flagged as an Open Question), this reversal was **not** escalated for reconfirmation.
- **Shipped Behavior**: The literal spec scenario text in the archived `studio-ui-honesty/spec.md` (Engram #631) is scenario-only and gating-agnostic, so the requirement text is technically satisfied either way. The shipped behavior (gated real refresh) is arguably more honest than a permanent disable of a control that does work.
- **Severity**: Process/governance (unescalated design reversal), **NOT** functional. The control is not dishonest, and the scenario text does not require permanent disable.
- **Determination**: ACKNOWLEDGED, NOT BLOCKING. Archive proceeds. The user authorized latitude in the design-phase prompt to gate on real backend availability instead of permanently disabling; this was an explicitly authorized latitude, not an unauthorized reversal.

### Suggestions

**SUGGESTION**:
- Commit proposal.md, design.md, and specs/ for this change so the working tree is clean ahead of archive. (COMPLETED in commit 3fbae6b, 2026-08-19)

## Implementation Compliance

All source-level checks PASS per verify-report (#641) fresh command runs:

| Item | Result | Evidence |
|------|--------|----------|
| No alert() in honesty paths | PASS | Zero `alert(` in useDashboardActions.ts, DashboardPage.tsx, WelcomeHero.tsx, RecentSchemasTable.tsx, QueryEnginePage.tsx, SchemaBrowserPanel.tsx, ERDDesignerPage.tsx |
| Disabled controls + honest tooltips | PASS | CLI_DISABLED_TITLE, VIEW_ALL_DISABLED_TITLE, REFRESH_DISABLED_TITLE, HISTORY_DISABLED_TITLE constants wired; buttons disabled with title attributes |
| Copy feedback inline, not alert() | PASS | DslEditorToolbar.tsx implements transient "Copied" state (1500ms revert via useEffect cleanup); no alert() anywhere |
| Spanish strings translated | PASS | ERDDesignerPage.tsx layout-toggle titles (Editor only, Split view, Canvas only); grep for diacritics across 10 touched files returned zero |
| Tests exist and pass | PASS | 3 new test suites (DashboardPage.test.tsx, SchemaBrowserPanel.test.tsx, DslEditorToolbar.test.tsx); `pnpm --filter @indigodb/studio test` reports 31 total tests, ALL PASS |
| Build + Lint green | PASS | `pnpm build` (10/10 tasks), `pnpm lint` (18/18 tasks) |

## Final State

**Proposal**: Full artifact preserved in archive (`proposal.md`)
**Design**: Full artifact preserved in archive (`design.md`)
**Specs**: Delta specs merged into main specs; full repo specs saved in archive (`specs/`)
**Tasks**: All 17 tasks complete; copy in archive (`tasks.md`)
**Verification**: Full report in archive (`verify-report.md`)

**Archive Folder**: `openspec/changes/archive/2026-08-19-studio-honest-disabled-stubs/`
**Commit**: 3fbae6b (chore: persist studio-honest-disabled-stubs artifacts)

## Key Facts

1. **No CRITICAL issues**: Archive proceeds without blocking gates.
2. **WARNING is process-only**: The gating decision reversal (refresh on real backend vs. permanent disable) is acknowledged. It was an explicitly authorized design latitude, not an unauthorized change. The shipped behavior is functionally honest.
3. **Spec scope corrected**: The root cause of the 3 code-audit findings was the earlier `studio-ui-honesty` spec scoping itself too narrowly. This change widens the spec boundary to cover all Studio surfaces going forward.
4. **All requirements met**: Per spec artifact and verify-report, all ADDED/MODIFIED requirements satisfied by code + tests.
5. **Delta specs fully merged**: studio-ui-honesty Purpose + 3 new requirements; studio-ui-tests Purpose + 2 modified requirements + new scenarios all integrated into main specs.

## SDD Cycle Status

**COMPLETE**: The change has been fully planned (proposal), specified (delta specs merged), designed, implemented (commit 4ee50af), verified (PASS WITH WARNINGS), and now archived (2026-08-19).

Ready for the next change.
