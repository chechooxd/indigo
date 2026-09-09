# Migration History Integrity Specification

## Purpose

Defines the shape and enforcement of `_indigo_migrations` as an integrity
ledger, not just an applied-set: a `checksum` of each migration's exact
on-disk bytes and a `success` flag, computed at apply time and enforced at
deploy time and reported at status time, so an already-applied
`migration.sql` cannot be silently edited and replayed, and a failed
migration is recorded durably with full context.

## Requirements

### Requirement: `_indigo_migrations` records checksum, success, installed_by, and execution_time_ms, created once with no backfill

The system MUST create `_indigo_migrations` with `id, name, applied_at, checksum, success, installed_by, execution_time_ms` columns in a single `CREATE TABLE IF NOT EXISTS` statement. The system MUST NOT issue any `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` backfill. Nothing is published (v0.0.1), so there is no installed base to upgrade in place; this is a deliberate pre-publish simplification, not an oversight.
(Previously: created checksum/success idempotently — `CREATE TABLE IF NOT EXISTS` for a fresh install plus an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` backfill path for a pre-existing table.)

#### Scenario: Fresh install creates the full column set

- GIVEN no `_indigo_migrations` table exists in the target database
- WHEN `ensureHistory` runs
- THEN the created table has `id`, `name`, `applied_at`, `checksum`, `success`, `installed_by`, and `execution_time_ms` columns

#### Scenario: An existing table is left as-is, with no backfill of missing columns

- GIVEN `_indigo_migrations` already exists with only the pre-change columns (`id`, `name`, `applied_at`, `checksum`, `success`)
- WHEN `ensureHistory` runs against it, followed by an INSERT that references `installed_by`
- THEN `ensureHistory` does not alter the existing table, and the INSERT fails because `installed_by` was never added — demonstrating no backfill path exists

### Requirement: Checksum is a sha256 hex digest of the exact `migration.sql` bytes

When a migration is applied, the system MUST compute the checksum as the
sha256 hex digest of the exact byte content of that migration's
`migration.sql` file, read through the same I/O-injection seam used
elsewhere for migration content, and store it alongside the recorded row.

#### Scenario: Applying a migration records its content checksum

- GIVEN a pending migration directory with a `migration.sql` file
- WHEN `migrate dev` or `migrate deploy` applies it successfully
- THEN the recorded row's `checksum` equals the sha256 hex digest of that file's exact bytes at apply time

### Requirement: A pre-existing history table is left exactly as it is

The system MUST NOT alter a `_indigo_migrations` table that already exists.
There is no `ALTER TABLE ... ADD COLUMN` upgrade path and no checksum
backfill: `ensureHistory` issues one `CREATE TABLE IF NOT EXISTS`, which is a
no-op against any existing table whatever its shape.

A table created by an older local build is therefore left narrow, and a write
naming a column it does not have fails loudly rather than being silently
repaired. That is the intended behaviour — the operator drops the table and
lets it be recreated.

(Previously: "A legacy history table silently backfills checksums on first
touch", which required an automatic, unprompted `ALTER`-and-backfill upgrade.
That machinery existed to migrate tables created by an earlier published
version. Nothing has ever been published at v0.0.1, so there was no installed
base for it to protect, and carrying it meant shipping a migration path for a
version that never shipped. Removed by `migration-history-forensics`.)

#### Scenario: An existing table is left as-is, with no backfill of missing columns

- GIVEN a `_indigo_migrations` table created by an older build, without `installed_by`
- WHEN any migration command runs against it
- THEN the table is unchanged, and a write naming `installed_by` is rejected by the database rather than silently enabled by an added column

### Requirement: `migrate deploy` refuses on checksum drift before applying any pending migration

Before applying any pending migration, `migrate deploy` MUST recompute the
checksum of every already-recorded migration's on-disk `migration.sql` and
compare it against the stored checksum. If any recorded migration's on-disk
content no longer matches its stored checksum, the system MUST refuse to
apply any pending migration and MUST raise an explicit diagnostic naming
the drifted migration id(s). There is no flag or configuration to bypass
this refusal.

#### Scenario: Deploy refuses when a previously-applied migration was edited

- GIVEN an already-recorded migration's `migration.sql` has been edited since it was applied
- WHEN `migrate deploy` runs with one or more pending migrations
- THEN deploy refuses before applying any pending migration, and the diagnostic names the drifted migration id

#### Scenario: Deploy proceeds normally with no drift

- GIVEN every already-recorded migration's on-disk content matches its stored checksum
- WHEN `migrate deploy` runs with pending migrations
- THEN the preflight checksum comparison passes and pending migrations are applied as before

### Requirement: Checksum drift is a hard refusal with no override

Checksum drift detected by `migrate dev` (via shadow replay) or
`migrate deploy` (via preflight) MUST always block the run. The system MUST
NOT provide any flag, environment variable, or configuration option to
suppress or override this refusal. The sanctioned remedy path is
`migrate resolve` acting on the ledger only — reverting the on-disk file to
match the recorded checksum, or explicitly reconciling the ledger via
`migrate resolve --applied`/`--rolled-back` per `migration-history-resolve`.
`migrate resolve --applied <id>` itself MUST refuse (not silently
re-baseline) when the target id's on-disk content has already drifted from
its recorded checksum, so `resolve` provides no side door around this
refusal.

#### Scenario: No override surface exists for drift

- GIVEN a checksum mismatch is detected during `migrate dev` or `migrate deploy`
- WHEN the user attempts to proceed anyway
- THEN no documented flag, environment variable, or configuration bypasses the refusal, and the run remains blocked until the drifted migration is reverted or the ledger is explicitly reconciled via `migrate resolve`

#### Scenario: `migrate resolve` cannot be used to silently re-baseline a drifted checksum

- GIVEN a recorded migration's on-disk content no longer matches its stored checksum
- WHEN an operator runs `migrate resolve --applied <id>` on that same id, hoping to clear the drift
- THEN `resolve` refuses and leaves the stored checksum unchanged, exactly as `migration-history-resolve` specifies

### Requirement: `migrate status` reports drift as a non-fatal diagnostic

`migrate status` MUST recompute checksums for recorded migrations and
report, per row, whether the migration is applied-unmodified or
applied-with-drift. This reporting MUST be diagnostic only: `migrate
status` MUST NOT fail or exit non-zero solely because drift was detected.

#### Scenario: Status reports a drifted row without failing

- GIVEN a recorded migration's on-disk content no longer matches its stored checksum
- WHEN `migrate status` runs
- THEN the output distinguishes that row as modified/drifted from other applied rows, and `migrate status` exits successfully (zero) rather than failing

#### Scenario: Status reports all-clean history normally

- GIVEN every recorded migration's on-disk content matches its stored checksum
- WHEN `migrate status` runs
- THEN every applied row is reported as applied-unmodified, matching current behavior

### Requirement: `success` gates which migrations are treated as applied and is enforced on the failure path

The system MUST write a durable row for every applied migration attempt, including a failed `migrate deploy`, and MUST use `success` to gate applied-state, not merely record it.

- `migrate dev`, `migrate deploy`, and `migrate resolve --applied` MUST write `success = true` on their respective success paths.
- When `migrate deploy` fails applying a migration, after the transaction `ROLLBACK` the system MUST write a `success = false` row for that migration on the same connection via an autocommit `INSERT ... ON CONFLICT (name) DO UPDATE` (retry-safe against `name`'s `UNIQUE` constraint).
- Every recorded row MUST carry `installed_by` set from `current_user` at apply time and `execution_time_ms` measuring that attempt's elapsed time.
- `appliedMigrations()` MUST filter on `success = true`; a `success = false` row MUST NOT make a migration appear applied.
- `migrate deploy` MUST refuse to proceed when the next pending id already carries a `success = false` row, naming that id and directing the operator to `migrate resolve`.
- `migrate status` MUST render a `success = false` row distinguishably from an applied or pending row.
- If the process is terminated between the `ROLLBACK` and the failure-row write, no row is recorded and the id reverts to plain pending. This is a documented best-effort limitation, not a tested guarantee: the test suite runs against PGlite, which cannot model process death.

(Previously: "`success` is recorded as a forward-compatible column with no enforcement yet" — failed migrations left no row at all, `success` carried no gating behavior, and `success = false` rows were explicitly out of scope.)

#### Scenario: Successful migrations record `success = true` on all three write paths

- GIVEN a migration applies without error via `migrate dev`, `migrate deploy`, or `migrate resolve --applied`
- WHEN its row is recorded in `_indigo_migrations`
- THEN `success` is stored as `true`

#### Scenario: A failed deploy leaves a durable failure row after rollback

- GIVEN a pending migration whose SQL fails during `migrate deploy`
- WHEN the transaction is rolled back
- THEN a row for that migration is written with `success = false`, on the same connection, outside the rolled-back transaction

#### Scenario: A failure row does not make its migration look applied

- GIVEN a `success = false` row exists for a migration id
- WHEN `appliedMigrations()` is queried
- THEN that id is absent from the result, and pending-migration detection still reports it as pending

#### Scenario: Deploy refuses when the next pending id already carries a failure row

- GIVEN the next pending migration id already has a `success = false` row
- WHEN `migrate deploy` runs
- THEN it refuses before applying anything, names that id, and directs the operator to `migrate resolve` rather than skipping or retrying automatically

#### Scenario: Retrying a previously failed migration upserts instead of violating the UNIQUE constraint

- GIVEN a migration id has a recorded `success = false` row
- WHEN that same migration is applied again and succeeds
- THEN the existing row is updated in place (`ON CONFLICT (name) DO UPDATE`) to `success = true` with fresh `applied_at`, `installed_by`, and `execution_time_ms`, and no duplicate row or unique-constraint violation occurs

#### Scenario: `installed_by` is recorded from `current_user`

- GIVEN a database session authenticated as a given role
- WHEN any row is written to `_indigo_migrations` (success or failure)
- THEN `installed_by` equals that session's `current_user` value

#### Scenario: `execution_time_ms` is recorded on both outcomes

- GIVEN a migration attempt that either succeeds or fails
- WHEN its row is written
- THEN `execution_time_ms` holds a non-null elapsed-time measurement for that attempt, on both the success row and the failure row

#### Scenario: `migrate status` distinguishes a failed row from applied and pending rows

- GIVEN `_indigo_migrations` contains one applied row, one `success = false` row, and one migration with no row at all
- WHEN `migrate status` runs
- THEN its output marks the failed row distinguishably from both the applied row and the pending migration, and exits successfully

#### Scenario: A crash between rollback and the failure-row write is a stated limitation, not a guarantee

- GIVEN the documentation and code comments for the failure-row write path
- WHEN the process is terminated after `ROLLBACK` but before the autocommit failure-row INSERT completes
- THEN no row is recorded for that attempt, the id reverts to plain pending on the next run, and this gap is stated as a documented best-effort limitation rather than a tested guarantee
