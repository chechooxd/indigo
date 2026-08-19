# Shadow Database Replay Specification

## Purpose

Defines the ephemeral shadow-database mechanism that reconstructs a
database's structure by replaying its recorded migration history onto a
fresh PGlite instance, so `migrateDev` can diff against real, reproducible
structure instead of a hand-editable JSON snapshot.

## Requirements

### Requirement: A fresh PGlite instance is created per shadow build

Each shadow build MUST start from a fresh, empty PGlite instance carrying no
state from any prior build or from the real target database.

#### Scenario: Shadow build starts empty

- GIVEN a previous `migrate dev` invocation already built and discarded a shadow instance
- WHEN a new shadow build starts
- THEN the new PGlite instance contains no tables, types, or data from the prior build

### Requirement: Migrations replay in `_indigo_migrations`-recorded order

The system MUST read the ordered list of applied migrations from
`_indigo_migrations` in the real target database, then apply each
corresponding `migrations/<dir>/migration.sql` file to the shadow instance
in that recorded order.

#### Scenario: Replay follows recorded order

- GIVEN `_indigo_migrations` records three applied migrations in a specific order
- WHEN the shadow database is built
- THEN each migration's SQL is applied to the shadow instance in the exact order recorded in `_indigo_migrations`

### Requirement: PGlite is a hard runtime dependency, not a pluggable backend

`@electric-sql/pglite` MUST be a runtime (not devDependency/test-only)
dependency of `@indigodb/migrator`, transitively available to
`@indigodb/cli`. The system MUST NOT provide a pluggable shadow-backend
abstraction; PGlite is the sole shadow-database engine.

#### Scenario: PGlite ships as a production dependency

- GIVEN `@indigodb/migrator`'s `package.json`
- WHEN its dependencies are inspected
- THEN `@electric-sql/pglite` is listed under `dependencies`, not `devDependencies`, and no alternate shadow-backend implementation is present in the package

### Requirement: A missing recorded migration directory produces a loud diagnostic

If `_indigo_migrations` records a migration whose corresponding
`migrations/<dir>/migration.sql` does not exist on disk, the system MUST
refuse to build the shadow database and MUST raise an explicit, actionable
diagnostic naming the missing migration. It MUST NOT silently skip it.

#### Scenario: Missing migration file halts replay

- GIVEN `_indigo_migrations` records a migration whose directory has been deleted from `migrations/`
- WHEN `migrateDev` attempts to build the shadow database
- THEN replay halts before producing a `prev`, an explicit diagnostic names the missing migration, and `migrateDev` does not proceed to diff against a partial `prev`

### Requirement: Recorded order diverging from on-disk order produces a loud diagnostic

No checksum column exists yet on `_indigo_migrations`, so order divergence
is the only available desync signal. If the order recorded in
`_indigo_migrations` disagrees with the lexicographic order of migration
directories on disk, the system MUST raise an explicit diagnostic instead of
silently picking either ordering.

#### Scenario: Reordered migrations produce a diagnostic, not a silent wrong diff

- GIVEN `_indigo_migrations`' recorded order disagrees with the lexicographic order of directories under `migrations/`
- WHEN `migrateDev` attempts to build the shadow database
- THEN an explicit diagnostic reports the order mismatch, and `migrateDev` does not silently produce a wrong diff by guessing an ordering

### Requirement: Shadow replay does not mutate the real target database

Building and replaying the shadow instance MUST NOT write to or otherwise
mutate the real target database, beyond reading `_indigo_migrations` for
recorded order.

#### Scenario: Real database is untouched by shadow replay

- GIVEN a real target database with existing data
- WHEN `migrateDev` builds the shadow database for diffing
- THEN the real database's schema and data are unchanged after the shadow build completes
