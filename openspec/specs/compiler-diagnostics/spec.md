# Compiler Diagnostics Specification

## Purpose

Ensures a lexer error does not suppress parser diagnostics within the same compilation pass, that lexer/parser diagnostics carry 1-based line/column positions, and that the committed WASM artifact stays consistent with `crates/` source.

## Requirements

### Requirement: Lexer errors no longer short-circuit parsing

The compiler MUST run the parser over the token stream produced by the lexer even when the lexer reported one or more illegal-character errors, and MUST return both the lexer errors and any parser errors found in the same pass, instead of returning only the lexer errors.

#### Scenario: One illegal character plus one syntax error, same file

- GIVEN a `.indigo` file containing exactly one illegal character (e.g. `~`) on one line, and a separate, unrelated syntax error (e.g. a missing `}`) elsewhere in the file
- WHEN the file is parsed
- THEN the returned error list contains both the illegal-character diagnostic and the syntax-error diagnostic

#### Scenario: Illegal character alone still reports correctly

- GIVEN a file with only an illegal character and no other syntax error
- WHEN the file is parsed
- THEN the returned error list contains exactly the illegal-character diagnostic(s), each with a valid 1-based line and column, and parsing does not additionally fail

### Requirement: Lexer and parser diagnostics carry 1-based line/column

Every lexer and parser diagnostic MUST include a 1-based `line` and `column`. This is the achievable positional ceiling today: `ValidationError` (semantic diagnostics from attribute, relation, referential-action and datasource validation) has no source-span field and remains positionless, since AST nodes carry no spans — extending spans to `ValidationError` is out of scope for this change.

#### Scenario: Parser error position

- GIVEN a file missing a closing `}` on a `Table` block
- WHEN the file is parsed
- THEN the reported error's `line` and `column` point at the location where parsing failed, both `>= 1`

#### Scenario: Semantic diagnostics remain positionless

- GIVEN a schema with an unrecognized attribute (an `attribute-validation` diagnostic)
- WHEN the schema is validated
- THEN the diagnostic identifies the model and field by name, and carries no `line`/`column`

### Requirement: The committed WASM artifact stays in sync with `crates/` source

After any change under `crates/indigo-compiler/src/`, the committed `packages/compiler/wasm/` artifact MUST be rebuilt (`pnpm --filter @indigodb/compiler build:wasm`) and both `cd crates && cargo test` and `pnpm test` MUST be GREEN against the rebuilt artifact before the change is considered complete.

#### Scenario: Rebuilt artifact passes both suites

- GIVEN source changes under `crates/indigo-compiler/src/` implementing this change's fixes
- WHEN `pnpm --filter @indigodb/compiler build:wasm` is run and its output is committed
- THEN `cd crates && cargo test` and `pnpm test` both pass against that same commit
