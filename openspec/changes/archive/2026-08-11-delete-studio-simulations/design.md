# Design: Delete the Studio Simulations

## Technical Approach

Four sequential slices over `apps/studio` only. Slice A lands a Vitest harness (no behavior
change). Slices B–D then make each lying control either real or honestly unavailable, each
guarded by RED-first tests from `specs/studio-ui-tests/spec.md`. No `packages/`, `crates/`, or
backend surface is touched. Copy stays plain English (this feature has zero `useTranslation`
today — the proposal's i18n line is superseded by the spec).

## Architecture Decisions

### Decision: Vitest harness rides the existing `vite.config.ts`

**Choice**: Add a `test` block to the existing `apps/studio/vite.config.ts` (with
`/// <reference types="vitest/config" />`), not a separate `vitest.config.ts`.
`environment: 'jsdom'`, `globals: false`, `setupFiles: ['./src/test/setup.ts']`,
`include: ['src/**/*.test.{ts,tsx}']`. Deps: `vitest@^3`, `jsdom`, `@testing-library/react@^16`,
`@testing-library/user-event`, `@testing-library/jest-dom`. Script `"test": "vitest run"`;
Turbo's existing `test` task (`dependsOn: ["build"]`) picks it up with no `turbo.json` change.
**Alternatives**: separate config file (duplicates the `@` alias + `optimizeDeps.exclude`);
jest (needs its own transform stack for React 19 + ESM).
**Rationale**: one source of truth for the alias and the WASM `optimizeDeps.exclude` rule.

Tailwind v4 needs **no** special handling: Vitest's default `css: false` stubs CSS imports, and no
data-browser component imports `index.css`. `@tailwindcss/vite` stays in `plugins` and is inert
for the test graph. Class strings are never asserted — tests query by role/text/`title`.

**Harness gotchas to encode in `src/test/setup.ts`**: `import '@testing-library/jest-dom/vitest'`,
plus jsdom stubs for `ResizeObserver`, `matchMedia`, and `Element.prototype.scrollIntoView`
(`@base-ui/react` popups need them). `@indigodb/core` must stay a **type-only** import along the
data-browser graph (`lib/api.ts`, `store/useDataStore.ts` already are) — a value import would drag
WASM init into jsdom.

### Decision: Harness is its own slice, landing green before any behavior slice

Mirrors `fix-migrator-correctness` and `harden-studio-server`. Slice A includes one smoke test
that opens a `DropdownMenuCheckboxItem` under jsdom — that result decides Filter Columns' UI
before Slice C is written.

### Decision: `recordCount` is removed from the `Table` type, not corrected

**Choice**: delete `recordCount` from `src/types.ts`; render `t.records.length` in `TableList`;
drop `MOCK_USERS_DISPLAY_RECORD_COUNT` and the `=== 4` branch in `useDataStore`; delete the 11
fabricated `recordCount` literals in `mockData.ts` (1,200,000 / 4,500,000 / 88,000 …) and the
`recordCount: 0` initializers in `useCreateTableForm` and `schema-adapter`.
**Alternatives**: set each mock `recordCount` to its seeded length (keeps a field that can drift
back into fabrication).
**Rationale**: the field exists only to hold a number nothing measures. `DocBrowserPage` already
derives `records.length` — this makes derivation the single rule. The fabrication was NOT only in
the store: every mock table's literal count is fake.

### Decision: disabled + native `title`, not the `@base-ui` Tooltip

**Choice**: plain `title` on the control (or its wrapper), matching `TableList.tsx:46`.
Copy: `Row editing isn't available yet — this build is read-only.`
**Alternatives**: `@/components/ui/tooltip` (it exists, `TooltipProvider` is already mounted in
`main.tsx` — so this is not a dependency question).
**Rationale**: a `disabled` button swallows pointer events, so `TooltipTrigger` never opens on it
without a wrapper; and portal-hover assertions in jsdom are fragile. `title` is
`toHaveAttribute`-assertable and works on disabled controls.

### Decision: view-state for Filter/Sort lives in `useTableData`

`useTableData` already owns comparable view-state (`isStructureView`), and both features must
feed the same memo. Added to `UseTableDataReturn`:

```ts
hiddenColumns: Set<string>;            // per active table
visibleColumns: TableColumn[];         // activeTable.columns minus hidden
toggleColumnVisibility: (name: string) => void;
sort: { column: string; direction: 'asc' | 'desc' } | null;
cycleSort: (column: string) => void;   // asc -> desc -> null
```

`hiddenColumns` and `sort` reset when `activeTableIndex` changes (columns differ per table).
Structure Specs keeps showing **all** columns — it documents the schema, not the grid.

### Decision: `filteredRecords` filters, then sorts, over a copy

**Choice**: extend the existing memo — search filter first, then `.slice().sort(cmp)`.
**Rationale**: (1) when `recordSearchQuery` is empty the memo currently returns
`activeTable.records` **by reference**, so an in-place `.sort()` would mutate Zustand state — the
copy is load-bearing, not stylistic; (2) sorting only the visible subset avoids re-sorting the
full set on every keystroke; (3) "sort what is shown" is the semantics the header UI implies.
Comparator: nullish last, numbers numerically, booleans `false < true`, otherwise
`String(a).localeCompare(String(b))`; direction inverts.

### Decision: Refresh is disabled + `title` when no backend (not hidden)

**Rationale**: consistent with the write-action treatment, keeps the toolbar layout stable across
modes, and states a reason rather than silently deleting a capability that is real when connected.
Title: `Refresh needs a connected database — this build is showing sample data.`

## Data Flow

    isBackendAvailable() ──┬──> SampleDataBanner (renders iff false)
                           └──> Refresh button disabled state
                                      │ (enabled path)
                                      ▼
    fetchTableRows(name) ──> updateTableRecords ──> useDataStore.tables
                                                          │
                                     useTableData ────────┘
                                       search filter ──> sort copy ──> filteredRecords
                                       hiddenColumns ──> visibleColumns
                                                          │
                                                  TableBrowserPage grid

`isBackendAvailable()` is a module-level flag set once by `fetchSchema()` at app start; it is read
at render time and is not reactive. This change adds no subscription — accepted limitation.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/studio/vite.config.ts` | Modify | Add Vitest `test` block (A) |
| `apps/studio/package.json` | Modify | `test` script + 5 devDeps (A) |
| `apps/studio/src/test/setup.ts` | Create | jest-dom + ResizeObserver/matchMedia/scrollIntoView stubs (A) |
| `.../browser/TableBrowserPage.tsx` | Modify | Remove 5 `alert()`s + pager + "(simulated client memory cache)"; real `refreshActiveTable()` with `isRefreshing`; sortable headers over `visibleColumns`; Filter Columns dropdown; disabled Add Record; mount banner (B, C, D) |
| `.../browser/components/SampleDataBanner.tsx` | Create | Non-dismissible `role="status"` row, first child of the workspace `<section>` above the 48px toolbar; returns `null` when connected (D) |
| `.../browser/hooks/useTableData.ts` | Modify | `hiddenColumns`/`visibleColumns`/`sort`/`cycleSort`; filter-then-sort memo (C) |
| `.../browser/hooks/useRecordEditor.ts` | Modify | Delete `handleSaveChanges` (fake-success alert), `handleAddRecord` ('Simulated Workspace Row'/'Simulated Value'), `handleDiscardChanges`; keep edit buffers as display values (D) |
| `.../browser/hooks/useCreateTableForm.ts` | Modify | Delete `handleCreateTableSubmit`'s fabricated `setTables` push and its now-unreachable validation alerts (D) |
| `.../browser/components/RecordInspector.tsx` | Modify | Inputs `readOnly`/`disabled`; Save + Discard disabled with `title` (D) |
| `.../browser/components/CreateTableModal.tsx` | Modify | Submit disabled with `title` (D) |
| `.../browser/components/TableList.tsx` | Modify | Render `t.records.length` (B) |
| `apps/studio/src/store/useDataStore.ts` | Modify | Delete `MOCK_USERS_DISPLAY_RECORD_COUNT` + `=== 4` branch (B) |
| `apps/studio/src/data/mockData.ts` | Modify | Delete 11 fabricated `recordCount` literals (B) |
| `apps/studio/src/types.ts` | Modify | Drop `recordCount` from `Table` (B) |
| `apps/studio/src/lib/schema-adapter.ts` | Modify | Drop `recordCount: 0` (B) |
| `.../browser/__tests__/*.test.tsx` | Create | Six honesty scenarios (B–D) |

## Interfaces / Contracts

```tsx
// SampleDataBanner.tsx — no props; reads isBackendAvailable() itself so tests
// control it by mocking ../../../lib/api.
export function SampleDataBanner() {
  if (isBackendAvailable()) return null;
  return (
    <div role="status" className="h-8 ... border-b border-amber-900/40 ...">
      Sample data — no database connected. These rows are bundled examples, not your database.
    </div>
  );
}
```

Filter Columns reuses `@/components/ui/dropdown-menu` (`DropdownMenu` / `DropdownMenuTrigger` /
`DropdownMenuContent` / `DropdownMenuCheckboxItem`), one checkbox item per `activeTable.columns`,
`checked = !hiddenColumns.has(col.name)`. The standalone "Sort Grid" toolbar button is **removed**;
sorting moves onto the `<th>` elements (`ArrowUp` / `ArrowDown` / `ArrowUpDown` indicator, cycling
asc → desc → unsorted), so no control advertises an effect it does not perform.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (hook) | filter-then-sort order, no store mutation, tri-state cycle, per-table reset of hidden/sort | `renderHook` over `useTableData` |
| Component | no `alert` on any control click (spy on `window.alert`), Add Record / Save / Discard / Create-Table-submit disabled + `title`, banner present/absent per `isBackendAvailable()`, count renders `4`, no "Jump page" control, column hide/restore | `render(<TableBrowserPage />)` + `user-event`, `vi.mock('../../../lib/api')` |
| Integration | Refresh calls `fetchTableRows` exactly once when connected | mocked api module + store assertion |
| E2E | — | N/A (no E2E harness in this repo) |

Store isolation: `useDataStore.setState({ tables: INITIAL_TABLES })` in `beforeEach` — Zustand
stores are module singletons and leak across tests otherwise.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. This change is client-side React state only.

## Migration / Rollout

No migration. Pure `apps/studio` change; no schema, IR, WASM, or backend surface. Revert per slice.

## Review Budget

Estimated authored `additions + deletions` (excluding `pnpm-lock.yaml`, generated):

| Slice | Scope | Est. lines |
|-------|-------|-----------|
| A | Vitest harness + jsdom smoke test | ~90 |
| B | Kill `alert()` stubs, pager, footer copy; honest counts | ~200 |
| C | Real Filter Columns + Sort Grid | ~265 |
| D | Read-only write actions + sample-data banner | ~340 |

Total ≈ 895 > the 800-line budget, and C and D each approach the 400-line per-PR budget.
**Chaining is required**: four stacked PRs A → B → C → D, each independently green under
`pnpm lint` + `pnpm test`. A is behavior-neutral and can merge first with no risk.

## Open Questions

- [ ] Spec's coverage note says the Save malformed-JSON alert path is "unchanged, not
  respecified", but disabling Save unconditionally makes it unreachable. This design **removes**
  it as dead code. `sdd-tasks`/`sdd-verify` should treat that as intended, not a spec violation.
- [ ] Whether `@base-ui` `DropdownMenuCheckboxItem` opens reliably under jsdom is settled by
  Slice A's smoke test. If it does not, Filter Columns falls back to a plain
  absolutely-positioned panel of `<label><input type="checkbox">` — same state, same tests,
  no new dependency.
