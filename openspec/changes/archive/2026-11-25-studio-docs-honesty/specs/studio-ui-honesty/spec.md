# Delta for Studio UI Honesty

> Expected count after archive: 12 requirements (11 existing + 1 ADDED). The MODIFIED
> block below is the complete existing requirement plus new docs-view scenarios.

## ADDED Requirements

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

## MODIFIED Requirements

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
