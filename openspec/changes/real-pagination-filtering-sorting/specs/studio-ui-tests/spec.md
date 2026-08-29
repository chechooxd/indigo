# Delta for Studio UI Tests

## ADDED Requirements

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
