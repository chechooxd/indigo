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
(Previously: scenarios named only the ERD designer's copy-code control; docs-view scenarios
for the Copy Schema control are added below.)

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

#### Scenario: Copying the docs-view schema DDL shows inline confirmation and clears
- GIVEN the docs view renders the Copy Schema control for a table's DDL
- WHEN the user clicks Copy Schema and `navigator.clipboard.writeText` resolves successfully
- THEN the control shows a transient inline "Copied" confirmation
- AND no `alert()` or dialog fires
- AND the confirmation reverts to the default state after a short delay without user action

#### Scenario: A rejected clipboard write on Copy Schema shows no dialog and no false confirmation
- GIVEN the docs view renders the Copy Schema control
- WHEN the user clicks Copy Schema and `navigator.clipboard.writeText` rejects
- THEN no `alert()` or dialog fires
- AND the control does not show the "Copied" confirmation state

#### Scenario: Copy Schema writes the active table's real DDL text
- GIVEN the docs view is showing table `orders` with its generated DDL
- WHEN the user clicks Copy Schema
- THEN `navigator.clipboard.writeText` is called with the exact DDL text currently rendered
  for `orders`, not a placeholder or another table's DDL

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

### Requirement: Docs-view DDL never fabricates schema data
The docs surface's rendered DDL (`generateTableDDL`) MUST NOT present any index, index
property, or primary-key reference that does not exist in the resolved schema's IR. This
closes the gap between this spec's Purpose line — which names "docs" as a covered surface —
and its Requirements, which previously specified nothing for that surface.

#### Scenario: A table with zero indexes shows no fabricated index
- GIVEN a table with no `@@index` or `@@unique` declarations, so its resolved `indexes` is `[]`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL contains zero `CREATE INDEX` statements and zero occurrences of `idx_`

#### Scenario: A table with a real index shows exactly that index
- GIVEN a table declaring `@@index([authorId, createdAt])`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL contains one `CREATE INDEX` statement over `(authorId, createdAt)`
  in that column order, and no other index statement

#### Scenario: Primary-key reference matches the declared schema
- GIVEN a table whose primary key is `uuid`, not `id`, and the schema declares no column
  named `id`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL marks `uuid` as the primary key and contains no reference to a
  column named `id`

### Requirement: UI copy never claims a capability or data the product does not have
The Studio docs view MUST NOT render static copy, metrics, or actions that describe a
capability, feature, or data source the product does not actually have. Text describing a
table or column MUST be either a factual statement about the schema or an honest marker of
absence; it MUST NOT invent unrelated capabilities, present the absence of documentation as
if it were documentation, display a metric with no real backing data source, or offer an
action with no real destination.

#### Scenario: The banner keeps its factual sentence and drops the fabricated one
- GIVEN the docs view renders `TableHeroBanner` for a table
- WHEN the banner text is inspected
- THEN it shows the factual first sentence describing the table's metadata specifications
- AND it contains no sentence mentioning "cluster branches" or any other invented feature

#### Scenario: An undocumented column shows an honest absence marker, not generic prose
- GIVEN a table column has no `@note` annotation, so its resolved `note` is undefined
- WHEN the docs view renders that column's row in `ColumnsSpecTable`
- THEN the description cell renders a muted em dash (`—`)
- AND the cell carries an accessible label read by assistive tech as "No description"
- AND no generic fallback sentence (e.g. "Database engine system column value.") is rendered

#### Scenario: A documented column renders its real note verbatim
- GIVEN a table column declares `@note("Primary contact email for the account")`
- WHEN the docs view renders that column's row in `ColumnsSpecTable`
- THEN the description cell shows the note text verbatim
- AND it does not show the em dash or the "No description" label

#### Scenario: A table with mixed documented and undocumented columns renders each correctly
- GIVEN a table has three columns: one with `@note("Unique identifier")`, one with no `@note`,
  and one with `@note("Soft-delete timestamp")`
- WHEN the docs view renders `ColumnsSpecTable` for that table
- THEN the first and third rows show their respective note text verbatim
- AND the second row shows the muted em dash with the "No description" accessible label

#### Scenario: No fabricated live-row metric is shown for any table
- GIVEN the docs view renders `RelationsPanel` and `DocBrowserPage` for any table, connected
  or not
- WHEN the rendered output is inspected
- THEN no "live rows" text or record-count metric is present anywhere in that surface

#### Scenario: No share or reference-link action is offered
- GIVEN the docs view renders a table's action controls
- WHEN the user inspects the available controls
- THEN no "Share Reference" (or equivalent share/reference-link) button is present
- AND no control copies a URL fragment that the app cannot read back on load
