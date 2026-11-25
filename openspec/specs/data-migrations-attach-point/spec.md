# Data Migrations Attach Point Specification

## Purpose

Defines `migrations/<id>/data.sql` as the official transactional attach point for DML/backfill
migrations alongside `migration.sql`, plus `indigodb migrate dev --create-only --empty` for
scaffolding data-only migrations.

## Requirements

### Requirement: `migrateDeploy` executes optional `data.sql` atomically after `migration.sql`

When a pending migration directory contains a `data.sql` file, `migrateDeploy` MUST execute its
statements inside the same `BEGIN ... COMMIT` transaction immediately after `migration.sql`'s
transactional body.

#### Scenario: DDL + data.sql backfill applies atomically

- GIVEN a pending migration whose `migration.sql` adds a nullable column `slug` and whose
  `data.sql` backfills `slug` from existing rows
- WHEN `migrateDeploy` runs
- THEN the column exists, existing rows are backfilled, and `_indigo_migrations` records
  `success = true`

#### Scenario: A failing data.sql rolls back both DDL and DML and records failure

- GIVEN a pending migration whose `migration.sql` creates a table and whose `data.sql` raises a
  SQL error
- WHEN `migrateDeploy` runs
- THEN the table created by `migration.sql` is rolled back (does not exist), `process.exitCode`
  is 1, and `_indigo_migrations` records `success = false` for that migration

#### Scenario: Data-only migration (comment-only migration.sql + data.sql) applies cleanly

- GIVEN a pending migration whose `migration.sql` contains only comments and whose `data.sql`
  updates existing rows
- WHEN `migrateDeploy` runs
- THEN `data.sql` executes, rows are updated, and `_indigo_migrations` records `success = true`

### Requirement: Destructive markers in `data.sql` obey the `--force` gate

`migrateDeploy`'s pre-scan MUST pass `data.sql` (when present) to `scanRequiresForce` alongside
`migration.sql`, refusing the deploy without `--force` and applying with `--force`.

#### Scenario: data.sql with `-- indigo:requires-force` refuses without `--force` and applies with `--force`

- GIVEN a pending migration whose `data.sql` carries `-- indigo:requires-force deletes legacy rows`
- WHEN `migrateDeploy` runs without `--force`
- THEN deploy refuses with exit code 1 and executes no SQL
- AND when re-run with `--force`, deploy applies `data.sql` and records `success = true`

### Requirement: Checksum integrity covers `data.sql` while staying backward-compatible without it

`migrationChecksum(sql, dataSql?)` MUST return the exact `sha256(sql)` when `data.sql` is absent
and a domain-separated sha256 over both `migration.sql` and `data.sql` when `data.sql` is present.
Editing, adding, or deleting `data.sql` after apply MUST be caught by `migrateDeploy`, `migrateDev`
shadow replay, `migrateStatus`, and `migrateResolve --applied`.

#### Scenario: Post-apply edit to `data.sql` is detected across deploy, dev, status, and resolve

- GIVEN a migration with `data.sql` has been applied
- WHEN `data.sql` is edited on disk after apply
- THEN `migrateStatus` reports `⚠ modified`, `migrateDeploy` refuses with drift, `migrateDev`
  refuses via shadow replay drift, and `migrateResolve --applied` refuses with checksum mismatch

#### Scenario: Adding `data.sql` to an already-applied DDL-only migration is detected as drift

- GIVEN a migration without `data.sql` has been applied
- WHEN a `data.sql` file is added to that migration directory afterwards
- THEN `migrateDeploy` refuses with checksum drift

### Requirement: Shadow replay skips `data.sql`

`buildShadowSchema` MUST replay only `migration.sql` (via `MigrationSource.read`), never
executing `data.sql`, so backfills that depend on live rows or data-only assertions do not break
subsequent `migrateDev` runs.

#### Scenario: Subsequent `migrateDev` succeeds even when an applied `data.sql` asserts live rows exist

- GIVEN a first migration creates `User`, a live row exists, and a second migration has a
  `data.sql` that fails if `User` is empty (e.g. a `DO $$` guard checking row count > 0)
- WHEN a third schema change runs `migrateDev` (triggering shadow replay into an empty PGlite DB)
- THEN shadow replay skips `data.sql`, reconstructs the schema cleanly, and creates+applies the
  third migration

### Requirement: `migrate dev --create-only --empty` scaffolds a data-only migration

`migrate dev` MUST accept `--empty` (`DevOptions.empty`). Without `--create-only`, `--empty`
MUST refuse before connecting. With `--create-only --empty`, `migrateDev` MUST run history
preflight (`ensureHistory` + `resolvePrevSchema`), then write a comment-only `migration.sql` and
a stub `data.sql` even when the schema has zero diffs, without applying or writing `.snapshot.json`.

#### Scenario: `--empty` without `--create-only` is refused

- GIVEN `migrateDev({ ..., empty: true, createOnly: false })`
- WHEN invoked
- THEN it refuses with `process.exitCode = 1`, creates no directory, and does not call `createClient`

#### Scenario: `--create-only --empty` scaffolds `migration.sql` + `data.sql` when schema has no changes

- GIVEN a database already up to date with `schema.indigo`
- WHEN `migrateDev({ ..., createOnly: true, empty: true, name: "backfill_slugs" })` runs
- THEN a new `migrations/<ts>_backfill_slugs/` directory is created containing both
  `migration.sql` and `data.sql`, neither applied nor recorded in `_indigo_migrations`
