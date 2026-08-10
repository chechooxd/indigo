# String Literal Escape Semantics Specification

## Purpose

Defines the escape-sequence set recognized inside `.indigo` string literals and requires the compiler to decode them, instead of storing the raw slice with backslashes intact (the current `slice(1, -1)` behavior).

## Requirements

### Requirement: Recognized escape sequences are decoded

The compiler MUST decode `\\`, `\"`, `\n`, `\r`, and `\t` inside string literals (attribute string values and `TableGroup` quoted names) into their represented character before the value reaches the AST.

#### Scenario: Escaped quote decodes correctly

- GIVEN `@note("say \"hi\"")`
- WHEN the schema is parsed
- THEN the resolved note value is `say "hi"` (literal double quotes, no backslashes)

#### Scenario: Escaped backslash decodes to one backslash

- GIVEN `@note("a \\ b")`
- WHEN the schema is parsed
- THEN the resolved note value contains a single backslash between "a" and "b"

#### Scenario: Newline, carriage return and tab escapes decode

- GIVEN `@note("line1\nline2\ttab")`
- WHEN the schema is parsed
- THEN the resolved note value contains an actual newline and tab character, not the two-character backslash sequences

### Requirement: Unknown escape sequences are a diagnostic

An escape sequence outside `\\`, `\"`, `\n`, `\r`, `\t` (e.g. `\q`) MUST produce a diagnostic naming the invalid sequence, with a 1-based line/column, and MUST NOT be passed through as a literal two-character sequence.

#### Scenario: Unknown escape sequence rejected

- GIVEN `@note("bad \q escape")`
- WHEN the schema is parsed
- THEN a diagnostic is produced naming `\q` as an invalid escape sequence, with a valid 1-based line and column

### Requirement: Regression suites reflect corrected unescaping

The Rust test `quirk_strings_are_not_unescaped` in `crates/indigo-compiler/tests/fixtures.rs` MUST be inverted to assert that escape sequences ARE decoded, and `fixtures/snapshots/03-quirks-values.json` MUST be regenerated so its frozen `@note("say \"hi\" \\ done")` value (on `Widget.label`) reflects the decoded string.

#### Scenario: Inverted Rust test

- GIVEN the source `Table T { f String @note("say \"hi\"") }`
- WHEN parsed and serialized
- THEN the resulting JSON contains the decoded value `say "hi"`, not the raw escaped slice

#### Scenario: Regenerated golden snapshot

- GIVEN `fixtures/03-quirks-values.indigo`'s `@note("say \"hi\" \\ done")` on `Widget.label`
- WHEN `node packages/compiler/test/regen-snapshots.mjs` is run after the fix
- THEN `fixtures/snapshots/03-quirks-values.json` records the decoded note value, and the diff against the prior snapshot is the reviewed, intentional contract change
