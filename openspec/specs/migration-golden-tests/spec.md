# Migration Golden Tests Specification

## Purpose

Defines the golden fixture contract for `packages/migrator`, mirroring
`@indigodb/compiler`'s `parity.mjs` pattern, so every DDL-emitting (or
DDL-refusing) change class from this capability set is pinned by an
approved, reviewable expectation and `packages/migrator` is no longer
untested.

## Requirements

### Requirement: Each fixture is a schema pair with an approved expectation

A fixture MUST consist of a previous schema state (or none, for initial
creation), a next schema state, and one approved expected output: either the
exact ordered SQL statements/text produced by `diffResolved`/
`renderMigrationSql` (and, where applicable, `renderPushSql`), or the exact
diagnostic produced when the change is refused (ambiguous rename, enum value
removal, unguarded `NOT NULL`).

#### Scenario: Successful-DDL fixture

- GIVEN a schema-pair fixture with an approved expected SQL output
- WHEN the harness runs `diffResolved`/`renderMigrationSql` over the pair
- THEN the produced statements match the approved output exactly, or the harness fails and reports a diff

#### Scenario: Refusal fixture

- GIVEN a schema-pair fixture representing an ambiguous rename, an enum value removal, or an unguarded `NOT NULL` addition, with an approved expected diagnostic
- WHEN the harness runs the diff
- THEN the produced diagnostic matches the approved expectation, and no DDL is asserted for that change

### Requirement: The harness fails loudly on any divergence

The harness MUST compare produced output to the approved golden byte-for-byte
(or field-for-field for diagnostics) and MUST exit non-zero with a readable
diff on any mismatch. It MUST NOT silently accept a divergent result.

#### Scenario: Ordering regression

- GIVEN the FK-ordering fixture (`Post` declared before `User`)
- WHEN a future code change reintroduces out-of-order FK emission
- THEN the harness fails, reporting the expected vs. actual statement order

### Requirement: Golden regeneration is explicit and reviewable

Regenerating approved goldens MUST be a separate, explicit script invocation
(mirroring `regen-snapshots.mjs`), never an automatic side effect of running
the test suite. The diff between the previous and regenerated golden IS the
review artifact for an intentional contract change.

#### Scenario: Intentional output change

- GIVEN a deliberate change to emitted DDL for an existing fixture
- WHEN the regeneration script runs
- THEN the golden file is updated and the resulting diff is reviewed as part of the change

### Requirement: The suite is wired into the workspace test fan-out

`packages/migrator`'s `package.json` MUST define a `test` script that
Turborepo's `pnpm test` picks up, matching the compiler package's wiring.

#### Scenario: Root test run includes the migrator suite

- GIVEN `pnpm test` is run from the repo root
- WHEN Turborepo fans out `test` tasks
- THEN the migrator golden suite runs and its result affects the overall `pnpm test` outcome

### Requirement: Golden fixtures pin generated text, applicability is proven separately

Golden fixtures assert exact SQL **text** (or diagnostic content) produced by
the migrator; passing this suite alone MUST NOT be read as proof that the
DDL applies successfully against a real PostgreSQL server — that proof is
the responsibility of the `migration-appliability-tests` capability, which
executes the same fixtures against a real PostgreSQL engine (PGlite).

#### Scenario: Text-correct fixture with separately-verified applicability

- GIVEN a fixture asserting exact SQL text for a diff that is textually correct per manual review of PostgreSQL semantics
- WHEN the golden harness passes
- THEN this confirms the text matches the approved golden — it does NOT by itself confirm the SQL executes successfully; that confirmation comes from the `migration-appliability-tests` suite, which runs the same fixture's DDL against a real PostgreSQL engine
