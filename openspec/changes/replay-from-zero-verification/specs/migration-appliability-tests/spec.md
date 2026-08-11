# Delta for Migration Appliability Tests

## ADDED Requirements

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
