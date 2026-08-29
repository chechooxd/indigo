# Delta for Studio UI Honesty

## MODIFIED Requirements

### Requirement: Filter and Sort operate on real, already-loaded data, and sort is honestly disabled once pagination is real

Filter Columns MUST perform an observable, real transformation of the records already loaded
client-side; it MUST NOT fall back to a placeholder alert. The per-column Sort Grid control
MUST be disabled with a stated reason rather than offered, because once real server-side
pagination exists, a client-side sort would only reorder the currently loaded page and would
misrepresent itself as a full-table sort.
(Previously: Sort Grid was required to actually reorder loaded rows ascending/descending/
unsorted on repeated header clicks; that requirement is replaced because real pagination
makes any client-only sort control misleading.)

#### Scenario: Filter Columns hides a column

- GIVEN the active table has columns `id, email, role`
- WHEN the user toggles `role` off in Filter Columns
- THEN the `role` header and every row's `role` cell are no longer rendered
- AND toggling it back on restores them

#### Scenario: Sort Grid control is disabled with a stated reason

- GIVEN the active table has multiple rows and real pagination is in effect
- WHEN the user inspects or clicks a column header's sort control
- THEN the control is disabled, carries a tooltip explaining full-table sort is not available
  because sorting only the loaded page would be misleading
- AND clicking it does not change row order

### Requirement: The pager reflects real, bidirectional, server-backed pagination

The data browser MUST offer a real prev/next pager backed by the keyset cursor pagination
contract, plus a page-size selector (25/50/100/200, default 100). The footer MUST show the
exact total row count alongside the loaded page's row count (e.g. "Showing 100 of 4,231
rows"), never an inflated or page-only count. For a PK-less table, the pager MUST be absent
and replaced by an explicit notice explaining the table cannot be paginated stably.
(Previously: the pager was required to be removed entirely, since no real chunking existed;
this requirement replaces that removal now that real cursor pagination exists.)

#### Scenario: Prev/next pager traverses real pages

- GIVEN a table with more rows than one page
- WHEN the user clicks "Next", then "Previous"
- THEN the grid shows the next page's rows, then returns to the original page's rows

#### Scenario: Boundary controls are disabled correctly

- GIVEN the user is on the first page
- WHEN the footer renders
- THEN "Previous" is disabled, and separately, on the last page "Next" is disabled

#### Scenario: Page-size selection changes the fetched page

- GIVEN the user selects a page size of 25
- WHEN the grid refetches
- THEN it requests and renders at most 25 rows, and the footer's total count is unchanged

#### Scenario: PK-less table shows an explicit notice instead of a pager

- GIVEN the active table has no primary key
- WHEN the data browser renders its footer
- THEN no prev/next pager is shown
- AND a visible notice states the table cannot be paginated stably because it has no primary
  key
