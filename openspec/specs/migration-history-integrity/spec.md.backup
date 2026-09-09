# Migration History Integrity Specification

## Purpose

Defines the shape and enforcement of `_indigo_migrations` as an integrity
ledger, not just an applied-set: a `checksum` of each migration's exact
on-disk bytes and a forward-compatible `success` flag, computed at apply
time and enforced at deploy time and reported at status time, so an
already-applied `migration.sql` cannot be silently edited and replayed.

## Requirements

### Requirement: `_indigo_migrations` records a checksum and a success flag per row

The system MUST add a `checksum` (text) column and a `success` (boolean)
column to `_indigo_migrations`, in addition to the existing
`id, name, applied_at` columns. Both columns MUST be created idempotently:
`CREATE TABLE IF NOT EXISTS` for a fresh install, and an
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` path for a table that already
exists without them.

#### Scenario: Fresh install creates the full column set

- GIVEN no `_indigo_migrations` table exists in the target database
- WHEN `ensureHistory` runs
- THEN the created table has `id`, `name`, `applied_at`, `checksum`, and `success` columns

#### Scenario: Existing table without checksum/success is upgraded in place

- GIVEN `_indigo_migrations` already exists with only `id`, `name`, `applied_at`
- WHEN `ensureHistory` runs against it
- THEN `checksum` and `success` columns are added without dropping or altering any existing row

### Requirement: Checksum is a sha256 hex digest of the exact `migration.sql` bytes

When a migration is applied, the system MUST compute the checksum as the
sha256 hex digest of the exact byte content of that migration's
`migration.sql` file, read through the same I/O-injection seam used
elsewhere for migration content, and store it alongside the recorded row.

#### Scenario: Applying a migration records its content checksum

- GIVEN a pending migration directory with a `migration.sql` file
- WHEN `migrate dev` or `migrate deploy` applies it successfully
- THEN the recorded row's `checksum` equals the sha256 hex digest of that file's exact bytes at apply time

### Requirement: A legacy history table silently backfills checksums on first touch

If `_indigo_migrations` already contains rows recorded before the
`checksum` column existed (legacy rows with no stored checksum), the system
MUST compute and store a checksum for each such row from its current
on-disk `migration.sql` content the first time the new code runs against
that table. This backfill MUST happen automatically, without any user
prompt, flag, or confirmation step.

#### Scenario: Legacy table backfills without prompting

- GIVEN a pre-existing `_indigo_migrations` table with rows recorded under the old three-column schema
- WHEN the new code first runs `migrate dev`, `migrate deploy`, or `migrate status` against it
- THEN each legacy row is backfilled with a checksum computed from its current on-disk file, and no prompt or confirmation is presented to the user

#### Scenario: Backfilled checksum trusts current on-disk content once

- GIVEN a legacy row is backfilled from its current on-disk `migration.sql`
- WHEN a later run recomputes that migration's checksum
- THEN drift is detected only relative to the content present at backfill time, not any earlier unknown state

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

### Requirement: `success` is recorded as a forward-compatible column with no enforcement yet

The system MUST record a `success` boolean on every applied migration row.
Because failed migrations are currently rolled back and discarded before
any row is written (dev: file removal; deploy: transaction rollback), this
change MUST NOT introduce any new behavior that persists a failed-migration
row or gates re-application based on `success`. The column exists to avoid
a future breaking schema change, not to change today's failure handling.

#### Scenario: Successful migrations record `success = true`

- GIVEN a migration applies without error
- WHEN its row is recorded in `_indigo_migrations`
- THEN `success` is stored as `true`

#### Scenario: A failed migration still leaves no row, unchanged from today

- GIVEN a migration fails during application
- WHEN the failure is handled (dev: file removal; deploy: transaction rollback)
- THEN no row for that migration is recorded, and `success = false` rows do not yet appear in `_indigo_migrations`
