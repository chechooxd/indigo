# Studio UI Honesty Specification

## Purpose

The Studio app (`apps/studio/src/`), across all surfaces — dashboard, query engine,
ERD designer, data browser, docs — MUST NOT present any control, label, or count that
claims an effect or capability it does not actually have. Every visible action either
performs a real operation, is disabled with a stated reason, or (if a real destination
exists) performs real navigation instead of a fabricated dialog. Mock/sample data is
always visibly distinguishable from a real connected session.

## Requirements

### Requirement: No fake-success or fake-progress alerts
The system MUST NOT call `alert()` (or any dialog) to claim a simulated action succeeded or
is "in progress" when no corresponding real operation occurred.

#### Scenario: Refresh button triggers a real refetch or is honestly inert
- GIVEN the data browser is showing a table and a backend is available
- WHEN the user clicks "Refresh"
- THEN the system re-invokes `fetchTableRows` for the active table and updates the grid
- AND no `alert()` is shown

#### Scenario: Refresh with no backend
- GIVEN no backend is available (`isBackendAvailable()` is false)
- WHEN the user clicks "Refresh"
- THEN the control is disabled or otherwise causes no state change and no `alert()`

#### Scenario: Save Changes wording matches what happened
- GIVEN the user edits a record and clicks "Save"
- WHEN the write action is disabled (no backend can persist it)
- THEN no confirmation implying persistence is shown, and the control carries a tooltip
  explaining edits are not saved

### Requirement: Filter and Sort operate on real, already-loaded data
Filter Columns and Sort Grid MUST perform an observable, real transformation of the records
already loaded client-side; neither may fall back to a placeholder alert.

#### Scenario: Filter Columns hides a column
- GIVEN the active table has columns `id, email, role`
- WHEN the user toggles `role` off in Filter Columns
- THEN the `role` header and every row's `role` cell are no longer rendered
- AND toggling it back on restores them

#### Scenario: Sort Grid changes row order
- GIVEN the active table has multiple rows with distinct values in `email`
- WHEN the user clicks the `email` column header once
- THEN rows render in ascending order by `email`
- AND clicking again renders descending order
- AND clicking a third time restores the original (unsorted) order

### Requirement: Displayed record count reflects real loaded data
The system MUST NOT display a record count larger than the number of rows actually loaded
for that table.

#### Scenario: Mock `users` table shows its real count
- GIVEN the mock `users` table has 4 seeded rows and no backend is available
- WHEN the sidebar and footer render the record count
- THEN both show `4`, not any inflated placeholder value

### Requirement: Unavailable write actions are disabled with a stated reason
Add Record and Save Changes MUST be enabled when a real backend write path exists to
persist the result, and MUST remain disabled (not merely relabeled) with a stated reason
whenever no such backend is available. Delete MUST additionally require Safe Updates to
be disabled and explicit confirmation, per `studio-write-guards`, independent of backend
availability. Create Table submit MUST remain disabled unconditionally in this change,
since no table-creation write endpoint exists yet.

#### Scenario: Add Record is enabled with a real backend
- GIVEN a real backend write path exists for the active table
- WHEN the user inspects "Add Record"
- THEN the control is enabled and, on submit, creates a row via the write path

#### Scenario: Add Record is disabled without a backend
- GIVEN no real backend write path exists
- WHEN the user inspects or clicks "Add Record"
- THEN the control is disabled, carries a tooltip stating row editing is unavailable,
  and no record is added to the store

#### Scenario: Save Changes reflects real backend availability
- GIVEN the user has edited a record
- WHEN no real backend write path exists
- THEN "Save Changes" is disabled with a tooltip explaining edits are not persisted
- AND when a real backend write path exists, "Save Changes" is enabled and persists
  the edit

#### Scenario: Create Table submit remains disabled
- GIVEN the Create Table modal is open with valid input
- WHEN the user attempts to submit
- THEN the submit control is disabled with the same stated reason and no table is
  pushed to the store

### Requirement: Sample-data indicator is always visible when data is not real
The system MUST render a persistent, non-dismissible visual indicator whenever
`isBackendAvailable()` is false, clearly distinguishing sample/mock data from a real
connected session.

#### Scenario: Standalone dev mode shows the indicator
- GIVEN the Studio runs with no backend reachable
- WHEN the data browser renders
- THEN a banner or badge stating the data is sample/mock data is visible
- AND it cannot be dismissed

#### Scenario: Connected session shows no indicator
- GIVEN a backend is reachable and `isBackendAvailable()` is true
- WHEN the data browser renders
- THEN the sample-data indicator is not shown

### Requirement: The pager reflects only data actually loaded
The two "Jump page" buttons MUST NOT imply the existence of additional rows beyond what is
already loaded client-side. Given the backend caps `/api/tables/:name` at 100 rows with no
offset support, and no client path currently loads more than one response, the pager MUST be
removed entirely rather than kept as fake or relabeled navigation. A future change may
reintroduce real client-side chunking if a code path starts loading more than one page's
worth of rows; this change does not add one.

#### Scenario: No pager is rendered
- GIVEN the data browser footer renders for any table
- WHEN the user inspects the footer
- THEN no "Jump page" control or page-number buttons are present
- AND the row count text describes only the rows actually loaded (e.g. "Showing N of N rows")

### Requirement: Unimplemented controls outside the data browser are disabled with a stated reason
The system MUST NOT call `alert()` (or any dialog) to claim a simulated action succeeded
when no corresponding real operation, backend endpoint, or feature exists, in the
dashboard, query engine, or ERD designer surfaces. Each such control MUST be disabled
and carry a `title`/tooltip stating why, following the `TableBrowserPage` pattern
(module-level reason constant, `disabled`, `title`).

#### Scenario: "Open CLI" is honestly disabled
- GIVEN the dashboard renders the "Open CLI" control
- WHEN the user inspects or clicks it
- THEN the control is disabled, carries a tooltip explaining a browser cannot open a
  local CLI connection, and no `alert()` fires

#### Scenario: Schema browser refresh is honestly disabled
- GIVEN the query engine's Schema Browser panel is rendered
- WHEN the user inspects or clicks the refresh button
- THEN the control is disabled, carries a tooltip explaining schema metadata refresh is
  not implemented, and no `alert()` fires

#### Scenario: ERD "History" is honestly disabled
- GIVEN the ERD designer toolbar is rendered
- WHEN the user inspects or clicks the "History" control
- THEN the control is disabled, carries a tooltip explaining no revision-history feature
  exists, and no `alert()` fires

### Requirement: "View all schemas" is disabled honestly when no dedicated destination exists
Dashboard actions that claim to navigate somewhere MUST either perform real navigation to
an existing route/tab, or — if no such destination exists in the app's navigation surface
— be disabled with a stated reason, never a fabricated confirmation dialog.

#### Scenario: "View all" has no real destination
- GIVEN the dashboard's Recent Schemas table already renders every schema the store holds
  (no truncation) and the app's navigation tabs (`home`, `editor`, `studio`, `docs`,
  `settings`) contain no dedicated "all schemas" view
- WHEN the user inspects or clicks "View all"
- THEN the control is disabled, carries a tooltip explaining the dashboard already shows
  every schema, and no `alert()` fires

### Requirement: Copy-to-clipboard actions give inline, non-blocking feedback
A control that copies text to the clipboard MUST perform the real clipboard write and
MUST NOT confirm it with a blocking dialog (`alert()` or similar). Confirmation MUST be
an inline, transient state on the control itself that clears automatically.

#### Scenario: Copying DSL code shows inline confirmation
- GIVEN the ERD designer editor pane is showing DSL code
- WHEN the user clicks the copy-code button
- THEN `navigator.clipboard.writeText` is called with the current DSL code
- AND the button shows a transient "Copied" state instead of any dialog
- AND no `alert()` fires
- AND the state reverts to the default icon after a short delay

#### Scenario: No untranslated copy in the fixed confirmation paths
- GIVEN the copy-code button and the four disabled controls above
- WHEN their tooltip text or inline feedback is inspected
- THEN all strings are in English, with no leftover Spanish text in those specific code
  paths

### Requirement: Live-view affordances are hidden, not disabled-with-a-lie, when they do not apply

The Table Browser's live status indicator MUST be hidden entirely — not shown disabled, not
shown stuck, and never erroring — whenever live refresh does not apply: no backend connected,
or the selected table is not `@@realtime`-eligible. This follows the existing Refresh-button
precedent of never claiming a capability the current context does not have.

#### Scenario: No live indicator for a non-realtime table

- GIVEN a backend is connected and the selected table is not `@@realtime`
- WHEN the Table Browser toolbar renders
- THEN no live status indicator is present

#### Scenario: No live indicator with no backend connected

- GIVEN no backend is connected (sample-data fallback)
- WHEN the Table Browser toolbar renders for any table
- THEN no live status indicator is present and no live-related error is shown
