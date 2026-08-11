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

### Requirement: Chain fixtures represent an accumulated migration history

The suite MUST support chain fixtures distinct from the existing `prev`/`next`
pair fixtures: an ordered sequence of schema files (e.g. `schema-01.indigo`,
`schema-02.indigo`, ...) where each adjacent pair represents one hop already
covered by an existing change class (add table, add column, add enum value,
add FK), reusing those patterns rather than inventing unrelated schemas.

#### Scenario: Chain fixture loads as an ordered sequence

- GIVEN a chain fixture directory containing an ordered `schema-NN.indigo` sequence
- WHEN the runner loads the fixture
- THEN it produces the schemas in file order, each pair available as a hop for `planMigration`

### Requirement: Chain hops are additive-only by design

The chain MUST consist exclusively of additive hops (create table, add
column, add enum value, add FK). A destructive hop (drop column, PK change,
or any change `renderPushSql` cannot express) MUST NOT be added to the
chain, because `packages/migrator/src/postgres.ts`'s push renderer has no
`DROP COLUMN` logic and is non-destructive by construction: comparing a
migrate-path result that dropped something against a push-path result that
structurally cannot drop it would be an invalid comparison, not a real
finding. This exclusion is permanent scope, not a deferred gap.

#### Scenario: Chain composition stays additive

- GIVEN the chain fixture's hop sequence
- WHEN each hop's change class is inspected
- THEN every hop is one of add-table, add-column, add-enum-value, or add-FK, and none removes or restructures existing structure

### Requirement: The full chain replays against one fresh instance without reset

The runner MUST apply every hop's migration plan, in order, against a single
fresh PGlite instance, without resetting or recreating the instance between
hops, reproducing how `migrations/` accumulates across successive real
`migrate dev` runs.

#### Scenario: Sequential hops accumulate on one instance

- GIVEN a 3-4 hop chain fixture
- WHEN the runner applies each hop's `planMigration` output in order against one PGlite instance
- THEN all hops apply without error and the instance's final state reflects every hop cumulatively

### Requirement: A separate instance is seeded via a single push of the final schema

The runner MUST seed a second, independent, fresh PGlite instance using one
`renderPushSql` call against the chain's final schema, never by replaying
the chain's hops.

#### Scenario: Push-path instance is independently seeded

- GIVEN the chain fixture's final schema
- WHEN the runner renders and applies `renderPushSql(final)` against a fresh instance
- THEN that instance's schema exists without any migration hop having run against it

### Requirement: Structural comparison covers semantic shape, excluding naming and guard artifacts

The runner MUST compare the two instances' live structure via
`information_schema` (or equivalent) introspection over table names, column
names, column types, nullability, and default-expression shape. The
comparison MUST NOT compare constraint names, index names, FK action names,
or `IF NOT EXISTS`-style idempotency-guard artifacts; these are named,
accepted divergences between the migrate path and the push path (they
legitimately differ by renderer without indicating drift), not silently
ignored differences.

#### Scenario: Equivalent schemas pass despite naming divergence

- GIVEN both instances have identical tables, columns, types, nullability, and defaults, but differ in constraint or index names
- WHEN the runner compares their introspected structure
- THEN the comparison passes, and the excluded categories are not evaluated

#### Scenario: A structural divergence fails with a named report

- GIVEN one instance is missing a column, or a column's type/nullability/default differs between instances
- WHEN the runner compares their introspected structure
- THEN the suite fails, and the report names the divergent table, column, and the specific mismatched property (missing/type/nullability/default) on each side

### Requirement: Any non-excluded divergence is a hard failure

Any structural divergence outside the categories named in "Structural
comparison covers semantic shape..." MUST fail the suite. No additional
allowlist beyond those named categories is permitted.

#### Scenario: Deliberate drift fails the suite

- GIVEN a chain fixture modified so one hop's replayed structure diverges from the push-path structure in a non-excluded category
- WHEN the runner compares the two instances
- THEN the suite fails, naming the divergence

### Requirement: Chain replay is wired into the existing appliability test run

The chain replay suite MUST live in `packages/migrator/test/` (either
extending `appliability.mjs` or a clearly-named sibling file) and MUST run
as part of the same `packages/migrator` `test` script that root `pnpm test`
already fans out through Turborepo. No new CI job is required.

#### Scenario: Root test run includes chain replay

- GIVEN `pnpm test` is run from the repo root
- WHEN Turborepo fans out `test` tasks
- THEN the chain replay suite runs as part of the migrator package's test run, and its result affects the overall `pnpm test` outcome
