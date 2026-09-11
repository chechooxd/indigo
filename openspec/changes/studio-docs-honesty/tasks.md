# Tasks: Remove Fabricated Copy and Actions from the Studio Docs View

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~500 total (WU1 ~270, WU2 ~230) |
| 400-line budget risk | Low per unit; High if landed as one PR |
| Chained PRs recommended | Yes — 2 |
| Chain strategy | stacked-to-main: WU2 branches off WU1; both land on `main` linearly; branches deleted after each merge |
| Decision needed before apply | No |

Design's own file-change table sums to ~500 authored lines, comfortably over the 400-line
budget as a single PR but each unit lands well under it on its own. WU1 (copy feedback: the
shared hook, its test, the ERD toolbar refactor, `DdlPanel`, and the `copyDDL`/`onCopy`
plumbing removal) is ~270 lines. WU2 (static removals: banner sentence, share action,
live-rows metric + Metadata Summary box, column em-dash marker, and their tests) is ~230
lines and stacks on WU1 because both touch `useDocBrowser.ts` and `DocBrowserPage.tsx`.

## Work Unit 1: Copy Feedback (shared hook + ERD/docs Copy Schema behaviour)

Branch base: `main`. Files: `shared/hooks/useCopyFeedback.ts` (new),
`shared/hooks/__tests__/useCopyFeedback.test.tsx` (new),
`features/erd/components/DslEditorToolbar.tsx` (modify), `features/docs/components/DdlPanel.tsx`
(modify), `features/docs/hooks/useDocBrowser.ts` (modify: delete `copyDDL`), `DocBrowserPage.tsx`
(modify: drop `onCopy=`, remove `copyDDL` from destructure), and new copy-related cases in
`features/docs/__tests__/DocBrowserPage.test.tsx`.

### 1.1 Extract the shared hook (RED → GREEN)

- [ ] 1.1.1 RED — Create `apps/studio/src/shared/hooks/__tests__/useCopyFeedback.test.tsx`.
  Write test "success write sets `copied` true, then false after 1600ms" (design Testing
  Strategy row 1): `vi.useFakeTimers()`, `navigator.clipboard.writeText` stubbed via
  `Object.defineProperty` to resolve, render the hook with `@testing-library/react`'s
  `renderHook`, call `copy('x')`, advance timers, assert `copied` transitions
  `false → true → false`. Run it — it MUST fail with "Cannot find module
  '../useCopyFeedback'" (the file does not exist yet). Record the failing import error.
- [ ] 1.1.2 RED — In the same file, add test "re-click re-arms the timer" (row 2): call
  `copy()` at t=0 and again at t=1000ms; assert `copied` is still `true` at t=1600ms and
  `false` at t=2600ms. Confirm it fails for the same missing-module reason as 1.1.1.
- [ ] 1.1.3 RED — Add test "unmount clears the pending timer" (row 3): call `copy()`, unmount
  the rendered hook, assert `vi.getTimerCount() === 0`. Confirm current failure (missing
  module).
- [ ] 1.1.4 RED — Add test "rejected write, or clipboard undefined, never sets `copied`"
  (row 4): stub `writeText` to reject; call `copy()`; assert the returned promise resolves
  without throwing and `copied` stays `false`. Confirm current failure (missing module).
- [ ] 1.1.5 GREEN — Create `apps/studio/src/shared/hooks/useCopyFeedback.ts`. Port the shape
  from `DslEditorToolbar.tsx:32-50` verbatim: `COPY_FEEDBACK_MS = 1500`; `copied` state; a
  `timeoutRef`; `copy(text)` does `await navigator.clipboard.writeText(text)` inside
  `try`, sets `copied(true)`, clears any prior timeout, re-arms a new one; `catch` does
  nothing (no state change, no dialog); an unmount effect clears the pending timer. Export
  `{ copied, copy }` and `COPY_FEEDBACK_MS`.
- [ ] 1.1.6 Run 1.1.1-1.1.4 and confirm all four now pass (GREEN).
- [ ] 1.1.7 REFACTOR checkpoint — no behaviour change expected; confirm the hook file has no
  leftover ERD-specific naming (`dslCode`, `handleCopyCode`) and matches the interface in
  design's Interfaces/Contracts block exactly.

### 1.2 Rewire `DslEditorToolbar` onto the hook without changing its tests

- [ ] 1.2.1 Baseline checkpoint (mandatory per delivery contract): run
  `pnpm --filter @indigodb/studio exec vitest run src/features/erd/components/__tests__/DslEditorToolbar.test.tsx`
  BEFORE editing the component. Confirm all 7 tests pass on the unmodified file. Record the
  pass count.
- [ ] 1.2.2 Edit `apps/studio/src/features/erd/components/DslEditorToolbar.tsx`: replace the
  local `copied`/`timeoutRef`/`handleCopyCode` block with `const { copied, copy } =
  useCopyFeedback();` and `onClick={() => copy(dslCode)}`. Delete the now-unused
  `COPY_FEEDBACK_MS` constant and the `useEffect`/`useRef` imports that become dead. Do not
  touch `DslEditorToolbar.test.tsx`.
- [ ] 1.2.3 Checkpoint (explicit, per delivery contract) — re-run
  `pnpm --filter @indigodb/studio exec vitest run src/features/erd/components/__tests__/DslEditorToolbar.test.tsx`
  with the file UNEDITED. Confirm the same 7 tests still pass, proving the extraction is
  behaviour-preserving.

### 1.3 `DdlPanel` consumes the hook directly (RED → GREEN)

- [ ] 1.3.1 RED — Create `apps/studio/src/features/docs/__tests__/DocBrowserPage.test.tsx`
  scaffold: imports, a render helper that seeds `useDataStore.setState({ tables, resolvedSchema:
  null })` with hand-built tables `A` (`records.length === 3`) and `B` (`records: []`), matching
  design's Testing Strategy. No test bodies yet beyond the scaffold and helper.
- [ ] 1.3.2 RED — Write test "Copy Schema: exact DDL, inline Copied, no alert, clears" (spec
  scenario "Copying the docs-view schema DDL shows inline confirmation and clears"; design row
  6): stub `navigator.clipboard.writeText` and `vi.spyOn(window, 'alert')`; render
  `DocBrowserPage` on table `A`; click the button named "Copy Schema"; assert `writeText` was
  called with the rendered DDL block's exact text content; assert
  `getByRole('button', { name: 'Copied' })`; assert `alert` was not called; advance 1600ms and
  assert the name reverts to "Copy Schema". Run it against the current `DdlPanel`
  (`onCopy` prop calling `useDocBrowser`'s `copyDDL`, which calls `alert(...)`) and confirm it
  fails on the `alert` assertion. Record the observed failure.
- [ ] 1.3.3 RED — Write test "rejected clipboard write on Copy Schema shows no dialog and no
  false confirmation" (spec scenario of the same name; design row 7): stub `writeText` to
  reject; click Copy Schema; assert `alert` not called and
  `queryByRole('button', { name: 'Copied' })` is `null`. Confirm current failure (the existing
  `copyDDL` calls `alert` unconditionally, regardless of the write's outcome).
- [ ] 1.3.4 RED — Write test "Copied on A, then switch to B shows Copy Schema again" (spec
  scenario "Copy Schema writes the active table's real DDL text"; design row 8): click Copy
  Schema on `A` to reach "Copied", switch the active table to `B` via the sidebar/table list,
  assert the button on `B` is named "Copy Schema" (not "Copied"). Confirm current failure or
  note if it already passes by accident — if it passes before the `key` change, state that
  explicitly and keep the assertion as a regression guard.
- [ ] 1.3.5 GREEN — Edit `apps/studio/src/features/docs/components/DdlPanel.tsx`:
  `DdlPanelProps` becomes `{ ddlCode: string }` (drop `onCopy`); import and call
  `useCopyFeedback()` directly inside the component; the button's `onClick` is
  `() => copy(ddlCode)`; the button's accessible name comes from its text content only —
  "Copy Schema" by default, "Copied" after a successful copy (replace the fixed "Copy Schema"
  label with a conditional). Icons get `aria-hidden`; no `aria-label` is added (per design
  Interfaces/Contracts).
- [ ] 1.3.6 GREEN — Edit `apps/studio/src/features/docs/DocBrowserPage.tsx`: render
  `<DdlPanel key={activeTable.name} ddlCode={ddlDefinitionCode} />` (add the `key`, drop
  `onCopy={copyDDL}`).
- [ ] 1.3.7 GREEN — Edit `apps/studio/src/features/docs/hooks/useDocBrowser.ts`: delete the
  `copyDDL` function body and its `copyDDL` entry from `UseDocBrowserReturn` and the returned
  object. Leave `shareReference` and `queryTable` untouched (out of scope for this unit).
  Remove the now-unused `navigator.clipboard`/`alert` line tied only to `copyDDL`.
- [ ] 1.3.8 Run 1.3.2-1.3.4 and confirm all three now pass (GREEN).

### 1.4 Mutation proofs (WU1)

- [ ] 1.4.1 Mutation proof — reintroduce `alert(...)` inside `DdlPanel`'s (or
  `useCopyFeedback`'s) success path. Run 1.3.2 and confirm it goes red on the
  `expect(alert).not.toHaveBeenCalled()` assertion, naming the unexpected call in the failure
  message — not a `TypeError`. Record the observed red output, then revert.
- [ ] 1.4.2 Mutation proof — add `alert(...)` inside the `catch` block of `useCopyFeedback`'s
  `copy`. Run 1.3.3 and confirm it goes red on the same `alert` assertion. Record the observed
  red output, then revert.
- [ ] 1.4.3 Mutation proof — drop `key={activeTable.name}` from the `DdlPanel` usage in
  `DocBrowserPage.tsx`. Run 1.3.4 and confirm it goes red because the button on `B` still
  reads "Copied" (state carried across the table switch). Record the observed red output,
  then revert (restore the `key`).

### 1.5 Verification and commit (WU1)

- [ ] 1.5.1 Run `pnpm --filter @indigodb/studio test` and record the exit code and pass count
  (must be 0 and all new + `DslEditorToolbar.test.tsx`'s 7 green).
- [ ] 1.5.2 Run `pnpm lint` and record the exit code (must be 0 — confirms `DdlPanelProps`,
  `UseDocBrowserReturn`, and the new hook typecheck across all consumers).
- [ ] 1.5.3 Run `pnpm build` and record the exit code (must be 0).
- [ ] 1.5.4 Commit WU1 with a conventional commit message (e.g.
  `refactor(studio): extract useCopyFeedback and remove Copy Schema's alert`). No
  Co-Authored-By or AI attribution lines.

## Work Unit 2: Static Honesty Removals (banner, share, metric, columns)

Branch base: WU1's branch (stacked). Files: `features/docs/components/TableHeroBanner.tsx`
(modify), `features/docs/components/RelationsPanel.tsx` (modify), `features/docs/DocBrowserPage.tsx`
(modify: drop `onShare`/`recordCount`), `features/docs/hooks/useDocBrowser.ts` (modify: delete
`shareReference`), `features/docs/components/ColumnsSpecTable.tsx` (modify), new fixture
`features/docs/__tests__/fixtures/mixed-notes.ts`, new
`features/docs/__tests__/column-notes.pipeline.test.ts`, new
`features/docs/__tests__/ColumnsSpecTable.test.tsx`, and the remaining static-removal cases
in `DocBrowserPage.test.tsx` (already scaffolded in WU1).

### 2.1 Banner sentence removal (RED → GREEN)

- [ ] 2.1.1 RED — In `DocBrowserPage.test.tsx`, write test "no cluster branches sentence;
  factual sentence kept" (spec scenario "The banner keeps its factual sentence and drops the
  fabricated one"; design row 9): render on table `A`; assert
  `queryByText(/cluster branch/i)` is `null` and text matching
  `/Provides unified metadata/` is present. Run it against the current
  `TableHeroBanner.tsx:34` and confirm it fails (the sentence is present).
- [ ] 2.1.2 GREEN — Edit `apps/studio/src/features/docs/components/TableHeroBanner.tsx:34`:
  delete only the second sentence ("Automatically managed within the transactional limits of
  active cluster branches."), keeping the factual first sentence verbatim.
- [ ] 2.1.3 Run 2.1.1 and confirm it now passes.
- [ ] 2.1.4 Mutation proof — restore the deleted sentence. Run 2.1.1 and confirm it goes red
  on the `queryByText(/cluster branch/i)` assertion (not null), naming the matched text.
  Record the observed red output, then revert.

### 2.2 Share action removal (RED → GREEN)

- [ ] 2.2.1 RED — In `DocBrowserPage.test.tsx`, write test "no share action" (spec scenario
  "No share or reference-link action is offered"; design row 10): assert
  `queryByRole('button', { name: /share/i })` is `null`. Run it against the current banner and
  confirm it fails (the button exists).
- [ ] 2.2.2 GREEN — Edit `apps/studio/src/features/docs/components/TableHeroBanner.tsx`:
  delete the `onShare` prop from `TableHeroBannerProps`, the `Share` import, and the entire
  "Share Reference" `<button>`.
- [ ] 2.2.3 GREEN — Edit `apps/studio/src/features/docs/hooks/useDocBrowser.ts`: delete the
  `shareReference` function body and its entry from `UseDocBrowserReturn` and the returned
  object.
- [ ] 2.2.4 GREEN — Edit `apps/studio/src/features/docs/DocBrowserPage.tsx`: drop
  `shareReference` from the `useDocBrowser()` destructure and drop `onShare={shareReference}`
  from the `<TableHeroBanner>` call.
- [ ] 2.2.5 Run 2.2.1 and confirm it now passes.
- [ ] 2.2.6 Mutation proof — restore the "Share Reference" button and its `onShare` wiring.
  Run 2.2.1 and confirm it goes red because the button is found by role/name. Record the
  observed red output, then revert.

### 2.3 Live-rows metric and Metadata Summary box removal (RED → GREEN)

- [ ] 2.3.1 RED — In `DocBrowserPage.test.tsx`, write test "no live-row metric on either
  table" (spec scenario "No fabricated live-row metric is shown for any table"; design row
  11): render on table `A` (`records.length === 3`, so a restored metric would show a
  non-zero count, not only the zero branch) and separately on table `B` (`records: []`);
  assert `/live rows/i`, `/record count/i`, and `/metadata summary/i` are all absent on both
  renders. Run it against the current `RelationsPanel.tsx` and confirm it fails (all three
  strings are present).
- [ ] 2.3.2 GREEN — Edit `apps/studio/src/features/docs/components/RelationsPanel.tsx`:
  delete the `recordCount` prop from `RelationsPanelProps`, the `Sparkles` import, the entire
  "Table Metrics summary" `<div>` block (Metadata Summary heading + Record Count line), and
  the `justify-between` class on the outer `<section>` (its only purpose was to push that box
  to the bottom).
- [ ] 2.3.3 GREEN — Edit `apps/studio/src/features/docs/DocBrowserPage.tsx`: drop
  `recordCount={activeTable.records ? activeTable.records.length : 0}` from the
  `<RelationsPanel>` call.
- [ ] 2.3.4 Run 2.3.1 and confirm it now passes for both seeded tables.
- [ ] 2.3.5 Mutation proof — restore the Metadata Summary box (with `recordCount` wired back
  through `DocBrowserPage`). Run 2.3.1 and confirm it goes red on table `A` specifically
  (`/live rows/i` or `/record count/i` found), proving the seeded non-zero fixture actually
  exercises the assertion rather than only the empty-array branch. Record the observed red
  output, then revert.

### 2.4 Column description honesty (fixture pinning → pipeline test → component test)

- [ ] 2.4.1 Create `apps/studio/src/features/docs/__tests__/fixtures/mixed-notes.ts`: export
  `MIXED_NOTES_SOURCE` (a `.indigo` source string with a table declaring three columns — one
  with `@note("Unique identifier")`, one with no `@note`, one with `@note("Soft-delete
  timestamp")`) and `MIXED_NOTES_COLUMNS` (the expected `{ name, description }[]` array, with
  the un-noted column's `description` as `undefined`).
- [ ] 2.4.2 RED — Create `apps/studio/src/features/docs/__tests__/column-notes.pipeline.test.ts`
  (node environment, real pipeline per design's Testing Strategy — the WASM compiler cannot
  run under jsdom): import `parse`/`resolve` from `@indigodb/core` and `resolvedToTables` from
  `../../../lib/schema-adapter`; run `MIXED_NOTES_SOURCE` through `parse` → `resolve` →
  `resolvedToTables`; assert the resulting columns' `{name, description}` `toEqual`
  `MIXED_NOTES_COLUMNS` (spec scenario "@note flows through the adapter"; design row 13). Run
  it and confirm it fails only if the adapter currently drops `description` — if it already
  passes because the adapter already threads `note`, record that as a pre-existing pass and
  proceed (this task's purpose is pinning the fixture to real output, not necessarily
  producing a new red — state the observed result explicitly either way).
- [ ] 2.4.3 GREEN (only if 2.4.2 was red) — confirm/adjust `resolvedToTables` in
  `apps/studio/src/lib/schema-adapter.ts` so `ResolvedColumn.note` maps to the adapted
  column's `description`. Re-run 2.4.2 and confirm it passes.
- [ ] 2.4.4 RED — Create `apps/studio/src/features/docs/__tests__/ColumnsSpecTable.test.tsx`
  (jsdom). Write test "mixed columns: noted, un-noted, noted" (spec scenarios "An undocumented
  column shows an honest absence marker", "A documented column renders its real note
  verbatim", "A table with mixed documented and undocumented columns renders each correctly";
  design row 12): render `ColumnsSpecTable` with `MIXED_NOTES_COLUMNS` (imported from the
  fixture created in 2.4.1, mapped into `TableColumn[]`); assert
  `getByRole('cell', { name: 'Unique identifier' })`,
  `getByRole('cell', { name: 'No description' })` exactly once, and
  `getByRole('cell', { name: 'Soft-delete timestamp' })`; assert the fallback literal
  "Database engine system column value." is absent. Run it against the current
  `ColumnsSpecTable.tsx:51` and confirm it fails (the fallback literal renders instead of the
  accessible "No description" name, and the em dash carries no accessible label).
- [ ] 2.4.5 GREEN — Edit `apps/studio/src/features/docs/components/ColumnsSpecTable.tsx:51`:
  replace `{col.description || 'Database engine system column value.'}` with a conditional —
  when `col.description` is present, render it verbatim; otherwise render
  `<span aria-hidden="true">—</span><span className="sr-only">No description</span>` with
  muted `text-zinc-600` styling, following the `sr-only` pattern at
  `EnvironmentBadge.tsx:66`.
- [ ] 2.4.6 Run 2.4.4 and confirm it now passes.
- [ ] 2.4.7 Mutation proof — restore `|| 'Database engine system column value.'` as the
  fallback. Run 2.4.4 and confirm it goes red on the fallback-literal-absence assertion,
  naming the found text. Record the observed red output, then revert.
- [ ] 2.4.8 Mutation proof — render the `—`/"No description" marker unconditionally
  (regardless of `col.description`). Run 2.4.4 and confirm it goes red because the noted
  columns' cells no longer expose their verbatim text as the accessible name. Record the
  observed red output, then revert.
- [ ] 2.4.9 Mutation proof — drop `aria-hidden="true"` from the `—` span. Run 2.4.4 and
  confirm it goes red because the cell's computed accessible name becomes "— No description"
  instead of exactly "No description", so `getByRole('cell', { name: 'No description' })` no
  longer matches. Record the observed red output, then revert.

### 2.5 Verification and commit (WU2)

- [ ] 2.5.1 Run `pnpm --filter @indigodb/studio test` and record the exit code and pass count
  (must be 0; includes WU1's suites still green, plus every new test in this unit).
- [ ] 2.5.2 Run `pnpm lint` and record the exit code (must be 0).
- [ ] 2.5.3 Run `pnpm build` and record the exit code (must be 0).
- [ ] 2.5.4 Commit WU2 with a conventional commit message (e.g.
  `fix(studio): remove fabricated docs-view copy, share action, and live-row metric`). No
  Co-Authored-By or AI attribution lines.

## Out of Scope (named, not folded in)

- `DocsNavSidebar.tsx:19-20` hardcoded schema grouping — separate follow-up (proposal).
- Any real row count / `fetchTableRows` wiring, URL routing, deep links, `queryTable()`'s TODO
  comment, i18n of docs strings — all named out of scope by the proposal.
- Adding a live region (`role="status"`) to `useCopyFeedback` — design's Open Questions marks
  this as a separate change; it must not add a second `role="status"` that would break
  `App.test.tsx`.
- The residual post-unmount-timer race named in design's Open Questions — carried over
  unchanged from the ERD code, kept as-is so the extraction does not change behaviour.
