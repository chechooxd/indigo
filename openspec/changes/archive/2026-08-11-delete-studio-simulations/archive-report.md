# Archive Report: delete-studio-simulations

**Date Archived**: 2026-08-11  
**Archived by**: sdd-archive executor  
**Project**: indigo  
**Artifact Store Mode**: hybrid (OpenSpec filesystem + Engram)

---

## Executive Summary

The `delete-studio-simulations` SDD change has been **successfully completed, verified, and archived**. This is the **FIFTH AND FINAL epic of roadmap Phase 0** ("Stop the bleeding"); its completion **closes Phase 0 entirely**. All 40 implementation tasks across four delivery slices (A: Vitest harness, B: Remove fake alerts/counts, C: Real Filter/Sort, D: Disable writes and add sample-data banner) are complete. One verification WARNING identified at verification time was subsequently closed in commit `29abca6` via targeted test additions. The change eliminates ten confirmed UI-honesty defects in `apps/studio`'s data browser by making every visible control either perform a real operation on loaded data or declare itself unavailable.

---

## Phase 0 Closure Statement

With `delete-studio-simulations` archived, the complete Phase 0 roadmap is closed:

1. ✅ `fix-compiler-correctness` — Rust compiler ported and validated
2. ✅ `fix-migrator-correctness` — SQL migration generation fixed
3. ✅ `add-ci-floor` — Baseline CI enforcement in place
4. ✅ `harden-studio-server` — Network exposure vectors closed
5. ✅ `delete-studio-simulations` — UI honesty established

**Roadmap Phase 0 is COMPLETE.** The toolkit now has a verified, honest compiler; correct migrations; controlled deployment risk; hardened server surface; and an honest UI. All five epics shipped. No Phase 0 work remains.

---

## Final State Authority

This report describes the state of the change **at close per explicit final-state facts from the orchestrator** (provided in launch prompt), ranking above intermediate artifacts per `sdd-archive/SKILL.md` Section "Final-State Authority".

**Intermediate artifacts consulted:**
- `verify-report.md` (verification time, 2026-08-10): recorded `pass_with_warnings` (0 CRITICAL, 1 WARNING, 2 SUGGESTION)
- Explicit final-state handoff from orchestrator: WARNING resolved in commit `29abca6`; 2 SUGGESTIONs carry forward as follow-ups; Phase E intent satisfied by verification pass itself (documented deliberate process choice)

---

## Capabilities Added

### New Capability Specs (all NEW, no pre-existing specs in these domains)

| Spec | Type | Location | Requirements |
|------|------|----------|--------------|
| `studio-ui-honesty` | NEW | `openspec/specs/studio-ui-honesty/spec.md` | No fake alerts; filter/sort real operations; true record counts; disabled writes with stated reason; sample-data indicator always visible; pager removed |
| `studio-ui-tests` | NEW | `openspec/specs/studio-ui-tests/spec.md` | Minimal Vitest harness scoped to data browser; each honesty behavior has a fail-before/pass-after test scenario |

Both specs copied mechanically from `openspec/changes/delete-studio-simulations/specs/` to `openspec/specs/` at archive time (diff -r verified identical).

---

## Implementation Summary

### Delivery Model

**Stacked-to-main chain** (nothing pushed, intentional pending user authorization):
- `security/studio-server-bind-and-redaction` (10d95fe, 31b8f37)  
  → `studio/vitest-harness` (51164d8) — Slice A  
  → `studio/remove-fake-alerts-and-counts` (fa4c1e4) — Slice B  
  → `studio/real-filter-and-sort` (6ab90c2) — Slice C  
  → `studio/disable-writes-and-sample-banner` (6946e73, 29abca6) — Slice D + remediation

**Current HEAD**: `studio/disable-writes-and-sample-banner` @ commit `29abca6`

### Ten Confirmed UI-Honesty Defects Fixed

1. ✅ **Fake Refresh alert** — Removed. Refresh now calls `fetchTableRows` when backend is available; disabled with explanatory tooltip when not.
2. ✅ **Fake Filter alert** — Removed. Filter Columns is now a real client-side operation hiding/restoring columns.
3. ✅ **Fake Sort alert** — Removed. Sort Grid replaced with real tri-state (asc/desc/unsorted) header clicks over `visibleColumns`.
4. ✅ **Fake pager buttons** — Removed entirely. Footer now accurately shows "Showing N of N rows" with no false pagination controls.
5. ✅ **Fabricated record count (1,200,000)** — Removed. Browser shows `records.length` (4 for mock users table), consistent with reality.
6. ✅ **12 additional fabricated counts in mockData** — Deleted (1,200,000, 4,500,000, 88,000, etc. literal `recordCount` assignments).
7. ✅ **Fake "Save Changes" behavior** — Disabled. No UI handler, no state mutation, `title` attribute states "Row editing isn't available yet — this build is read-only."
8. ✅ **Fake "Add Record" behavior** — Disabled with explanatory tooltip and no data generation.
9. ✅ **Fake "Create Table" behavior** — Disabled with explanatory tooltip; no fabricated table push to store.
10. ✅ **Silent fallback to mock data** — Fixed. `SampleDataBanner` renders a persistent, non-dismissible warning whenever `!isBackendAvailable()`.

### Task Completion

**40/40 tasks marked complete and code-verified**:
- **Slice A** (A.1–A.6): Vitest harness setup + jsdom smoke test — 6 tasks
- **Slice B** (B.1–B.10): Kill the lies (alerts, pager, fabricated counts) — 10 tasks
- **Slice C** (C.1–C.10): Real Filter Columns + Sort Grid — 10 tasks
- **Slice D** (D.1–D.10): Disable writes + sample-data banner — 10 tasks
- **Phase E** (E.1–E.3): Cross-slice verification — **satisfied by verification pass itself** (explicitly documented as a deliberate process choice in apply-progress, not a skip; all three Phase E intents confirmed during verification)

**Reconciliation rationale for Phase E**: Per orchestrator handoff, Phase E's three verification tasks (full gate run, spec scenario mapping, commit stacking confirmation) were satisfied during the verification pass itself. This is a documented deliberate process choice where verification and final cross-slice confirmation occur in one gate run rather than in a separate Phase E step. All three tasks' intents are verified complete: E.1 (all 5 gates passed fresh), E.2 (6/6 spec scenarios mapped to passing tests), E.3 (all 4 slice commits present and stacked). Marking E.1–E.3 as complete reflects this final state.

### Test Coverage

**First test suite in `apps/studio`** (prior: zero tests):
- **Harness**: Vitest 3 + jsdom + `@testing-library/react` + `@testing-library/user-event`
- **Total test files**: 4
- **Total test cases**: 22 (Slice A: 1 smoke test, Slices B–D: 21 behavioral tests)
- **All cases**: passing (verified via `pnpm --filter @indigodb/studio test`)

**Gate Results** (verified fresh in this session with `--force`):
- `pnpm --filter @indigodb/studio test`: 22/22 passed (4 test files)
- `pnpm build --force`: 10/10 successful
- `pnpm lint --force`: 18/18 successful
- `pnpm test` (root, force): 15/15 Turborepo tasks successful (includes `@indigodb/studio:test`)
- `cd crates && cargo test`: 23 passed

---

## Verification Status

**Intermediate verification (2026-08-10)**:  
Recorded `pass_with_warnings` (0 CRITICAL, 1 WARNING, 2 SUGGESTION).

**Warning Resolution (Orchestrator Confirmed)**:

| Warning | Identified | Issue | Resolution | Commit |
|---------|-----------|-------|-----------|--------|
| **WARNING** — `compareRows` nullish-last sort ordering rule has no test with null/undefined fixtures | verify-report.md | The comparator implements nullish-last ordering (design ADR 5) but no mock table exercised by tests contains any `null` or `undefined` field values — so the documented design decision is implemented but unverified at runtime | Test added: `test(studio): pin nullish-last sort ordering in both directions`. New fixture seeds rows with explicit `null` and `undefined` values mixed with real strings; asserts both sort last in BOTH ascending and descending direction. Passed on first run — confirms it was a coverage gap, not a production defect. | `29abca6` |

**Closed by commit `29abca6`**: Adds one targeted test case covering both sort directions (asc/desc) with nullish values. **No production code changed**; this is a coverage gap closure, not a defect fix. The underlying nullish-last behavior was correct; the gap was in test automation.

---

## Open Suggestions (Carry Forward as Follow-ups)

The two SUGGESTIONs from `verify-report.md` remain open and are appropriate for future work:

1. **Zero-visible-columns edge case (SUGGESTION-1)**: Toggling all columns off via Filter Columns leaves `visibleColumns = []`. Code path appears safe by inspection (no crash, no undefined access; header renders checkbox column only, body cells degrade to checkbox cells per row, empty-state row with `colSpan={visibleColumns.length + 1}` becomes `colSpan={1}`), but no test exercises this exact state. **Recommendation**: low-priority follow-up if filter-all becomes a real user behavior; current risk is low because the grid remains functional and the user can re-toggle a column to restore visibility.

2. **Out-of-scope `alert()` and "simulat*" references remain elsewhere (SUGGESTION-2)**: `alert()` calls and "simulat*" references remain in Studio modules outside this change's scope: `features/dashboard/`, `app/components/Header.tsx`, `features/erd/`, `features/docs/`, `features/studio/query/`. These are confirmed out-of-scope per the proposal's explicit "Scope — Out" section (ERD editor, any Studio area outside the data browser). Not a regression of this change; flagged as a future backlog candidate for whoever tackles those modules next. **Recommendation**: suitable for a separate follow-up epic if comprehensive UI honesty across all Studio areas becomes a priority.

---

## Known Design Decisions

**Documented in design.md and verified in implementation**:

1. **Vitest rides existing `vite.config.ts`** — Single source of truth for `@` alias and WASM `optimizeDeps.exclude` rule. No separate `vitest.config.ts`.
2. **`recordCount` field removed from `Table` type** — Field existed only to hold a number nothing measured. Now `records.length` is the single rule.
3. **Disabled + native `title` attribute** — Simpler than `@base-ui` Tooltip for disabled controls; `toHaveAttribute` assertions are stable under jsdom.
4. **Filter/Sort view-state in `useTableData`** — Centralized with existing `isStructureView` and `activeTableIndex` state; resets per table.
5. **`.slice()` before `.sort()`** — **Load-bearing correctness requirement**: when `recordSearchQuery` is empty, memo returns `activeTable.records` by reference; in-place `.sort()` would mutate Zustand state. Copy is mandatory, not stylistic. Dedicated test `useTableData.test.tsx > does not mutate the store's array when sorting` validates this.
6. **Sample-data banner non-dismissible** — Dismissal would reintroduce silent-fake state; persistent warning is the only honest default.
7. **Refresh disabled+title when no backend** — Consistent with write-action treatment; tooltip states reason rather than silently deleting a real capability.

---

## Scope Verification

**Implementation stayed within declared scope:**
- Modified: `apps/studio/{vite.config.ts, package.json, src/test/setup.ts, src/types.ts, src/store/useDataStore.ts, src/data/mockData.ts, src/lib/schema-adapter.ts, src/features/studio/browser/{TableBrowserPage.tsx, components/*, hooks/*}}`
- Created: `apps/studio/src/features/studio/browser/components/SampleDataBanner.tsx`, `apps/studio/src/features/studio/browser/__tests__/*.test.tsx`, `apps/studio/src/test/setup.ts`
- Modified (planning artifacts): `openspec/changes/delete-studio-simulations/**`
- Modified (lockfile): `pnpm-lock.yaml` (new devDeps: vitest, jsdom, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom)

**Out-of-scope items (separate changes):**
- `packages/cli`, `packages/core`, `packages/client`, `packages/migrator`, `crates/` — unchanged
- Studio areas outside data browser (ERD editor, docs browser, dashboard, query console) — intentionally excluded per proposal scope; any `alert()` or `simulat*` references there remain for separate future work

---

## Archive Contents

All artifacts moved from `openspec/changes/delete-studio-simulations/` to `openspec/changes/archive/2026-08-11-delete-studio-simulations/`:

- ✅ `proposal.md` — Intent, scope, approach, risk/rollback, success criteria
- ✅ `design.md` — Technical decisions, data flow, file changes, testing strategy
- ✅ `tasks.md` — 40 implementation tasks (all marked [x]), four slices (A–D), delivery model, review budget
- ✅ `verify-report.md` — 0 CRITICAL, 1 WARNING (resolved), 2 SUGGESTION (carry-forward)
- ✅ `specs/studio-ui-honesty/spec.md` — NEW capability: honesty rules for Studio data browser
- ✅ `specs/studio-ui-tests/spec.md` — NEW capability: Vitest harness and test scenarios

**Main specs updated:**
- Created `openspec/specs/studio-ui-honesty/spec.md` (NEW)
- Created `openspec/specs/studio-ui-tests/spec.md` (NEW)

---

## Cycle Completion

- **Proposal**: ✅ Delivered, refined during execution
- **Specification**: ✅ Two NEW capabilities defined and archived
- **Design**: ✅ Implementation approach with decision rationale and constraints
- **Tasks**: ✅ 40/40 complete (including Phase E reconciliation per deliberate process choice), four-slice stacked delivery
- **Implementation**: ✅ Stacked commits A (51164d8) → B (fa4c1e4) → C (6ab90c2) → D (6946e73) → remediation (29abca6)
- **Verification**: ✅ All gates green, one intermediate warning resolved, two forward-carry suggestions
- **Archive**: ✅ SDD cycle closed, specifications merged into main, change folder archived

**This change is ready for user review and authorization to push/merge.**

---

## Key Learnings

1. Test-coverage gaps for implemented design decisions (nullish-sort ordering) can be identified and rapidly remedied post-apply via targeted additions to existing test suites; no revert needed.
2. Filter/Sort as client-side operations over a copied array (`.slice()` before `.sort()`) provides both correctness and simplicity; mutation guards (reference-equality assertions) are essential to catch silent state corruption.
3. A non-dismissible persistent sample-data banner is the minimal honest UI for fallback-to-mock scenarios; dismissibility reintroduces the silent lie the design rejects.
4. Vitest + jsdom + `@testing-library/react` can be retrofitted into an existing Vite + React 19 + Tailwind v4 app with zero separate configuration by using a shared `vite.config.ts` test block; this single-sourcing prevents alias/WASM-exclude drift.
5. Disabled controls with native `title` attributes are simpler than rich UI tooltips for jsdom testing; assertions via `toHaveAttribute` remain stable and assertions on `disabled` are deterministic.
