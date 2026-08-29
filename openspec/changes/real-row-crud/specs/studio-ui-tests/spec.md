# Delta for Studio UI Tests

## ADDED Requirements

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
</content>
