# Studio UI Tests Specification

## Purpose

`apps/studio` currently has zero tests and no test runner configured. This capability
establishes a minimal component-test harness — not a general testing framework rollout —
scoped exactly to proving the `studio-ui-honesty` requirements above hold, and to catching
regressions of them.

## Requirements

### Requirement: A minimal, scoped test harness exists
The system MUST provide a working test runner in `apps/studio` capable of rendering React
components with jsdom and simulating user interaction, wired into `pnpm test` via Turborepo,
using Vitest + `@testing-library/react` + `jsdom` (or a justified equivalent already present
elsewhere in the monorepo). The harness MUST be scoped to the data-browser components and
hooks covered by `studio-ui-honesty`; it MUST NOT be used to justify a broader
component-testing rollout across other Studio areas (ERD editor, docs browser, etc.) in this
change.

#### Scenario: Test command runs the new suite
- GIVEN the harness is installed and configured
- WHEN `pnpm test` runs from the repo root
- THEN Turborepo invokes the `apps/studio` test task and it executes without configuration
  errors

### Requirement: Each honesty behavior has a scenario that fails before the fix and passes after
For every requirement in `studio-ui-honesty`, at least one automated test MUST exist that
would fail against the pre-change code (alert-based stubs, fabricated count, enabled writes,
missing indicator, fake pager) and passes against the fixed implementation.

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
