# Studio UI Tests Specification

## Purpose

`apps/studio` currently has a Vitest test runner configured. This capability provides
component-test coverage — not a general testing framework rollout — scoped exactly to
proving the `studio-ui-honesty` requirements hold across all Studio surfaces (data browser,
dashboard, query engine, ERD designer), and to catching regressions of them.

## Requirements

### Requirement: A minimal, scoped test harness exists
The system MUST provide a working test runner in `apps/studio` capable of rendering React
components with jsdom and simulating user interaction, wired into `pnpm test` via Turborepo,
using Vitest + `@testing-library/react` + `jsdom` (or a justified equivalent already present
elsewhere in the monorepo). The harness MUST cover the data-browser components/hooks from
`studio-ui-honesty`, plus exactly these four honest-disabled-state targets: the dashboard's
`openCli` and `viewAllSchemas` actions, the query engine's `SchemaBrowserPanel` refresh
control, and the ERD designer's `History` control and `handleCopyCode` feedback. It MUST NOT
be used to justify a general component-testing rollout across other Studio areas (docs
browser, settings, etc.) beyond these named targets in this change.

#### Scenario: Test command runs the new suite
- GIVEN the harness is installed and configured
- WHEN `pnpm test` runs from the repo root
- THEN Turborepo invokes the `apps/studio` test task and it executes without configuration
  errors

### Requirement: Pagination UI coverage

The harness MUST cover the prev/next pager's boundary behavior, the page-size selector, the
PK-less-table notice, and the disabled sort control, each with a test that fails against the
pre-change (or fake-pager/live-sort) behavior and passes once real pagination lands.

#### Scenario: Prev/next pager test catches boundary regressions

- GIVEN a test renders `TableBrowserPage` with a mocked multi-page `fetchTableRows`
- WHEN it clicks "Next" then "Previous"
- THEN it asserts the grid shows the second page's rows then the original page's rows

#### Scenario: Boundary-disabled test

- GIVEN a test renders the browser on the first page
- WHEN it queries "Previous"
- THEN it asserts the control is disabled, and separately on the last page asserts "Next" is
  disabled

#### Scenario: Page-size selector test

- GIVEN a test renders the browser with the page-size selector
- WHEN it selects a different page size (e.g. 25)
- THEN it asserts `fetchTableRows` is called with that limit

#### Scenario: PK-less notice test

- GIVEN a test mocks a table response with `paginated: false`
- WHEN the footer renders
- THEN it asserts a visible notice explaining the table cannot be paginated, and asserts no
  prev/next pager is rendered

#### Scenario: Disabled sort control test catches a reintroduced live sort

- GIVEN a test renders the grid with sortable column headers
- WHEN it clicks a column header's sort control
- THEN it asserts the control is disabled with a tooltip and that row order does not change

### Requirement: Each honesty behavior has a scenario that fails before the fix and passes after
For every requirement in `studio-ui-honesty` — including the dashboard, query engine, and
ERD designer additions — at least one automated test MUST exist that would fail against the
pre-change code (alert-based stubs, fabricated confirmations) and passes against the fixed
implementation.

#### Scenario: Refresh test catches a reintroduced alert
- GIVEN a test renders `TableBrowserPage` with a mocked `fetchTableRows`
- WHEN the test clicks "Refresh" and asserts `window.alert` was not called and
  `fetchTableRows` was invoked
- THEN the test fails against the current `alert('Table browser refreshed.')` stub and passes
  once Refresh is wired to a real refetch

#### Scenario: Filter/Sort tests catch non-functional controls
- GIVEN a test renders the grid with known columns and rows
- WHEN it toggles a column off via Filter Columns and clicks a column header for Sort Grid
- THEN it asserts the hidden column's cells are absent and row order changed accordingly

#### Scenario: Record count test catches the fabricated value
- GIVEN a test renders the sidebar/footer with the seeded mock `users` table (4 rows)
- WHEN it reads the displayed count
- THEN it asserts the value is `4`, failing against the current `1,200,000` fabrication

#### Scenario: Write-action disabled test catches a regression to fake success
- GIVEN a test renders the table browser with no backend available
- WHEN it queries the "Add Record" and "Create Table" submit controls
- THEN it asserts both are disabled and carry the expected tooltip text, and that clicking a
  disabled control does not alter store state

#### Scenario: Sample-data indicator test catches silent fallback
- GIVEN a test mocks `isBackendAvailable()` to return false
- WHEN the data browser renders
- THEN it asserts a visible sample-data indicator element is present

#### Scenario: Pager removal test catches a reintroduced fake pager
- GIVEN a test renders the data browser footer
- WHEN it queries for pagination controls
- THEN it asserts none exist

#### Scenario: Dashboard actions test catches a reintroduced alert
- GIVEN a test renders `DashboardPage` (or `useDashboardActions` directly)
- WHEN it queries "Open CLI" and "View all" and clicks each
- THEN it asserts both are disabled with the expected tooltip, `window.alert` was never
  called, and no navigation or state change occurred

#### Scenario: Schema browser refresh test catches a reintroduced alert
- GIVEN a test renders `SchemaBrowserPanel`
- WHEN it queries the refresh button and clicks it
- THEN it asserts the button is disabled with the expected tooltip and `window.alert` was
  never called

#### Scenario: ERD History and copy-feedback tests catch regressions
- GIVEN a test renders `ERDDesignerPage`
- WHEN it queries "History" (asserting disabled, tooltip present, no `alert()`) and clicks
  the copy-code button
- THEN it asserts `navigator.clipboard.writeText` was called, an inline "Copied" state
  appears, and `window.alert` was never called

### Requirement: Schema-driven editor coverage

The harness MUST cover the generic edit buffer and per-type widget rendering from
`studio-record-editor`, and the confirmation-plus-Safe-Updates interaction from
`studio-write-guards`.

#### Scenario: Widget map test catches hardcoded fields

- GIVEN a test renders `RecordInspector` against a schema with no `email`/`role`/
  `metadata` columns
- WHEN it inspects the rendered fields
- THEN it asserts one widget per resolved column, keyed by column name, with no
  hardcoded field names present

#### Scenario: Per-type widget tests

- GIVEN a test schema with boolean, enum, `DateTime`, nullable, and JSON columns
- WHEN `RecordInspector` renders a row from it
- THEN it asserts a checkbox for boolean, a `<select>` with the enum's declared
  values, a date/time input for `DateTime`, an explicit null control for the
  nullable column, and a JSON textarea that rejects invalid JSON on save

#### Scenario: DELETE gate interaction test

- GIVEN a test renders the row delete control with Safe Updates enabled
- WHEN it confirms the delete dialog
- THEN it asserts no `DELETE` request was sent
- AND after disabling Safe Updates and confirming again, it asserts the request was
  sent exactly once
