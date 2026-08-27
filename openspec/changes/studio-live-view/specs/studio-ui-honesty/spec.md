# Delta for studio-ui-honesty

## ADDED Requirements

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
