# Delta for Migration History Integrity

## MODIFIED Requirements

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
