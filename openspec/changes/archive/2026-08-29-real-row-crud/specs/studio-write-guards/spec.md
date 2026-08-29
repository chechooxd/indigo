# Studio Write Guards Specification

## Purpose

Destructive row deletion is gated behind two independent controls that must both be
satisfied: an explicit confirmation dialog, and the "Safe Updates" setting toggle wired
as a real, functioning gate.

## Requirements

### Requirement: DELETE requires an explicit confirmation dialog
The system MUST show a confirmation dialog before sending a `DELETE` request for any
row, and MUST NOT send the request unless the user explicitly confirms.

#### Scenario: Declining confirmation sends no request
- GIVEN the user clicks a delete control for a row
- WHEN the confirmation dialog appears and the user declines/cancels
- THEN no `DELETE` request is sent and the row remains

### Requirement: "Safe Updates" toggle gates DELETE
The "Safe Updates" setting MUST function as a real gate: when enabled, DELETE requests
MUST be blocked client-side (not sent) regardless of confirmation. The toggle MUST
default to off and MUST be session-local (not persisted across sessions).

#### Scenario: DELETE blocked while Safe Updates is enabled
- GIVEN "Safe Updates" is enabled
- WHEN the user confirms deletion of a row
- THEN no `DELETE` request is sent
- AND the UI communicates that Safe Updates is preventing the action

#### Scenario: Safe Updates resets to off on a new session
- GIVEN a prior session had "Safe Updates" enabled
- WHEN the app is reloaded as a new session
- THEN "Safe Updates" is off by default

### Requirement: Confirmation and Safe Updates are both required, not either/or
DELETE MUST proceed only when confirmation is granted AND Safe Updates is disabled.
Satisfying only one of the two conditions MUST NOT be sufficient.

#### Scenario: Confirmed but Safe Updates on still blocks
- GIVEN Safe Updates is enabled
- WHEN the user confirms the delete dialog
- THEN the `DELETE` request is still not sent

#### Scenario: Safe Updates off but confirmation declined still blocks
- GIVEN Safe Updates is disabled
- WHEN the user opens the delete confirmation dialog and cancels
- THEN the `DELETE` request is not sent

#### Scenario: Both conditions satisfied allows the request
- GIVEN Safe Updates is disabled
- WHEN the user confirms the delete dialog
- THEN the `DELETE` request is sent for that row's primary key
</content>
