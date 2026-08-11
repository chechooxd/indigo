# Compiler Corpus Coverage Specification

## Purpose

Defines what the `.indigo` compiler's golden-snapshot fixture corpus
(`fixtures/*.indigo`, `fixtures/errors/*.indigo`) MUST exercise, and how a
fixture pins parsed AST, `ResolvedSchema`, and `ValidationError[]` output as
regression evidence. This capability governs test-coverage breadth only — it
does not change parser, resolver, or validator behavior.

## Requirements

### Requirement: Scalar type coverage

Every scalar type in `SCALAR_TYPES` MUST appear as a field type in at least
one fixture under `fixtures/`.

#### Scenario: BigInt and Bytes are exercised

- GIVEN the fixture corpus
- WHEN scanning all `fixtures/*.indigo` files for field type usage
- THEN `BigInt` and `Bytes` each appear on at least one field
- AND the fixture's golden snapshot records the resulting `ResolvedSchema` column type

### Requirement: Referential action coverage

Every referential action in `REFERENTIAL_ACTIONS` MUST appear in at least one
fixture's `@relation(onDelete: ...)` or `onUpdate: ...` argument, and the
corresponding emitted DDL fragment MUST be present in that fixture's golden
snapshot (not merely parsed into AST).

#### Scenario: All five actions reach DDL

- GIVEN a fixture using `Cascade`, `Restrict`, `SetNull`, `SetDefault`, and `NoAction`
- WHEN the fixture is resolved and its snapshot regenerated
- THEN the `resolved` snapshot section shows each action's SQL-ready form (`CASCADE`, `RESTRICT`, `SET NULL`, `SET DEFAULT`, `NO ACTION`)

### Requirement: Rejected-attribute validation fixtures

`@@id([a,b])` (composite primary key), `@updatedAt`, and `@@ignore` MUST each
have a dedicated fixture that parses without error but produces a non-empty
`ValidationError[]`, pinning the exact rejection message as a golden
snapshot rather than only an inline `cargo test` string.

#### Scenario: Composite @@id is rejected with a pinned message

- GIVEN a fixture using `@@id([a, b])` on a model
- WHEN the fixture is parsed and validated
- THEN parsing succeeds
- AND the snapshot's `validation` section contains the exact rejection message for that attribute, unchanged from the existing `cargo test` assertion

#### Scenario: @updatedAt and @@ignore are each rejected with pinned messages

- GIVEN separate fixtures using `@updatedAt` and `@@ignore`
- WHEN each fixture is parsed and validated
- THEN each snapshot's `validation` section contains that attribute's exact rejection message

### Requirement: Self-relation coverage

A model relating to itself (e.g., a field on `Table T` referencing `T`) MUST
appear in at least one fixture.

#### Scenario: Self-relation resolves correctly

- GIVEN `05-relations.indigo` does not currently contain a self-relation
- WHEN a self-relation fixture is added (new or appended to an existing fixture)
- THEN the fixture parses and resolves without unintended validation errors
- AND the snapshot records the self-referencing foreign key

### Requirement: Enum @map end-to-end coverage confirmed

Enum value `@map` MUST be covered end-to-end by an existing fixture; this
requirement is satisfied by verification, not new fixture creation, unless
verification finds a gap.

#### Scenario: Enum @map is already covered

- GIVEN `03-quirks-values.indigo`
- WHEN checked for an enum value using `@map(...)`
- THEN the mapping is present and reflected in the `resolved` snapshot
- AND no duplicate fixture is created for this case

### Requirement: New fixtures are pinned in the expected-message test

Every new top-level valid fixture added under `fixtures/` MUST have a
corresponding entry in `crates/indigo-compiler/tests/fixtures.rs`'s
expected-message table (the test currently named
`corpus_validation_errors_are_unchanged_by_new_rules`, or its exact current
name if renamed), listing that fixture's exact expected `ValidationError[]`
messages (an empty list if none).

#### Scenario: Missing entry fails the test suite

- GIVEN a new top-level valid fixture is added without an entry in the expected-message table
- WHEN `cargo test` runs
- THEN the test fails, because the fixture's validation errors are not accounted for

#### Scenario: Complete entry keeps the test green

- GIVEN every new top-level valid fixture has a matching expected-message entry
- WHEN `cargo test` runs
- THEN `corpus_validation_errors_are_unchanged_by_new_rules` (or its current name) passes
- AND the original 5 fixtures' expected messages remain byte-identical to their current values
