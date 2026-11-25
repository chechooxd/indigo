# Migration Plan/Apply Separation Specification

## Purpose

Defines the `--create-only` flag on `indigodb migrate dev`, which splits the
existing atomic pre-flight-then-commit run into a pre-flight phase (connect,
resolve prev state, plan, gate, write the migration file) and a commit phase
(apply to the database, record history, commit, save the snapshot), letting
the commit phase be skipped while the pre-flight phase runs unchanged.

## Requirements

### Requirement: `migrate dev` accepts a `--create-only` flag

The system MUST accept a `--create-only` boolean option on the
`indigodb migrate dev` command, threaded through as `DevOptions.createOnly`.

#### Scenario: Flag is recognized

- GIVEN a schema with a pending, non-destructive change
- WHEN the user runs `migrate dev --create-only -n add_field`
- THEN the command accepts the flag and proceeds without an "unknown option" error

### Requirement: `--create-only` runs the full pre-flight phase unchanged

With `--create-only`, the system MUST connect to the target database, run
`ensureHistory`, resolve the previous state via `resolvePrevSchema`
(shadow-replay by default, or the snapshot escape hatch), run
`planMigration`, and apply the existing diagnostics-refusal and
destructive-statement `--force` gate exactly as it does without the flag.

#### Scenario: Diagnostics still refuse before any file is written

- GIVEN a schema whose plan produces diagnostics
- WHEN `migrate dev --create-only` runs
- THEN the command refuses before writing a migration file, identically to `migrate dev` without the flag

#### Scenario: A requires-force statement still refuses without `--force`

- GIVEN a plan containing a `requires-force` statement
- WHEN `migrate dev --create-only` runs without `--force`
- THEN the command refuses, `process.exitCode` is set to `1`, and no migration file is written

#### Scenario: `--create-only --force` writes a plan containing requires-force statements

- GIVEN a plan containing a `requires-force` statement
- WHEN `migrate dev --create-only --force` runs
- THEN the migration file is written to disk and no commit-phase side effect occurs

### Requirement: `--create-only` writes the migration file but skips all commit-phase side effects

When `--create-only` is set and pre-flight succeeds, the system MUST write
`migrations/<ts>_<name>/migration.sql` to disk and MUST NOT apply the SQL to
the database, MUST NOT insert a row into `_indigo_migrations`, MUST NOT
commit a transaction, and MUST NOT save `.snapshot.json`.

#### Scenario: File is written, database is untouched

- GIVEN a schema with a pending, non-destructive change
- WHEN `migrate dev --create-only -n add_field` runs
- THEN `migrations/<id>_add_field/migration.sql` exists on disk, no row is inserted into `_indigo_migrations`, and `.snapshot.json` is unchanged

#### Scenario: Distinct success message

- GIVEN a successful `--create-only` run
- WHEN the command finishes
- THEN it prints a message distinct from the default apply message, identifying the migration as created but not applied

### Requirement: A `--create-only` file is later applicable unchanged

The migration file written under `--create-only` MUST be byte-identical to
one produced by a normal (non-`--create-only`) run of `migrate dev` for the
same schema change, so a later plain `migrate dev` or `migrate deploy` run
applies it without modification.

#### Scenario: `migrate status` reports the file as pending

- GIVEN a migration file written by `migrate dev --create-only`
- WHEN `migrate status` runs
- THEN the migration is reported as pending

#### Scenario: `migrate deploy` applies the pending file

- GIVEN a migration file written by `migrate dev --create-only` and not yet applied
- WHEN `migrate deploy` runs
- THEN the migration applies, a row is inserted into `_indigo_migrations`, and the command succeeds

### Requirement: Default `migrate dev` behavior is unchanged

Without `--create-only`, `migrate dev` MUST continue to write, apply, record
history, commit, and save the snapshot in one atomic run, exactly as before
this change.

#### Scenario: Plain `migrate dev` remains atomic

- GIVEN a schema with a pending, non-destructive change
- WHEN `migrate dev -n add_field` runs without `--create-only`
- THEN the migration file is written, applied, recorded in `_indigo_migrations`, committed, and `.snapshot.json` is saved, in the same run

### Requirement: `--create-only` still requires a live database connection

`--create-only` MUST NOT be treated as an offline or no-database mode. The
system MUST connect to the target database because `resolvePrevSchema`'s
default shadow-replay path reads `_indigo_migrations` from that database.

#### Scenario: Connection failure refuses the command

- GIVEN the target database is unreachable
- WHEN `migrate dev --create-only` runs
- THEN the command fails to connect and no migration file is written, identically to `migrate dev` without the flag

### Requirement: `migrate dev --create-only --empty` scaffolds a data-only migration

The system MUST accept an `--empty` boolean option on `indigodb migrate dev` (`DevOptions.empty`)
that requires `--create-only`. Without `--create-only`, `--empty` MUST refuse before connecting.
With `--create-only --empty`, pre-flight runs unchanged and the command writes a comment-only
`migration.sql` alongside a stub `data.sql` even when the schema has zero diffs, skipping all
commit-phase side effects.

#### Scenario: `--empty` without `--create-only` is refused before connecting

- GIVEN `migrate dev --empty -n backfill` without `--create-only`
- WHEN the command runs
- THEN it refuses with `process.exitCode = 1`, opens no database connection, and writes no files

#### Scenario: `--create-only --empty` scaffolds both `migration.sql` and `data.sql`

- GIVEN an up-to-date schema with zero pending DDL diffs
- WHEN `migrate dev --create-only --empty -n backfill` runs
- THEN `migrations/<ts>_backfill/migration.sql` and `migrations/<ts>_backfill/data.sql` are
  created without applying or updating `_indigo_migrations` or `.snapshot.json`
