# Tasks: studio-honest-disabled-stubs

Single commit, ~180-240 changed lines. Strict TDD: each RED task adds/extends a
failing test against current (stub) behavior; the paired GREEN task makes it pass
with no other behavior change. Existing `TableBrowserPage.test.tsx` and
`SampleDataBanner.test.tsx` must keep passing unchanged throughout.

Constants (exact English strings, from design):
- `CLI_DISABLED_TITLE = "Connecting to the CLI isn't available from the browser."`
- `VIEW_ALL_DISABLED_TITLE = 'All schemas are already listed here.'`
- `REFRESH_DISABLED_TITLE = 'Refresh needs a connected database — this build is showing sample data.'`
- `HISTORY_DISABLED_TITLE = "Revision history isn't available yet."`

## 1. Dashboard: honest-disable `openCli` and `viewAllSchemas`

Satisfies spec requirement "Unimplemented controls outside the data browser are
disabled with a stated reason" (CLI scenario) and "'View all schemas' is disabled
honestly when no dedicated destination exists".

- [x] 1.1 (RED) Create `apps/studio/src/features/dashboard/__tests__/DashboardPage.test.tsx`.
      Render `DashboardPage`, spy on `window.alert`. Assert the "Open CLI" button
      (`#btn-open-cli`) is `disabled` and has `title="Connecting to the CLI isn't
      available from the browser."`; assert the "View all" button
      (`t('dashboard.recent_schemas.view_all')` text) is `disabled` and has
      `title="All schemas are already listed here."`. Click both; assert
      `window.alert` was never called and no navigation occurred (mock
      `useNavigationStore`'s `navigate` and assert not called). This test MUST
      fail against current code (buttons are enabled, click fires `alert()`).
      [Sequential — depends on nothing]

- [x] 1.2 (GREEN) Edit `apps/studio/src/features/dashboard/hooks/useDashboardActions.ts`:
      delete the `openCli` and `viewAllSchemas` handler functions and their two
      members from `UseDashboardActionsReturn` and the returned object (per
      design: "fake handler deleted, not a no-op").
      [Sequential — after 1.1]

- [x] 1.3 (GREEN) Edit `apps/studio/src/features/dashboard/DashboardPage.tsx`:
      remove `openCli`/`viewAllSchemas` from the `useDashboardActions()`
      destructure; stop passing `onOpenCli={openCli}` to `WelcomeHero` and
      `onViewAll={viewAllSchemas}` to `RecentSchemasTable`.
      [Sequential — after 1.2]

- [x] 1.4 (GREEN) Edit `apps/studio/src/features/dashboard/components/WelcomeHero.tsx`:
      add module-level `const CLI_DISABLED_TITLE = "Connecting to the CLI isn't
      available from the browser.";`. Drop `onOpenCli` from
      `WelcomeHeroProps`/destructure. On the `#btn-open-cli` `Button`, remove
      `onClick={onOpenCli}` and add `disabled` + `title={CLI_DISABLED_TITLE}`.
      [Sequential — after 1.3]

- [x] 1.5 (GREEN) Edit `apps/studio/src/features/dashboard/components/RecentSchemasTable.tsx`:
      add module-level `const VIEW_ALL_DISABLED_TITLE = 'All schemas are already
      listed here.';`. Drop `onViewAll` from `RecentSchemasTableProps`/
      destructure. On the "view all" `<button>`, remove `onClick={onViewAll}`
      and add `disabled` + `title={VIEW_ALL_DISABLED_TITLE}`.
      [Sequential — after 1.4] Run 1.1's test → GREEN.

## 2. Query engine: extract `loadSchemaIntoStore`, gate SchemaBrowserPanel refresh

Satisfies spec requirement "Unimplemented controls outside the data browser are
disabled with a stated reason" (Schema browser refresh scenario) — resolved here
as a GATED REAL REFRESH per design decision 3/4.

- [x] 2.1 (RED) Create `apps/studio/src/features/studio/query/__tests__/SchemaBrowserPanel.test.tsx`.
      Render `SchemaBrowserPanel` directly with stub props (`tables: []`,
      `selectedTable: ''`, `onSelectTable: vi.fn()`, `canRefresh: false`,
      `onRefresh: vi.fn()`). Spy `window.alert`. Assert the refresh button is
      `disabled` and has `title="Refresh needs a connected database — this
      build is showing sample data."`; click it, assert `window.alert` was
      never called and `onRefresh` was not invoked. Second case: re-render with
      `canRefresh: true`; assert the button is enabled and has no disabled
      `title`; click it, assert `onRefresh` was invoked. This test MUST fail
      against current code (no `canRefresh`/`onRefresh` props exist yet; button
      calls `alert()`).
      [Sequential — depends on nothing; can run in parallel with task 1's RED]

- [x] 2.2 (GREEN) Create `apps/studio/src/lib/schema-loader.ts` exporting
      `export async function loadSchemaIntoStore(store: { setTables: (t) =>
      void; setResolvedSchema: (r) => void }): Promise<void>` (or equivalent
      typed against `useDataStore`'s shape) that calls `fetchSchema()` from
      `../lib/api`, and on a non-empty result calls `resolvedToTables` +
      `setResolvedSchema`/`setTables`, matching the exact logic currently
      inlined in `useSchemaBootstrap.ts`.
      [Sequential — after 2.1, before 2.3]

- [x] 2.3 (GREEN) Edit `apps/studio/src/app/hooks/useSchemaBootstrap.ts` to
      delegate its effect body to `loadSchemaIntoStore` from the new
      `lib/schema-loader.ts`, preserving existing behavior (no test currently
      covers this hook directly; do not regress `App.tsx` usage).
      [Sequential — after 2.2]

- [x] 2.4 (GREEN) Edit `apps/studio/src/features/studio/query/components/SchemaBrowserPanel.tsx`:
      add module-level `const REFRESH_DISABLED_TITLE = 'Refresh needs a
      connected database — this build is showing sample data.';`. Add
      `canRefresh: boolean` and `onRefresh: () => Promise<void>` to
      `SchemaBrowserPanelProps` and the destructure. Replace
      `onClick={() => alert('Schema metadata refreshed.')}` with
      `onClick={onRefresh}`, and add `disabled={!canRefresh}` +
      `title={!canRefresh ? REFRESH_DISABLED_TITLE : undefined}` (mirroring the
      `TableBrowserPage` pattern).
      [Sequential — after 2.3]

- [x] 2.5 (GREEN) Edit `apps/studio/src/features/studio/query/QueryEnginePage.tsx`:
      import `isBackendAvailable` and `loadSchemaIntoStore`; pass
      `canRefresh={isBackendAvailable()}` and `onRefresh={() =>
      loadSchemaIntoStore(useDataStore.getState())}` (or the store's
      setters via the existing `useDataStore()` destructure) to
      `<SchemaBrowserPanel />`.
      [Sequential — after 2.4] Run 2.1's test → GREEN.

## 3. ERD designer: extract `DslEditorToolbar`, honest History, inline copy feedback, English layout titles

Satisfies spec requirements "Unimplemented controls outside the data browser are
disabled with a stated reason" (History scenario), "Copy-to-clipboard actions
give inline, non-blocking feedback", and "No untranslated copy in the fixed
confirmation paths" (plus the folded-in layout-toggle Spanish→English fix).

- [x] 3.1 (RED) Create `apps/studio/src/features/erd/__tests__/DslEditorToolbar.test.tsx`.
      Render `DslEditorToolbar` directly with a stub `dslCode` prop. Spy
      `window.alert`; mock `navigator.clipboard.writeText` (resolves). Assert
      the "History" button is `disabled` and has `title="Revision history
      isn't available yet."`; click it, assert `window.alert` was never
      called. Using `vi.useFakeTimers()`, click the copy button; assert
      `navigator.clipboard.writeText` was called with `dslCode`; assert an
      inline "Copied" state/icon appears (e.g. accessible label or text
      change); advance timers past 1500ms; assert it reverts to the default
      icon state. This test MUST fail (component does not exist yet).
      [Sequential — depends on nothing; can run in parallel with tasks 1/2 RED]

- [x] 3.2 (GREEN) Create `apps/studio/src/features/erd/components/DslEditorToolbar.tsx`:
      module-level `const HISTORY_DISABLED_TITLE = "Revision history isn't
      available yet.";`. Props: `{ dslCode: string }`. Owns `const [copied,
      setCopied] = useState(false)` and a `useEffect` cleanup for the
      `setTimeout(1500)`. `handleCopyCode` calls
      `navigator.clipboard.writeText(dslCode)`, and only on promise
      **resolution** sets `copied` true and schedules the revert — no
      `alert()`. Renders the copy `<button>` (icon flips to a check/"Copied"
      indicator while `copied`) and the History `<button disabled
      title={HISTORY_DISABLED_TITLE}>` with its `onClick` (the
      `alert('Loading script backup history...')`) removed.
      [Sequential — after 3.1]

- [x] 3.3 (GREEN) Edit `apps/studio/src/features/erd/ERDDesignerPage.tsx`:
      remove `handleCopyCode`, the inline copy `<button>`, and the History
      `<button>` from the toolbar markup (lines ~114-129); render
      `<DslEditorToolbar dslCode={dslCode} />` in their place. Remove now-
      unused `Copy`/`History` imports from `lucide-react` if no longer
      referenced elsewhere in the file.
      [Sequential — after 3.2] Run 3.1's test → GREEN.

- [x] 3.4 (GREEN, no paired test — plain string literal fix) In the same file,
      translate the three layout-toggle button `title` attributes to English:
      `"Solo editor"` → `"Editor only"`, `"Dividir vista"` → `"Split view"`,
      `"Solo lienzo"` → `"Canvas only"` (lines ~85, 92, 99).
      [Sequential — after 3.3, can be folded into the same edit pass as 3.3]

## 4. Verification

- [x] 4.1 Run `pnpm --filter @indigodb/studio test` (or `pnpm test` from root)
      and confirm all new and existing suites pass, including unchanged
      `TableBrowserPage.test.tsx` and `SampleDataBanner.test.tsx`.
      [Sequential — after all of 1-3]
- [x] 4.2 Run `pnpm lint` (typecheck) across the workspace; fix any type
      errors from the prop/interface changes (`WelcomeHeroProps`,
      `RecentSchemasTableProps`, `SchemaBrowserPanelProps`,
      `UseDashboardActionsReturn`).
      [Sequential — after 4.1]
- [x] 4.3 Grep the touched files for any remaining non-ASCII/Spanish string
      literals to confirm the proposal's "no Spanish string remains in shipped
      Studio UI copy" success criterion is met for this change's scope.
      [Sequential — after 4.2]

## Parallelization summary

- The three RED test-authoring tasks (1.1, 2.1, 3.1) are independent of each
  other and may be written in parallel; each blocks only its own GREEN chain.
- Within each numbered section, GREEN tasks are strictly sequential (each
  edits state the next task depends on).
- Section 4 (verification) is sequential and depends on all of sections 1-3
  being complete, since `pnpm lint`/`pnpm test` run across the whole app.
