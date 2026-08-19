# Delta for Migration Appliability Tests

## ADDED Requirements

### Requirement: Shadow-replay-derived prev is plan-equivalent to snapshot-derived prev across the corpus

For every fixture in the corpus except the documented `@map` physical-rename
case, the suite MUST assert that `planMigration` produces the same
`MigrationPlan` (same statements, same order, same diagnostics) whether
`prev` is built via shadow-replay-then-introspect or via the legacy
snapshot-derived path. The `@map` physical-rename case MUST be excluded
from this equivalence assertion and instead covered by its own dedicated
test asserting the documented drop+add degradation.

#### Scenario: Plan equivalence holds across the corpus

- GIVEN a fixture that is not the documented `@map` physical-rename case
- WHEN `planMigration` is invoked once with a shadow-replay-derived `prev` and once with a snapshot-derived `prev`, both against the same `next`
- THEN both invocations produce an identical `MigrationPlan`

#### Scenario: The @map case is excluded from equivalence and covered separately

- GIVEN the fixture representing an `@map` physical rename against a shadow-replay-derived `prev`
- WHEN the plan-equivalence suite runs
- THEN this fixture is excluded from the equivalence assertion, and a separate dedicated test asserts the shadow-replay path emits drop+add while the snapshot-derived path emits a rename

### Requirement: `migrate dev` works with `migrations/.snapshot.json` deleted from disk

Since `prev` no longer sources from `migrations/.snapshot.json`, the suite
MUST assert that `migrate dev` generates a correct migration for a fixture
even when `.snapshot.json` is absent from disk at invocation time.

#### Scenario: Migration succeeds without a snapshot file present

- GIVEN a fixture's migration history has been applied to a real/shadow database, and `migrations/.snapshot.json` is deleted from disk
- WHEN `migrate dev` is invoked with a schema edit
- THEN it generates the correct migration plan without erroring on the missing snapshot file

### Requirement: `.snapshot.json` is still written after every `migrate dev` run

Although `.snapshot.json` is no longer read as the diff source, `migrate
dev` MUST still write it after each successful run, as a debug/rollback
artifact.

#### Scenario: Snapshot file is written despite not being read for diffing

- GIVEN a successful `migrate dev` run using shadow-replay-derived `prev`
- WHEN the run completes
- THEN `migrations/.snapshot.json` exists on disk and reflects the resulting schema state, even though it was not consulted to produce this migration's diff

### Requirement: Missing or out-of-order recorded migrations produce an explicit diagnostic during appliability testing

The suite MUST include at least one test proving that shadow replay refuses
to proceed — producing an explicit diagnostic rather than a wrong plan —
when `_indigo_migrations` records a migration whose directory is missing,
or when the recorded order disagrees with on-disk lexicographic order.

#### Scenario: Desync produces a diagnostic, not a wrong plan

- GIVEN a fixture where `_indigo_migrations` records a migration directory that has been deleted from `migrations/`
- WHEN `migrate dev` attempts to build the shadow database
- THEN the run fails with an explicit diagnostic naming the missing migration, and no migration plan is produced from a partial replay
