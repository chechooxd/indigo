# Migration History Resolve Specification

## Purpose

Defines `indigodb migrate resolve`, a manual, explicit ledger-recovery verb
for `_indigo_migrations`. It lets an operator assert that reality and the
ledger diverged (a migration applied or reverted out-of-band) and reconcile
the recorded history — without executing any migration SQL, without
touching `.snapshot.json`, and without weakening the checksum-drift refusal
defined in `migration-history-integrity`.

## Requirements

### Requirement: `resolve` requires exactly one direction flag

The system MUST require exactly one of `--applied <id>` or
`--rolled-back <id>` per invocation. The system MUST reject invocations
that supply both flags and invocations that supply neither.

#### Scenario: Both flags supplied is rejected

- GIVEN `migrate resolve --applied 20240101_init --rolled-back 20240101_init`
- WHEN the command runs
- THEN it exits non-zero with a diagnostic that the flags are mutually exclusive, and `_indigo_migrations` is unchanged

#### Scenario: No flag supplied is rejected

- GIVEN `migrate resolve` invoked with no `--applied` or `--rolled-back` flag
- WHEN the command runs
- THEN it exits non-zero with a diagnostic that one direction flag is required, and `_indigo_migrations` is unchanged

### Requirement: `--applied <id>` records an applied row without executing SQL

Given a migration id that exists as a directory under `migrations/` with a
`migration.sql` file, `resolve --applied <id>` MUST INSERT a row into
`_indigo_migrations` with a `checksum` computed as the sha256 hex digest of
that file's exact on-disk bytes and `success = true`. The system MUST NOT
execute any statement from that migration's `migration.sql`.

#### Scenario: Applied resolve records the row without running SQL

- GIVEN a migration id present on disk with no recorded row and no side effect of its SQL having run
- WHEN `migrate resolve --applied <id>` runs
- THEN a row is inserted with `checksum` equal to the sha256 hex digest of the on-disk file and `success = true`, and none of the migration's SQL statements are executed

#### Scenario: Applied resolve makes deploy skip that migration

- GIVEN `migrate resolve --applied <id>` has recorded the row
- WHEN `migrate status` or `migrate deploy` subsequently runs
- THEN `status` reports `<id>` as applied and `deploy` skips it as already applied

### Requirement: `--applied <id>` refuses on checksum drift instead of re-baselining

If the migration id already has a recorded row whose stored checksum
differs from the sha256 hex digest computed from the current on-disk
`migration.sql`, `resolve --applied <id>` MUST refuse and MUST NOT modify
the recorded row. Resolve MUST NOT silently recompute and overwrite a
drifted checksum; it MUST NOT provide any way to bypass the drift refusal
defined in `migration-history-integrity`.

#### Scenario: Drifted on-disk content is refused, not re-baselined

- GIVEN a migration id has a recorded row and its on-disk `migration.sql` was edited since that row was recorded
- WHEN `migrate resolve --applied <id>` runs
- THEN the command exits non-zero, names the id as drifted, and the recorded row's checksum is left unchanged

### Requirement: `--applied <id>` on an already-recorded, non-drifted migration is idempotent

If the migration id already has a recorded row and its on-disk content
matches the stored checksum, `resolve --applied <id>` MUST succeed as a
no-op: no error, no duplicate row, and no change to the existing row.

#### Scenario: Re-running applied resolve on a clean already-recorded id is a no-op

- GIVEN a migration id already has a recorded row whose checksum matches its current on-disk content
- WHEN `migrate resolve --applied <id>` runs again
- THEN the command exits zero, no additional row is inserted, and the existing row is unchanged

### Requirement: `--rolled-back <id>` deletes the recorded row and is idempotent

`resolve --rolled-back <id>` MUST DELETE the row for that migration id from
`_indigo_migrations` if one exists. If no row exists for that id, the
command MUST succeed as a no-op: no error and no row created.

#### Scenario: Rolled-back resolve deletes an existing row

- GIVEN a migration id has a recorded row in `_indigo_migrations`
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the row for that id is deleted and no migration SQL is executed

#### Scenario: Rolled-back resolve on an absent row is a clean no-op

- GIVEN a migration id has no recorded row in `_indigo_migrations`
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the command exits zero, no row is created, and no error is raised

### Requirement: Resolve refuses unknown migration ids

If the given id has no matching directory under `migrations/` (no
`migration.sql` on disk), `resolve` MUST refuse for both `--applied` and
`--rolled-back` directions, with a diagnostic naming the unknown id. It
MUST NOT insert a ledger row for a migration that does not exist on disk.

#### Scenario: Unknown id with --applied is refused

- GIVEN no `migrations/<id>/migration.sql` exists on disk
- WHEN `migrate resolve --applied <id>` runs
- THEN the command exits non-zero, names `<id>` as unknown, and no row is inserted

#### Scenario: Unknown id with --rolled-back is refused

- GIVEN no `migrations/<id>/migration.sql` exists on disk
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the command exits non-zero, names `<id>` as unknown, and `_indigo_migrations` is unchanged

### Requirement: Resolve touches only the ledger, never `.snapshot.json`

`resolve` MUST read and write only `_indigo_migrations`. It MUST NOT read
or write `.snapshot.json` in either direction. Snapshot reconciliation
remains exclusively `migrate dev`'s responsibility.

#### Scenario: Resolve leaves the snapshot file untouched

- GIVEN a `.snapshot.json` file exists with arbitrary content
- WHEN `migrate resolve --applied <id>` or `migrate resolve --rolled-back <id>` runs
- THEN `.snapshot.json` is byte-identical before and after the command
