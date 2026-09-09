# Delta for Migration History Resolve

## MODIFIED Requirements

### Requirement: `--applied <id>` records an applied row without executing SQL

Given a migration id that exists as a directory under `migrations/` with a `migration.sql` file, `resolve --applied <id>` MUST INSERT a row into `_indigo_migrations` with a `checksum` computed as the sha256 hex digest of that file's exact on-disk bytes, `success = true`, `installed_by` set from `current_user`, and `execution_time_ms` set to `null` (no SQL is executed, so no elapsed time exists to record). The system MUST NOT execute any statement from that migration's `migration.sql`.
(Previously: inserted `checksum` and `success = true` only; `installed_by` and `execution_time_ms` did not exist.)

#### Scenario: Applied resolve records the row without running SQL

- GIVEN a migration id present on disk with no recorded row and no side effect of its SQL having run
- WHEN `migrate resolve --applied <id>` runs
- THEN a row is inserted with `checksum` equal to the sha256 hex digest of the on-disk file, `success = true`, `installed_by` equal to `current_user`, `execution_time_ms` is `null`, and none of the migration's SQL statements are executed

#### Scenario: Applied resolve makes deploy skip that migration

- GIVEN `migrate resolve --applied <id>` has recorded the row
- WHEN `migrate status` or `migrate deploy` subsequently runs
- THEN `status` reports `<id>` as applied and `deploy` skips it as already applied

### Requirement: `--applied <id>` on a recorded failure row explicitly marks it resolved

If the migration id already has a recorded `success = false` row and its on-disk `migration.sql` checksum matches the row's stored checksum, `resolve --applied <id>` MUST update that row to `success = true`, refreshing `installed_by` from `current_user` and leaving `execution_time_ms` as `null`. This is the documented, tested exit from the refusal in `migration-history-integrity` where `migrate deploy` refuses on a pending id that carries a failure row: the operator asserts the migration is now considered applied, without re-executing its SQL.
(This is new: prior scenarios only covered a recorded row with `success = true` or no row at all; `success = false` rows did not exist.)

#### Scenario: Applied resolve clears a failure row when the checksum still matches

- GIVEN a migration id has a `success = false` row and its on-disk content is unchanged since that row was recorded
- WHEN `migrate resolve --applied <id>` runs
- THEN the existing row is updated to `success = true`, and a subsequent `migrate deploy` no longer refuses on that id

#### Scenario: Applied resolve still refuses a failure row whose on-disk content also drifted

- GIVEN a migration id has a `success = false` row and its on-disk `migration.sql` was edited since that row was recorded
- WHEN `migrate resolve --applied <id>` runs
- THEN the command refuses for checksum drift exactly as `migration-history-integrity` specifies, and the row's `success` value is left unchanged

### Requirement: `--rolled-back <id>` deletes the recorded row and is idempotent

`resolve --rolled-back <id>` MUST DELETE the row for that migration id from `_indigo_migrations` if one exists, regardless of that row's `success` value. If no row exists for that id, the command MUST succeed as a no-op: no error and no row created.
(Previously: identical behavior, but only `success = true` rows existed; `success = false` rows are now a possible input to the same delete path.)

#### Scenario: Rolled-back resolve deletes an existing row

- GIVEN a migration id has a recorded row in `_indigo_migrations`
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the row for that id is deleted and no migration SQL is executed

#### Scenario: Rolled-back resolve deletes a failure row the same way as a success row

- GIVEN a migration id has a recorded `success = false` row
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the failure row is deleted, the id reverts to pending, and no diagnostic distinguishes this from deleting a `success = true` row

#### Scenario: Rolled-back resolve on an absent row is a clean no-op

- GIVEN a migration id has no recorded row in `_indigo_migrations`
- WHEN `migrate resolve --rolled-back <id>` runs
- THEN the command exits zero, no row is created, and no error is raised
