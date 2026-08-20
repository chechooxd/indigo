# Delta for studio-ui-honesty

## MODIFIED Purpose

(Previously: scoped only to `apps/studio/src/features/studio/browser/`, the data browser.)

The Studio app (`apps/studio/src/`), across all surfaces — dashboard, query engine,
ERD designer, data browser, docs — MUST NOT present any control, label, or count that
claims an effect or capability it does not actually have. Every visible action either
performs a real operation, is disabled with a stated reason, or (if a real destination
exists) performs real navigation instead of a fabricated dialog. Mock/sample data is
always visibly distinguishable from a real connected session.

## ADDED Requirements

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
