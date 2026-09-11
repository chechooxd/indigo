# Apply Progress: studio-docs-honesty

Last updated: 2026-09-11T20:53:59Z
Mode: Strict TDD
Scope of this run: Work Unit 1 only (tasks 1.1-1.5). WU2 (tasks 2.1-2.5) not started.

## Status

23/24 WU1 sub-tasks complete. Task 1.5.4 (commit) is intentionally left unchecked and
**deferred to the orchestrator**: per the run contract, a native review must run on the
uncommitted working tree before any commit. All WU1 changes are present in the working
tree, uncommitted.

## Completed Tasks (WU1)

- [x] 1.1.1-1.1.4 RED — `useCopyFeedback.test.tsx` (4 tests) written against a
  not-yet-existing hook.
- [x] 1.1.5 GREEN — `useCopyFeedback.ts` created (ported verbatim from
  `DslEditorToolbar.tsx:32-50`).
- [x] 1.1.6 — all 4 hook tests pass.
- [x] 1.1.7 REFACTOR checkpoint — hook has no leftover ERD naming, matches design's
  Interfaces/Contracts exactly.
- [x] 1.2.1 Baseline: `DslEditorToolbar.test.tsx` 7/7 green before edit.
- [x] 1.2.2 `DslEditorToolbar.tsx` rewired onto `useCopyFeedback()`.
- [x] 1.2.3 Checkpoint: `DslEditorToolbar.test.tsx` unedited (`git diff --exit-code` clean)
  and still 7/7 green.
- [x] 1.3.1 `DocBrowserPage.test.tsx` scaffold with hand-built tables `A`
  (`records.length === 3`) and `B` (`records: []`).
- [x] 1.3.2-1.3.4 RED — three Copy Schema tests written and run against the pre-existing
  `alert()`-based `copyDDL`; all three failed as expected (see RED evidence below).
- [x] 1.3.5-1.3.7 GREEN — `DdlPanel.tsx` (`{ ddlCode }` only, calls `useCopyFeedback()`
  directly, conditional "Copy Schema"/"Copied" label), `DocBrowserPage.tsx` (added
  `key={activeTable.name}`, dropped `onCopy`), `useDocBrowser.ts` (`copyDDL` deleted from
  body, interface, and return object; `shareReference`/`queryTable` untouched).
- [x] 1.3.8 — all three Copy Schema tests pass (GREEN).
- [x] 1.4.1-1.4.3 Mutation proofs — all three bite (evidence below), each reverted after
  confirmation.
- [x] 1.5.1-1.5.3 Verification — `pnpm --filter @indigodb/studio test`, `pnpm lint`,
  `pnpm build` all exit 0.
- [ ] 1.5.4 Commit — **deferred to orchestrator (post-review commit)**.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `shared/hooks/__tests__/useCopyFeedback.test.tsx` | Unit (hook) | N/A (new) | ✅ Written — 4 tests, missing-module import error | ✅ Passed — 4/4 | ✅ 4 cases (success, re-click, unmount, reject) | ✅ Clean, matches design contract |
| 1.2 | `features/erd/__tests__/DslEditorToolbar.test.tsx` (approval test, unedited) | Component | ✅ 7/7 baseline | N/A — approval test, no new RED | ✅ 7/7 after rewire | ➖ N/A (regression proof only) | ➖ None needed |
| 1.3 | `features/docs/__tests__/DocBrowserPage.test.tsx` | Component | N/A (new file) | ✅ Written — 3 tests, all red against `alert()`-based `copyDDL` | ✅ Passed — 3/3 | ✅ 3 cases (success, reject, table-switch) | ➖ None needed |

### Test Summary
- **Total tests written**: 4 (hook) + 3 (DocBrowserPage Copy Schema) = 7 new
- **Total tests passing**: 7 new + 7 unedited `DslEditorToolbar.test.tsx` = 14 (WU1 scope);
  full suite 274/274
- **Layers used**: Unit/hook (4), Component/jsdom (10)
- **Approval tests** (refactoring): 1 — `DslEditorToolbar.test.tsx`, unedited, still green
  after the extraction
- **Pure functions created**: 0 (the hook is stateful by design; `copy` itself has no pure
  extraction opportunity per design's Interfaces/Contracts)

## RED Evidence (exact observed failures)

- **1.1.1-1.1.4** (`useCopyFeedback.test.tsx`, run before the hook file existed): all 4
  tests failed at collection with `Error: Failed to resolve import "../useCopyFeedback" from
  "src/shared/hooks/__tests__/useCopyFeedback.test.tsx". Does the file exist?` — a
  module-resolution failure common to all four tests in the file, confirming each depends on
  the not-yet-created production module.
- **1.3.2** (`writes the exact DDL, shows inline "Copied", never alerts, and clears`): failed
  with `Unable to find an accessible element with the role "button" and name "Copied"` — the
  pre-change `DdlPanel` has a fixed "Copy Schema" label and never renders a "Copied" state (it
  relied on `useDocBrowser`'s `copyDDL`, which calls `alert(...)` instead).
- **1.3.3** (`rejected clipboard write shows no dialog and no false confirmation`): failed
  with `AssertionError: expected "bound " to not be called at all, but actually been called 1
  times` — `copyDDL` calls `alert()` unconditionally, regardless of the write's outcome.
- **1.3.4** (`Copied on A, then switching to B shows "Copy Schema" again`): failed at
  `getByRole('button', { name: 'Copied' })` because the pre-change flow never reaches a
  "Copied" state at all (same root cause as 1.3.2) — recorded as expected-red-for-the-same-
  precondition rather than a distinct failure mode.

## Mutation Proofs (exact observed red, then reverted)

- **1.4.1** — reintroduced `alert('Copied!')` alongside `copy(ddlCode)` in `DdlPanel`'s
  `onClick`. Re-ran the 1.3.2 test: failed at
  `expect(alertSpy).not.toHaveBeenCalled()` with
  `AssertionError: expected "bound " to not be called at all, but actually been called 1
  times` and `1st bound call: Array ["Copied!"]` — names the exact unexpected call, not a
  `TypeError`. Reverted.
- **1.4.2** — added `alert('Failed to copy.')` inside `useCopyFeedback`'s `catch` block.
  Re-ran the 1.3.3 test: failed at the same `expect(alertSpy).not.toHaveBeenCalled()`
  assertion with `1st bound call: Array ["Failed to copy."]`. Reverted.
- **1.4.3** — dropped `key={activeTable.name}` from `<DdlPanel ddlCode={...} />` in
  `DocBrowserPage.tsx`. Re-ran the 1.3.4 test: failed at
  `getByRole('button', { name: 'Copy Schema' })` (`Unable to find an accessible element with
  the role "button" and name "Copy Schema"`) because without remount, the button on table `B`
  still read "Copied", carrying state across the table switch. Reverted (restored the `key`).

## Non-Negotiable Proof

- `DslEditorToolbar.test.tsx` baseline (before edit): 7/7 pass.
- `git diff --exit-code -- apps/studio/src/features/erd/__tests__/DslEditorToolbar.test.tsx`
  → clean (exit 0) — file byte-unedited.
- `DslEditorToolbar.test.tsx` after the hook rewire: 7/7 pass, same file.

Note: the tasks.md checkpoint commands reference
`src/features/erd/components/__tests__/DslEditorToolbar.test.tsx`, but the actual repo path
is `src/features/erd/__tests__/DslEditorToolbar.test.tsx` (no `components/` segment in the
tests directory). The real path was used for every baseline/checkpoint run and for the
unedited-diff proof; this is a pre-existing path discrepancy in tasks.md, not a deviation in
implementation.

## Verification Command Results

- `pnpm --filter @indigodb/studio test`: exit 0. 32/32 test files, 274/274 tests passed
  (includes the 7 new hook tests, the 3 new DocBrowserPage Copy Schema tests, and the 7
  unedited `DslEditorToolbar.test.tsx` tests). `pack-contents: OK`.
- `pnpm lint`: exit 0. All 21 Turbo tasks succeeded, including `@indigodb/studio:lint`
  (`tsc -b --noEmit`), confirming `DdlPanelProps`, `UseDocBrowserReturn`, and the new hook
  typecheck across every consumer.
- `pnpm build`: exit 0. All 11 Turbo build tasks succeeded (10 cached + `@indigodb/cli`
  fresh); `@indigodb/studio` build (`tsc -b && vite build`) succeeded with only a pre-existing
  chunk-size advisory (unrelated to this change).

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm --filter @indigodb/studio exec vitest run src/shared/hooks/__tests__/useCopyFeedback.test.tsx src/features/erd/__tests__/DslEditorToolbar.test.tsx src/features/docs/__tests__/DocBrowserPage.test.tsx` → 3 files, 14/14 tests passed |
| Runtime harness command/scenario and exact result | N/A — no routing, subprocess, VCS/PR automation, or process-integration boundary in this change (design's Threat Matrix: N/A); the clipboard write is an existing browser API exercised directly by the jsdom component tests above |
| Rollback boundary | This unit is self-contained: `apps/studio/src/shared/hooks/useCopyFeedback.ts` + its test (new), `DslEditorToolbar.tsx` (modified), `DdlPanel.tsx` (modified), `DocBrowserPage.tsx` (modified), `useDocBrowser.ts` (modified: `copyDDL` only), `DocBrowserPage.test.tsx` (new, Copy Schema cases only). Reverting these 6 changed/created paths fully rolls back WU1 without touching `shareReference`, `recordCount`, the banner sentence, or `ColumnsSpecTable` (all WU2, untouched). |

## Files Changed

| File | Action | What Was Done |
|------|--------|----------------|
| `apps/studio/src/shared/hooks/useCopyFeedback.ts` | Created | Shared clipboard-copy feedback hook, ported verbatim from `DslEditorToolbar.tsx:32-50` |
| `apps/studio/src/shared/hooks/__tests__/useCopyFeedback.test.tsx` | Created | 4 tests covering success/re-click/unmount/reject |
| `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` | Modified | Replaced local `copied`/`timeoutRef`/`handleCopyCode` with `useCopyFeedback()` |
| `apps/studio/src/features/docs/components/DdlPanel.tsx` | Modified | `DdlPanelProps` now `{ ddlCode }`; calls `useCopyFeedback()` directly; conditional "Copy Schema"/"Copied" label with `aria-hidden` icons |
| `apps/studio/src/features/docs/DocBrowserPage.tsx` | Modified | Added `key={activeTable.name}` to `<DdlPanel>`, dropped `onCopy={copyDDL}` and `copyDDL` from the `useDocBrowser()` destructure |
| `apps/studio/src/features/docs/hooks/useDocBrowser.ts` | Modified | Deleted `copyDDL` function, its `UseDocBrowserReturn` entry, and its returned-object entry; `shareReference`/`queryTable` untouched |
| `apps/studio/src/features/docs/__tests__/DocBrowserPage.test.tsx` | Created | Scaffold (seed helper, tables A/B) + 3 Copy Schema test cases (WU2 will add the remaining static-removal cases to this same file) |

`git diff --stat` (tracked modifications only; new files are untracked):
```
 apps/studio/src/features/docs/DocBrowserPage.tsx           |  3 +--
 apps/studio/src/features/docs/components/DdlPanel.tsx      | 20 ++++++++++++-----
 apps/studio/src/features/docs/hooks/useDocBrowser.ts       |  7 ------
 apps/studio/src/features/erd/components/DslEditorToolbar.tsx | 26 ++++------------------
 4 files changed, 20 insertions(+), 36 deletions(-)
```
New (untracked) paths: `apps/studio/src/features/docs/__tests__/` (DocBrowserPage.test.tsx),
`apps/studio/src/shared/hooks/` (useCopyFeedback.ts + `__tests__/useCopyFeedback.test.tsx`).

## Deviations from Design

None — implementation matches design's Architecture Decision #1 (shared hook), #2 (`copied`
state lives inside `DdlPanel`, `key`-remounted), and the Interfaces/Contracts block exactly.

## Issues Found

None, other than the pre-existing tasks.md path discrepancy noted above (checkpoint commands
name a `components/__tests__/` path that does not exist for `DslEditorToolbar.test.tsx`; the
real path `features/erd/__tests__/DslEditorToolbar.test.tsx` was used).

## Remaining Tasks (WU2 — not started in this run)

- [ ] 2.1 Banner sentence removal
- [ ] 2.2 Share action removal
- [ ] 2.3 Live-rows metric and Metadata Summary box removal
- [ ] 2.4 Column description honesty (fixture, pipeline test, component test)
- [ ] 2.5 Verification and commit (WU2)

## Workload / PR Boundary

- Mode: chained/stacked PR slice (`stacked-to-main`)
- Current work unit: WU1 — Copy Feedback (shared hook + ERD/docs Copy Schema behaviour)
- Boundary: starts from `main` (clean, `studio-docs-honesty` branch); ends with the 6
  files listed above, all green, all uncommitted pending review
- Estimated review budget impact: ~270 authored lines (design estimate), well under the
  400-line budget for this unit alone

## DO NOT COMMIT

Per the run contract, task 1.5.4 (commit) is intentionally left unchecked. All WU1 changes
remain uncommitted in the working tree for the orchestrator to run native review over before
committing.

## Review correction 1 (R3-ddlpanel-key-collision)

**Finding** (native review, lens `reliability`, severity CRITICAL,
id `R3-ddlpanel-key-collision`): `DdlPanel` in `DocBrowserPage.tsx:51` was keyed on
`activeTable.name` alone. `Table` also carries a `schema` field (real in this app —
`mockData.ts` ships tables across `public` and `billing`), so two tables sharing a `name` but
differing only by `schema` would share the same React key. Switching between them would not
remount `DdlPanel`, and a leftover `copied` state from `useCopyFeedback` could render "Copied"
for a table whose DDL was never actually copied — the exact false-confirmation defect this
change set out to eliminate. The prior regression test (1.3.4/task covering `DocBrowserPage`
remount) only varied `name` (`accounts` vs `sessions`) while both fixtures shared
`schema: 'public'`, so it could not detect a same-name/different-schema collision.

**RED** — added a new test to `DocBrowserPage.test.tsx`: `Copied on a table, then switching to
a same-named table in a different schema shows "Copy Schema" again`, with two new fixtures
`TABLE_C` (`name: 'events', schema: 'public'`) and `TABLE_D` (`name: 'events',
schema: 'billing'`). Ran against the unfixed `key={activeTable.name}`: failed at
`expect(screen.getByRole('button', { name: 'Copy Schema' })).toBeInTheDocument()` with
`Unable to find an accessible element with the role "button" and name "Copy Schema"` — the
button still read "Copied" after switching to the same-named table in the other schema. The
other 3 tests in the file stayed green.

**GREEN (fix)** — changed the key in `DocBrowserPage.tsx` from
`key={activeTable.name}` to `` key={`${activeTable.schema}.${activeTable.name}`} `` — the
schema-qualified identity forces a remount (and thus resets `useCopyFeedback`'s `copied`
state) whenever either `name` or `schema` changes. No other render behavior changed. All 4
tests in `DocBrowserPage.test.tsx` pass (a benign "duplicate key" React warning fires from
`DocsNavSidebar`'s own `key={t.name}`, which is unrelated to `DdlPanel` and out of this
correction's scope).

**Mutation proof** — reverted the key to `activeTable.name` alone via a single surgical Edit,
re-ran the full file: exactly 1 test failed (the new same-name/different-schema test, at the
same `getByRole('button', { name: 'Copy Schema' })` assertion), all 3 others (including the
original name-varying remount test) stayed green. Restored the schema-qualified key; all 4
tests green again.

**Verification** (foreground, from repo root):
- `pnpm --filter @indigodb/studio test`: exit 0 — 32/32 test files, 275/275 tests passed
  (274 prior + 1 new regression test), `pack-contents: OK`.
- `pnpm lint`: exit 0 — all 21 Turbo tasks succeeded.
- `pnpm build`: exit 0 — all 11 Turbo build tasks succeeded, only the pre-existing
  unrelated chunk-size advisory.

**Files touched by this correction**: `apps/studio/src/features/docs/DocBrowserPage.tsx`
(1-line key change), `apps/studio/src/features/docs/__tests__/DocBrowserPage.test.tsx`
(1 new fixture pair + 1 new test). Nothing committed — all changes remain uncommitted in the
working tree alongside the rest of WU1.
