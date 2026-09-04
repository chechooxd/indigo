# Studio Record Editor Specification

## Purpose

The Record Inspector and its edit buffer become schema-driven: widgets and buffer keys
derive from the resolved schema's columns and types, not hardcoded field names.

## Requirements

### Requirement: Edit buffer is generic, keyed by column name
`useRecordEditor.ts` MUST hold a generic buffer keyed by each column's name, populated
from the resolved table's columns, rather than a fixed set of named string fields. Dirty
tracking MUST work per-column for any schema.

#### Scenario: Buffer adapts to an arbitrary schema
- GIVEN a resolved table with columns unrelated to `email`/`role`/`metadata`
- WHEN the Record Inspector opens a row from that table
- THEN the edit buffer contains one entry per column, keyed by column name
- AND editing any column marks only that column dirty

### Requirement: Widget selection is driven by `ResolvedColumn` type
The Record Inspector MUST render a type-appropriate widget per `ResolvedColumn`: a
checkbox for boolean, a `<select>` populated from `ResolvedEnum.values` for enum columns,
a date/time input for `DateTime`, a text/number input otherwise, and a textarea for JSON
columns.

#### Scenario: Enum column renders a select of its declared values
- GIVEN a column typed as an enum with values `A`, `B`, `C`
- WHEN the Record Inspector renders that field
- THEN a `<select>` (or equivalent) is shown with exactly those three options

#### Scenario: Boolean column renders a checkbox
- GIVEN a boolean column
- WHEN the Record Inspector renders that field
- THEN a checkbox reflects the current `true`/`false` value

#### Scenario: DateTime column renders a date/time widget
- GIVEN a `DateTime` column
- WHEN the Record Inspector renders that field
- THEN a date/time input is shown, and editing it produces a value the write path accepts

### Requirement: Nullable columns support an explicit null state
For a nullable column, the widget MUST expose an explicit way to set/unset null, distinct
from an empty string or zero value.

#### Scenario: Setting a nullable field to null round-trips
- GIVEN a nullable column currently holding a non-null value
- WHEN the user explicitly clears it to null and saves
- THEN the persisted value is `NULL`, not an empty string
- AND reopening the record shows the null state, not a fabricated default

### Requirement: JSON columns validate before submission
A JSON column's widget MUST parse its text content as JSON before it can be submitted,
and MUST surface a validation error without submitting when parsing fails.

#### Scenario: Invalid JSON blocks save
- GIVEN a JSON column's textarea contains invalid JSON
- WHEN the user attempts to save
- THEN the save is blocked, a validation error is shown, and no write request is sent

#### Scenario: Valid JSON round-trips
- GIVEN a JSON column's textarea contains a valid JSON object
- WHEN the user saves
- THEN the write request carries the parsed JSON value
- AND reopening the record shows the same JSON content

### Requirement: Generated/auto primary key fields are read-only
A primary key column identified as database-generated MUST render as read-only in the
editor and MUST NOT be included as an editable field on UPDATE.

#### Scenario: Generated primary key cannot be edited
- GIVEN a table with a database-generated primary key
- WHEN the Record Inspector renders that row
- THEN the primary key field is presented as read-only
- AND attempting to change it has no effect on the edit buffer
