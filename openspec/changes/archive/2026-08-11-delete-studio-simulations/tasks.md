# Tasks: Delete the Studio Simulations

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~895 (A~90, B~200, C~265, D~340) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B → PR C → PR D (stacked) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| A | Vitest harness + jsdom DropdownMenuCheckboxItem smoke test, behavior-neutral | PR A | `pnpm --filter @indigodb/studio test` | jsdom smoke test itself | Revert `vite.config.ts`/`package.json`/`src/test/setup.ts`; no runtime code touched |
| B | Remove alert() stubs, pager, fake `recordCount`; derive counts from `records.length` | PR B | `pnpm --filter @indigodb/studio test` | manual `pnpm --filter @indigodb/studio dev`, click Refresh/pager area | Revert TableBrowserPage/TableList/useDataStore/mockData/types/schema-adapter diffs; PR A stays intact |
| C | Real Filter Columns + Sort Grid over `useTableData` | PR C | `pnpm --filter @indigodb/studio test` | manual dev server: toggle column, click header to sort | Revert `useTableData.ts` + header/dropdown JSX in TableBrowserPage; B's honesty fixes remain |
| D | Disable write actions with `title`, add SampleDataBanner, remove dead Save alert | PR D | `pnpm --filter @indigodb/studio test` | manual dev server: confirm Add Record/Save/Discard/Create-Table disabled, banner shows without backend | Revert RecordInspector/CreateTableModal/useRecordEditor/useCreateTableForm/SampleDataBanner; A–C remain shippable |

## Phase A: Vitest Harness (behavior-neutral, must merge first)

- [ ] A.1 Add `test` devDeps to `apps/studio/package.json`: `vitest@^3`, `jsdom`, `@testing-library/react@^16`, `@testing-library/user-event`, `@testing-library/jest-dom`; add `"test": "vitest run"` script.
- [ ] A.2 Add `/// <reference types="vitest/config" />` + `test: { environment: 'jsdom', globals: false, setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] }` to `apps/studio/vite.config.ts` (no separate `vitest.config.ts`).
- [ ] A.3 Create `apps/studio/src/test/setup.ts`: `import '@testing-library/jest-dom/vitest'` + stubs for `ResizeObserver`, `matchMedia`, `Element.prototype.scrollIntoView`.
- [ ] A.4 RED/GREEN: write and pass one smoke test that renders `@/components/ui/dropdown-menu`'s `DropdownMenuCheckboxItem` under jsdom and asserts it opens (`user-event` click on trigger, content visible). This decides Filter Columns' UI approach for Phase C.
- [ ] A.5 If A.4 fails to open reliably under jsdom, document the fallback decision (plain `<label><input type="checkbox">` panel) inline in the test file's comment for Phase C to consume — do not implement the fallback yet.
- [ ] A.6 Verify `pnpm --filter @indigodb/studio test` and `pnpm --filter @indigodb/studio build` both pass; no other file in `apps/studio/src` changed.

## Phase B: Kill the Lies — Alerts, Pager, Fabricated Counts

- [x] B.1 RED: write a component test for `TableBrowserPage` that spies on `window.alert` and asserts it is never called for Refresh (and honest no-op with no backend), matching this slice's actual scope — see deviation note below re: Save/Discard.
- [x] B.2 RED: write a test asserting no "Jump page" / pager control renders in `TableBrowserPage`.
- [x] B.3 RED: write a test asserting the mock `users` table (4 seeded rows) renders `4` as its record count, not `1,200,000`.
- [x] B.4 GREEN: remove the `alert()` stubs at `TableBrowserPage.tsx` (Refresh, Filter button, Sort button, both pager buttons) and the pager UI entirely; remove the "(simulated client memory cache)" footer copy, keep only "Showing N of N rows". Refresh now performs a real `fetchTableRows` refetch when `isBackendAvailable()`; Filter Columns/Sort Grid buttons removed (Slice C re-adds with real behavior).
- [x] B.5 GREEN: remove `recordCount` from `apps/studio/src/types.ts` (`Table` type).
- [x] B.6 GREEN: delete `MOCK_USERS_DISPLAY_RECORD_COUNT` and its `=== 4` branch in `apps/studio/src/store/useDataStore.ts`.
- [x] B.7 GREEN: delete all 12 fabricated `recordCount` literals in `apps/studio/src/data/mockData.ts` (lines 12, 30, 46, 62, 76, 92, 106, 120, 134, 148, 161, 174 per this session's verification).
- [x] B.8 GREEN: remove `recordCount: 0` initializers in `apps/studio/src/features/studio/browser/hooks/useCreateTableForm.ts` and `apps/studio/src/lib/schema-adapter.ts`.
- [x] B.9 GREEN: update `apps/studio/src/features/studio/browser/components/TableList.tsx` to render `t.records.length` (matches `DocBrowserPage.tsx:55` precedent).
- [x] B.10 Verify A.1–B.9 tests pass: `pnpm --filter @indigodb/studio test`; run `pnpm --filter @indigodb/studio build` and `pnpm lint` for type-safety on the removed `recordCount` field. All green — see apply-progress for full gate output.

## Phase C: Real Filter Columns + Sort Grid

- [x] C.1 RED: write a `renderHook` test for `useTableData` asserting `filteredRecords` sorts a **copy**, not the store's original array (assert `useDataStore.getState().tables[i].records` is unchanged in reference/order after `cycleSort` is applied) — this is its own explicit scenario, not folded into a general sort test.
- [x] C.2 RED: write a `renderHook` test asserting filter runs before sort (filtered-out rows never affect sort order) and tri-state cycle (asc → desc → unsorted) on repeated `cycleSort` calls.
- [x] C.3 RED: write a `renderHook` test asserting `hiddenColumns` and `sort` reset when `activeTableIndex` changes.
- [x] C.4 RED: write a component test asserting toggling a column in the Filter Columns dropdown hides its header+cells and restores them on re-toggle.
- [x] C.5 GREEN: extend `UseTableDataReturn` in `apps/studio/src/features/studio/browser/hooks/useTableData.ts` with `hiddenColumns: Set<string>`, `visibleColumns`, `toggleColumnVisibility`, `sort: {column, direction} | null`, `cycleSort`; reset both on `activeTableIndex` change.
- [x] C.6 GREEN: implement `filteredRecords` as filter-then-`.slice().sort(cmp)` (never in-place `.sort()` on `activeTable.records`); comparator: nullish last, numbers numeric, booleans `false < true`, else `String().localeCompare`.
- [x] C.7 GREEN: replace the standalone "Sort Grid" toolbar button in `TableBrowserPage.tsx` with sortable `<th>` clicks over `visibleColumns` (ArrowUp/ArrowDown/ArrowUpDown indicator).
- [x] C.8 GREEN: replace the Filter toolbar `alert()` with a real `DropdownMenuCheckboxItem`-per-column dropdown (or A.5's plain-checkbox fallback if the smoke test failed), `checked = !hiddenColumns.has(col.name)`.
- [x] C.9 Confirm Structure Specs view still renders all columns unaffected by `hiddenColumns` (spec requirement — Structure Specs documents schema, not the grid).
- [x] C.10 Verify: `pnpm --filter @indigodb/studio test`, `pnpm --filter @indigodb/studio build`.

## Phase D: Disable Write Actions + Sample-Data Banner

- [x] D.1 RED: write component tests asserting Add Record, Save, Discard, and Create Table submit buttons are `disabled` and have `title="Row editing isn't available yet — this build is read-only."`, and that clicking them causes no store mutation.
- [x] D.2 RED: write component tests asserting `SampleDataBanner` renders with `role="status"` when `isBackendAvailable()` is false (mocked `../../../lib/api`), and renders nothing when true.
- [x] D.3 RED: write a component test asserting Refresh is `disabled` with `title="Refresh needs a connected database — this build is showing sample data."` when no backend, and an integration test asserting Refresh calls `fetchTableRows` exactly once when a backend is connected.
- [x] D.4 GREEN: create `apps/studio/src/features/studio/browser/components/SampleDataBanner.tsx` — no props, calls `isBackendAvailable()` itself, `role="status"`, non-dismissible, returns `null` when connected.
- [x] D.5 GREEN: mount `<SampleDataBanner />` as the first child of the workspace `<section>` in `TableBrowserPage.tsx`, above the existing 48px toolbar.
- [x] D.6 GREEN: disable Add Record button in `TableBrowserPage.tsx` with the read-only `title`; disable Save/Discard in `RecordInspector.tsx` (inputs `readOnly`/`disabled` too) with the same `title`; disable Create Table submit in `CreateTableModal.tsx` with the same `title`.
- [x] D.7 GREEN: implement real `refreshActiveTable()` with an `isRefreshing` state in `TableBrowserPage.tsx`; disable the Refresh control with its `title` when `!isBackendAvailable()`.
- [x] D.8 Confirm `handleSaveChanges`'s malformed-JSON `alert()` in `useRecordEditor.ts` is genuinely unreachable once Save is unconditionally disabled (no other call path reaches it), then delete `handleSaveChanges`, `handleAddRecord` ('Simulated Workspace Row'/'Simulated Value'), and `handleDiscardChanges`; keep edit buffers as read-only display values. Record this removal explicitly in apply-progress as a documented deviation from the spec's "unchanged, not respecified" note (per design's Open Questions).
- [x] D.9 GREEN: delete `useCreateTableForm.ts`'s fabricated `setTables` push and the validation `alert()`s that become unreachable once submit is disabled (verify unreachability first, same as D.8).
- [x] D.10 Verify: `pnpm --filter @indigodb/studio test`, `pnpm --filter @indigodb/studio build`, `pnpm lint`.

## Phase E: Cross-Slice Verification (after D lands)

- [ ] E.1 Run full suite: `pnpm --filter @indigodb/studio test`, `pnpm build`, `pnpm lint`, `pnpm test` (root), `cd crates && cargo test` — confirm no regressions outside `apps/studio`.
- [ ] E.2 Confirm all six spec scenarios (Refresh, Filter/Sort, record-count, write-action-disabled, sample-data-indicator, pager-removal) have a passing test mapped to them.
- [ ] E.3 Confirm all four PRs (A→B→C→D) are merged/stacked before closing the Phase 0 epic.
