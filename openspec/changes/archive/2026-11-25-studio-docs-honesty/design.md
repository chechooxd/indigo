# Design: Remove Fabricated Copy and Actions from the Studio Docs View

## Technical Approach

Remove or neutralize only (proposal "Approach"); no new data plumbing. Four removals are pure
deletions from `features/docs/`. The one behavioural fix, Copy Schema, reuses the shape already
used by `DslEditorToolbar.tsx:32-50`. That shape is extracted into one shared hook, so the two
copy controls cannot drift apart. Every scenario in
`specs/studio-ui-honesty/spec.md` is driven through the real components.

## Architecture Decisions

| # | Decision | Choice | Rejected (tradeoff) | Rationale |
|---|---|---|---|---|
| 1 | Copy feedback | Extract `useCopyFeedback()` to `apps/studio/src/shared/hooks/useCopyFeedback.ts`; ERD toolbar and `DdlPanel` both consume it | Local duplication in docs (smaller diff, but two copies of the timer and cleanup logic can drift, which is how the docs copy ended up with `alert()`) | A second real caller now exists. `shared/` already holds cross-feature code (`shared/lib/node-geometry.ts`). The ERD diff is about 20 lines and gets no new behaviour. `DslEditorToolbar.test.tsx` stays green without edits, which proves it. |
| 2 | Where `copied` lives | Inside `DdlPanel`, which calls `copy(ddlCode)` on its own prop. `DocBrowserPage` renders `<DdlPanel key={activeTable.name} …>` | In `useDocBrowser` (UI state would sit in a data hook and a `ddlCopied` prop would be threaded through; the confirmation would also outlive a table switch) | The spec says the confirmation appears "on the control itself". The panel copies the exact string it renders, so by construction it cannot copy another table's DDL. The `key` remounts the panel when the table changes, so "Copied" never appears next to a DDL that was not copied, and the unmount cleanup runs on that path. |
| 3 | "Metadata Summary" box | Delete the whole box, the `Sparkles` import, and `justify-between` on the section | Keep the box with column, index, or relation counts (new metrics nobody asked for, and each repeats a panel right next to it) | "Live rows" was the box's only line. An empty heading would be a fabrication of its own. |
| 4 | Dead props and data | Delete every item listed in the table below. `Table.records` and `schema-adapter.ts:98` stay. | Dropping `records` from `Table` (breaks `TableBrowserPage`, `useTableData`, `TableList`, `mock-query-engine`, `useQueryRunner`, `useDataStore`, and 6 test files) | Once this lands, docs has no remaining reader of `records`. The data browser still depends on it. |
| 5 | Empty description marker | `<span aria-hidden="true">—</span><span className="sr-only">No description</span>`, muted `text-zinc-600` | `aria-label` on a `<span>` (ARIA 1.2 prohibits naming a generic element, and screen-reader support varies); `title` or `<abbr>` (not reliably announced); `role="img"` (misstates the semantics) | Follows the existing `sr-only` pattern in `EnvironmentBadge.tsx:45-50`. The cell's computed accessible name is exactly "No description", so `getByRole('cell', { name: 'No description' })` can assert it. |

Removal inventory (decision 4). Deleting a prop from an interface and its call site at the same time
leaves nothing for `tsc` to flag as a dead reference.

| Symbol | Sites to delete |
|---|---|
| `shareReference` | `useDocBrowser.ts:27,62-66,82`; `DocBrowserPage.tsx:25,46` (`onShare=`); `TableHeroBanner.tsx:7` (`Share`), `:12,16,39-45` |
| `recordCount` | `RelationsPanel.tsx:7` (`Sparkles`), `:17,20,49-59`; `DocBrowserPage.tsx:55` |
| `copyDDL` / `onCopy` | `useDocBrowser.ts:26,57-60,81`; `DocBrowserPage.tsx:24,52`; `DdlPanel.tsx:11,14,22` |
| Banner sentence | `TableHeroBanner.tsx:34` (the second sentence only) |
| Fallback literal | `ColumnsSpecTable.tsx:51`, replaced with `col.description ? text : marker` |

## Interfaces / Contracts

```ts
// shared/hooks/useCopyFeedback.ts — behaviour moved verbatim from DslEditorToolbar.tsx:32-50
export const COPY_FEEDBACK_MS = 1500;
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> };
// copy: awaited writeText inside try; success → copied=true, clear prior timer, re-arm;
// reject or sync throw (clipboard undefined) → catch, no state change, no dialog.
// Unmount effect clears the pending timer.
```

`DdlPanelProps` becomes `{ ddlCode: string }`. The button's accessible name comes from its text
content: "Copy Schema" by default, "Copied" after a successful copy. Icons get `aria-hidden`, and
there is no `aria-label`. Neither copy control announces the change through a live region; see
Open Questions.

## Data Flow

    @note → ResolvedColumn.note → resolvedToTables (description) → ColumnsSpecTable → text | marker
    activeTable → generateTableDDL → DdlPanel(ddlCode) ─click→ useCopyFeedback.copy(ddlCode)

## File Changes

| File | Action | ~Lines |
|---|---|---|
| `apps/studio/src/shared/hooks/useCopyFeedback.ts` | Create | 35 |
| `apps/studio/src/shared/hooks/__tests__/useCopyFeedback.test.tsx` | Create | 90 |
| `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` | Modify (use hook) | 22 |
| `apps/studio/src/features/docs/components/DdlPanel.tsx` | Modify | 20 |
| `apps/studio/src/features/docs/hooks/useDocBrowser.ts` | Modify (delete two actions) | 16 |
| `apps/studio/src/features/docs/DocBrowserPage.tsx` | Modify | 9 |
| `apps/studio/src/features/docs/components/TableHeroBanner.tsx` | Modify | 12 |
| `apps/studio/src/features/docs/components/RelationsPanel.tsx` | Modify | 17 |
| `apps/studio/src/features/docs/components/ColumnsSpecTable.tsx` | Modify | 10 |
| `apps/studio/src/features/docs/__tests__/fixtures/mixed-notes.ts` | Create | 25 |
| `apps/studio/src/features/docs/__tests__/column-notes.pipeline.test.ts` | Create (node env) | 35 |
| `apps/studio/src/features/docs/__tests__/ColumnsSpecTable.test.tsx` | Create | 60 |
| `apps/studio/src/features/docs/__tests__/DocBrowserPage.test.tsx` | Create | 150 |

Total is about 500 authored lines, plus the delta spec. **Split into 2 chained work units.**
**WU1, copy feedback** (hook plus its test, ERD toolbar, `DdlPanel`, the `copyDDL` removal, and the
DocBrowserPage copy tests): about 270 lines. **WU2, static honesty** (banner, share, metric,
columns, fixture, pipeline test, and the rest of the DocBrowserPage tests): about 230 lines. WU2
stacks on WU1 because both edit `useDocBrowser.ts` and `DocBrowserPage.tsx`.

## Testing Strategy

jsdom tests follow the `DslEditorToolbar.test.tsx` harness: `vi.useFakeTimers()`, a
`navigator.clipboard` stub installed with `Object.defineProperty`, and `vi.spyOn(window, 'alert')`.
`DocBrowserPage` tests seed `useDataStore.setState({ tables, resolvedSchema: null })` with two
hand-built tables, `A` with `records.length === 3` and `B` with `records: []`. Seeding `A` with rows
means a restored metric would render a non-zero count, not only the zero branch.

The WASM compiler cannot run under jsdom (`test/setup.ts`), so `@note` coverage is split in two.
`column-notes.pipeline.test.ts` runs in the node environment, sends `MIXED_NOTES_SOURCE` through
the real `parse` → `resolve` → `resolvedToTables`, and asserts `{name, description}` `toEqual`
`MIXED_NOTES_COLUMNS`. The jsdom component test renders that same fixture. The hand-built fixture
is therefore pinned to real pipeline output and cannot drift from it.

| # | Behaviour | File | Assertion | Mutation that must turn it red |
|---|---|---|---|---|
| 1 | Hook: success → copied → clears | `useCopyFeedback.test.tsx` | `copied` true, then false after 1600 ms | Remove the `setTimeout` |
| 2 | Hook: re-click re-arms the timer | same | clicks at 0 and 1000 ms: still copied at 1600, cleared at 2600 | Remove the `clearTimeout` before re-arming |
| 3 | Hook: unmount clears the timer | same | `vi.getTimerCount()` is 0 after unmount | Delete the cleanup effect |
| 4 | Hook: rejected write, or `clipboard` undefined | same | resolves without throwing; `copied` false | Move `setCopied(true)` above the `await` |
| 5 | ERD copy unchanged | `DslEditorToolbar.test.tsx` (not edited) | existing 7 tests green | none needed; this is the regression proof |
| 6 | Copy Schema: exact DDL, inline "Copied", no alert, clears | `DocBrowserPage.test.tsx` | `writeText` called with the DDL block's `textContent`; `getByRole('button',{name:'Copied'})`; alert not called; after 1600 ms name is "Copy Schema" | Reintroduce the `alert(...)`, or copy `ddlCode + '\n'` |
| 7 | Copy Schema with a rejected write | same | no alert; `queryByRole('button',{name:'Copied'})` null | Add `alert` in the catch block |
| 8 | Copied on A, then switch to B | same | on B, the button is named "Copy Schema" | Drop the `key` |
| 9 | No "cluster branches"; factual sentence kept | same | `queryByText(/cluster branch/i)` null; `/Provides unified metadata/` present | Restore the sentence |
| 10 | No share action | same | `queryByRole('button',{name:/share/i})` null | Restore the button |
| 11 | No live-row metric, tables A and B | same | `/live rows/i`, `/record count/i`, `/metadata summary/i` all absent on both | Restore the box |
| 12 | Mixed columns: noted, un-noted, noted | `ColumnsSpecTable.test.tsx` | `getByRole('cell',{name:'Unique identifier'})`, `…'No description'` exactly once, `…'Soft-delete timestamp'`; fallback literal absent | Restore `\|\| 'Database engine…'`; render the marker unconditionally; drop `aria-hidden` (the name becomes "— No description") |
| 13 | `@note` flows through the adapter | `column-notes.pipeline.test.ts` | pipeline output equals the fixture | Adapter emits `description: undefined` |

## Threat Matrix

N/A: this change crosses no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The clipboard write is an existing browser API
call.

## Migration / Rollout

No migration is required. Reverting the commit range reverts the change.

## Open Questions

- [ ] Not blocking: "Copied" is announced only as a change to the button's name, with no live
      region, the same as the ERD toolbar. Adding one to the shared hook should be a separate
      change that covers both surfaces. It must not add a second `role="status"`, which would
      break `App.test.tsx`.
- [ ] Residual risk, carried over unchanged from the ERD code: a write that resolves after
      unmount arms a timer that the already-run cleanup never clears. It is harmless in
      React 19, and it is kept as-is so the extraction does not change behaviour.
