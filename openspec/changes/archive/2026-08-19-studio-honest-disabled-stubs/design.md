# Design: Honest Disabled States for Studio's Remaining Simulated Controls

## Technical Approach

Mirror the already-shipped `TableBrowserPage` honesty pattern: a module-level English
title constant colocated with the JSX, `disabled`, `title={CONSTANT}`, and the fake
handler deleted outright (not replaced by a no-op). Where a real implementation
genuinely exists, gate it on `isBackendAvailable()` instead of disabling permanently —
that is what `TableBrowserPage`'s Refresh already does.

**Correction to the proposal**: `apps/studio` *does* have a test runner. `package.json`
has `"test": "vitest run"`, `vite.config.ts` carries the `test` block (jsdom, globals,
`src/test/setup.ts`), and `@testing-library/react` + `jsdom` are installed. Three suites
exist under `features/studio/browser/__tests__/`. No harness bootstrap is needed; this
change only adds spec files.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | `openCli` | Delete handler + `onOpenCli` prop; disable button | Keep prop as no-op | A browser cannot open a CLI socket; a live prop invites a fake handler's return |
| 2 | `viewAllSchemas` | **Honest disable** — no real nav target | Navigate somewhere | `ViewTab = 'home' \| 'editor' \| 'studio' \| 'docs' \| 'settings'` (`src/types.ts:43`). There is no schemas-list route, and `RecentSchemasTable` *is* the schemas list, already on `home`. Its data is dashboard mock data whose backend endpoint does not exist (out of scope). Any `navigate()` would be theatre |
| 3 | SchemaBrowser refresh | **Gated real refresh** | Permanent disable | A real refetch exists: `fetchSchema()` → `resolvedToTables()` → `setTables` (`useSchemaBootstrap.ts`). Permanently disabling a control that works under `indigodb studio` is dishonest in the opposite direction. Extract `loadSchemaIntoStore()` so bootstrap and refresh share one path |
| 4 | Panel boundary | `SchemaBrowserPanel` stays presentational: new `canRefresh: boolean` + `onRefresh: () => Promise<void>` props; `QueryEnginePage` calls `isBackendAvailable()` | Panel imports `lib/api` directly | Keeps container/presentational split; page-level components own I/O (as `TableBrowserPage` does, being a page) |
| 5 | Copy feedback | Extract `DslEditorToolbar`; it owns `copied` state (`useState` + `setTimeout(1500)` cleared in a `useEffect` cleanup) and flips only after the clipboard promise **resolves** | Test `ERDDesignerPage` whole | The page pulls in Monaco, `@xyflow/react` and the WASM compiler via `useERDParser` — untestable in jsdom without fragile mocks. Extraction makes the assertion cheap and honest (a rejected write shows nothing) |
| 6 | Copy string | Plain English constants, no `t()` | i18n keys | Matches the tested `READ_ONLY_TITLE` / `REFRESH_DISABLED_TITLE` precedent. i18n of honesty strings is pre-existing debt, tracked as a risk |

## Data Flow

    QueryEnginePage ──canRefresh/onRefresh──► SchemaBrowserPanel
          │                                        (owns isRefreshing)
          └─► loadSchemaIntoStore() ─► fetchSchema ─► resolvedToTables ─► useDataStore
                     ▲
          useSchemaBootstrap (mount) ─┘

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/studio/src/features/dashboard/hooks/useDashboardActions.ts` | Modify | Delete `openCli` and `viewAllSchemas` + their interface members and returns |
| `apps/studio/src/features/dashboard/DashboardPage.tsx` | Modify | Stop destructuring/passing the two removed actions |
| `apps/studio/src/features/dashboard/components/WelcomeHero.tsx` | Modify | Drop `onOpenCli`; `disabled` + `title={CLI_DISABLED_TITLE}` |
| `apps/studio/src/features/dashboard/components/RecentSchemasTable.tsx` | Modify | Drop `onViewAll`; `disabled` + `title={VIEW_ALL_DISABLED_TITLE}` + disabled classes |
| `apps/studio/src/lib/schema-loader.ts` | Create | `export async function loadSchemaIntoStore(): Promise<void>` |
| `apps/studio/src/app/hooks/useSchemaBootstrap.ts` | Modify | Delegate to `loadSchemaIntoStore()` |
| `apps/studio/src/features/studio/query/QueryEnginePage.tsx` | Modify | Pass `canRefresh={isBackendAvailable()}` and `onRefresh={loadSchemaIntoStore}` |
| `apps/studio/src/features/studio/query/components/SchemaBrowserPanel.tsx` | Modify | Remove `alert`; new props; `disabled={!canRefresh \|\| isRefreshing}`, `title` when blocked; `aria-label="Refresh schema"` |
| `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` | Create | Copy (transient "Copied") + disabled History buttons |
| `apps/studio/src/features/erd/ERDDesignerPage.tsx` | Modify | `handleCopyCode` returns the clipboard promise, no `alert`; render toolbar |
| `apps/studio/src/features/dashboard/__tests__/DashboardPage.test.tsx` | Create | Regression tests |
| `apps/studio/src/features/studio/query/__tests__/SchemaBrowserPanel.test.tsx` | Create | Regression tests |
| `apps/studio/src/features/erd/__tests__/DslEditorToolbar.test.tsx` | Create | Regression tests |

## Interfaces / Contracts

```ts
// English copy — exact strings the tests assert
const CLI_DISABLED_TITLE = "Connecting to the CLI isn't available from the browser.";
const VIEW_ALL_DISABLED_TITLE = 'All schemas are already listed here.';
const REFRESH_DISABLED_TITLE = 'Refresh needs a connected database — this build is showing sample data.';
const HISTORY_DISABLED_TITLE = "Revision history isn't available yet.";

interface SchemaBrowserPanelProps {
  tables: Table[]; selectedTable: string; onSelectTable: (n: string) => void;
  canRefresh: boolean; onRefresh: () => Promise<void>;
}
interface DslEditorToolbarProps { onCopy: () => Promise<void>; }
```

`REFRESH_DISABLED_TITLE` is duplicated verbatim rather than exported from
`TableBrowserPage` (a page module) — the two surfaces are independent.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Component | CLI + View-all buttons disabled with exact titles; `window.alert` never called | `render(<DashboardPage />)`, `vi.spyOn(window, 'alert')` |
| Component | Refresh disabled + titled when `canRefresh` false; calls `onRefresh` when true; no `alert` | Render `SchemaBrowserPanel` directly with stub props |
| Component | History disabled + titled; Copy shows "Copied" then reverts; rejected clipboard shows nothing; no `alert` | Render `DslEditorToolbar`; `vi.useFakeTimers()` for the revert |
| Repo | Typecheck + full suite | `pnpm lint && pnpm test` from root |

Existing `TableBrowserPage.test.tsx` must keep passing unchanged.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification,
or process-integration boundary. Decision 2 resolves *away* from a routing change.

## Migration / Rollout

No migration. Pure UI, no type contract crossing a package boundary, no WASM rebuild,
no generated artifact. Revert = revert the commit.

**Slicing**: not needed. Forecast ≈ 180–240 changed lines including tests — well under
the 800-line budget. One commit.

## Open Questions

- [ ] `ERDDesignerPage.tsx:86,93,99` carry Spanish `title`s ("Solo editor", "Dividir
      vista", "Solo lienzo"). The proposal's success criterion "no Spanish string
      remains in shipped Studio UI copy" is **not** met by fixing the alert alone.
      Recommend folding these three one-word fixes in; scope was user-fixed, so flag
      rather than assume.
- [ ] Honesty tooltips remain untranslated English while the rest of the dashboard uses
      `react-i18next`. Consistent with existing precedent; deliberate debt.
