# Migration Appliability Tests Specification

## Purpose

Proves that the DDL `packages/migrator` emits actually applies against a
real PostgreSQL engine (PGlite, `PostgreSQL 18.3` compiled to WASM), closing
the gap the golden-text suite explicitly leaves open: text-correctness was
never proof of execution success. This capability owns execution; the
golden suite keeps owning exact text.

**Scope note**: "appliability" means the emitted SQL executes without error
against a real single-connection PostgreSQL engine. It does NOT mean
production correctness under concurrency. PGlite is single-connection/
single-user; concurrent deploys, advisory locking, and connection-pool
behaviour remain untested and are explicitly out of scope for this
capability.

## Requirements

### Requirement: Non-refusal fixtures apply successfully against real PostgreSQL

For every existing golden fixture whose plan carries no diagnostics, the
runner MUST apply the fixture's `prev` state (or start from an empty
database when `prev` is absent) against a PostgreSQL engine, then execute
the plan's emitted statements in their recorded phase order, and MUST
assert that no statement raises an error.

#### Scenario: Fixture DDL applies cleanly

- GIVEN a golden fixture with `prev.indigo` and `next.indigo` and a plan with no diagnostics
- WHEN the runner applies `prev`'s resulting schema, then executes each emitted statement in order against a real PostgreSQL engine
- THEN every statement executes without error
- AND the runner reports a failure, naming the fixture and the failing statement, if any statement errors

### Requirement: Refusal fixtures assert nothing executes

For every golden fixture whose plan carries diagnostics, the runner MUST
assert that the plan emits zero statements and MUST NOT attempt to execute
anything against PostgreSQL for that fixture.

#### Scenario: Diagnostic fixture emits no statements

- GIVEN a golden fixture whose plan carries a diagnostic (`enum-value-removed`, `ambiguous-column-remap`, or `required-column-without-default`)
- WHEN the runner inspects the plan
- THEN it asserts the statement list is empty
- AND it executes no DDL against PostgreSQL for that fixture

### Requirement: Pre-transaction phase separation is enforced against a real engine

Statements the migrator tags `pre-transaction` MUST be executed outside any
open transaction, and statements tagged for the transactional block MUST be
executed inside one. The suite MUST include at least one test that fails
if a `pre-transaction` statement (e.g. `ALTER TYPE ... ADD VALUE`) were
executed inside a transaction, reproducing PostgreSQL's own
`unsafe use of new value` rejection.

#### Scenario: Pre-transaction statement runs outside the transaction

- GIVEN a fixture whose plan includes a statement with `phase: "pre-transaction"` (e.g. `enum-add-value`)
- WHEN the runner executes the plan against PostgreSQL, honouring the recorded phase
- THEN the pre-transaction statement succeeds outside any transaction block
- AND the remaining statements execute successfully inside the transactional block

#### Scenario: Executing a pre-transaction statement inside a transaction fails

- GIVEN the same pre-transaction statement (`ALTER TYPE ... ADD VALUE`)
- WHEN it is deliberately executed inside an open transaction, in the same statement batch as another use of the new enum value
- THEN PostgreSQL rejects it with `unsafe use of new value`
- AND this proves the phase-separation requirement is load-bearing, not decorative

### Requirement: `renderPushSql` output is idempotent against a real engine

The suite MUST execute `renderPushSql`'s output against a clean database
twice in succession and MUST assert both executions succeed without error.

#### Scenario: Second push run succeeds

- GIVEN a fixture's `pushSql` output
- WHEN the runner executes it against a clean PostgreSQL database, then executes the identical output a second time against the same database
- THEN both executions complete without error

### Requirement: Historical-bug regressions are reproduced and guarded

The suite MUST include two explicit regression tests seeded from bugs fixed
in `fix-migrator-correctness`, each executed against a real PostgreSQL
engine: a foreign key emitted before its referenced table, and an enum
`ADD VALUE` used in the same transaction as its new value. Each test MUST
assert the current (fixed) behaviour succeeds, and MUST be written so that
reverting the corresponding fix makes it fail with the documented
PostgreSQL error.

#### Scenario: FK-ordering regression stays fixed

- GIVEN the `fk-order-declaration` fixture, whose plan creates the referenced table before emitting its foreign key
- WHEN the runner executes the plan's statements in order against PostgreSQL
- THEN every statement succeeds
- AND reverting the FK-ordering fix (emitting the FK before its referenced table exists) would fail this test with `relation "..." does not exist`

#### Scenario: Enum-transaction regression stays fixed

- GIVEN the `enum-add-value` fixture, whose plan tags `ALTER TYPE ... ADD VALUE` as `pre-transaction`
- WHEN the runner executes the plan honouring phase separation against PostgreSQL
- THEN the statement succeeds
- AND reverting the pre-transaction split (running it inside the transaction alongside a use of the new value) would fail this test with `unsafe use of new value`

### Requirement: Each fixture runs against an isolated, clean database state

Every fixture MUST execute against a database state that carries no
schema or data left over from any other fixture. The suite MUST NOT rely on
execution order between fixtures to produce a passing result.

#### Scenario: Fixture isolation

- GIVEN two fixtures that each create a table or type of the same name
- WHEN the runner executes both fixtures in the same suite run
- THEN neither fixture's setup or assertions are affected by objects the other fixture created

### Requirement: The suite is wired into the workspace test fan-out

`packages/migrator`'s `package.json` `test` script MUST run this suite in
addition to the golden-text suite, so root `pnpm test` covers both.

#### Scenario: Root test run includes the appliability suite

- GIVEN `pnpm test` is run from the repo root
- WHEN Turborepo fans out `test` tasks
- THEN the migrator appliability suite runs and its result affects the overall `pnpm test` outcome

### Requirement: Concurrency and pool behaviour remain explicitly out of scope

This capability MUST NOT be described, in tests, output, or documentation,
as proof of correctness under concurrent access, advisory locking, or
connection-pool behaviour. PGlite's single-connection execution model
cannot exercise those paths.

#### Scenario: Scope statement is honest

- GIVEN a reader of the appliability suite's output or documentation
- WHEN they check what the suite claims to prove
- THEN it states "appliability" (the DDL executes successfully) and explicitly excludes concurrency, advisory locking, and pool behaviour as untested
