# Studio UI Honesty Specification

## Purpose

The Studio data browser (`apps/studio/src/features/studio/browser/`) MUST NOT present any
control, label, or count that claims an effect or capability it does not actually have.
Every visible action either performs a real operation on the data already available to the
UI, or is disabled with a stated reason. Mock/sample data is always visibly distinguishable
from a real connected session.

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
Add Record, Save Changes, Discard, and Create Table submit MUST be disabled (not merely
relabeled) whenever no real backend write path exists to persist the result, which is true
unconditionally in this change since no write endpoint exists yet.

#### Scenario: Add Record is disabled
- GIVEN the table browser is rendered
- WHEN the user inspects or clicks "Add Record"
- THEN the control is disabled, carries a `title`/tooltip reading "Row editing isn't available
  yet — this build is read-only.", and no record is added to the store

#### Scenario: Create Table submit is disabled
- GIVEN the Create Table modal is open with valid input
- WHEN the user attempts to submit
- THEN the submit control is disabled with the same stated reason and no table is pushed to
  the store

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
