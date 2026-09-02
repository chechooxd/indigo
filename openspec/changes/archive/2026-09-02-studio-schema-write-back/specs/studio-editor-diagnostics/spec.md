# Delta for Studio Editor Diagnostics

## ADDED Requirements

### Requirement: Parse errors produce exact-position Monaco markers

When `parse(dslCode)` throws an `IndigoParseError`, `useERDParser` MUST map
every entry of `errors: ParseErrorDetail[]` to a Monaco marker positioned at
that entry's 1-based `line`/`column`/`endLine`/`endColumn`, rather than
swallowing the error into `console.warn`. Markers MUST be cleared and
replaced (not accumulated) on each re-parse.

#### Scenario: A syntax error produces a marker at the exact reported position

- GIVEN a `.indigo` buffer with a single syntax error whose
  `ParseErrorDetail` reports `line: 4, column: 3, endLine: 4, endColumn: 9`
- WHEN the editor's parse hook runs
- THEN exactly one Monaco marker is created at line 4, spanning columns 3–9
- AND no `console.warn` is the only observable trace of the error — the
  marker is present in the editor's model

#### Scenario: Fixing the error clears its marker

- GIVEN a marker is showing for a syntax error
- WHEN the user edits the buffer to fix that error and the buffer re-parses
  successfully
- THEN the previously shown marker is removed, not merely superseded

### Requirement: Validation errors surface as a labelled panel entry with zero fabricated markers

When `resolve(parse(dslCode))` throws (a `ValidationError`-shaped failure
carrying only `{message, model?, field?}` with no position data), the system
MUST record it as a diagnostics-panel entry labelled to indicate no source
location is available, and MUST create zero Monaco markers for it. The
system MUST NOT infer a position by text-searching the buffer for the
`model`/`field` name, and MUST NOT anchor a marker at line 1 (or any other
guessed line) as a substitute for a real position. A marker at a guessed
location is a fabricated fact and is explicitly disallowed; the panel entry
existing without a marker is the correct, honest degradation, not a
follow-up gap.

#### Scenario: A validation error produces a panel entry, not a marker

- GIVEN a buffer that parses successfully but fails `resolve` (e.g. two
  models with the same name)
- WHEN the editor's diagnostics hook runs
- THEN the diagnostics panel shows exactly one entry for this error, labelled
  as having no source location
- AND zero Monaco markers are created in the editor model

#### Scenario: No marker is fabricated at line 1 or via name search

- GIVEN a validation error naming a specific `model` value
- WHEN the diagnostics hook processes it
- THEN no marker appears anywhere in the editor, including not at line 1 and
  not at any line where the named model happens to appear in the buffer text

### Requirement: A failed parse no longer looks like a frozen diagram

`useERDParser`'s prior `console.warn('ERD Parse error', e)` fallback MUST be
replaced by diagnostics state shared between the editor and the ERD canvas,
so that a parse or validation failure is visibly reported rather than
presenting as the diagram silently ceasing to update with no on-screen
explanation.

#### Scenario: A parse failure is visible on screen, not only in the console

- GIVEN the user introduces a syntax error into the buffer
- WHEN the ERD canvas would otherwise stop updating
- THEN the diagnostics panel and/or editor markers visibly report the
  failure, and this is observable without opening the browser console
</content>
