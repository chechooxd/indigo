# Migrate Deploy Concurrency Specification

## Purpose

Defines a session-level Postgres advisory lock around `migrate deploy` so
that two concurrent deploy runs against the same database (racing CI jobs,
or CI racing a manual deploy) cannot both apply migrations at once. The
lock is fail-fast: a run that cannot acquire it refuses immediately rather
than blocking, retrying, or waiting. `migrate dev` and `migrate status` are
unaffected.

## Requirements

### Requirement: `migrate deploy` acquires a session-level advisory lock before applying any pending migration

Before running `ensureHistory` or `checksumPreflight`, and before applying
any pending migration, `migrate deploy` MUST attempt to acquire a
session-level Postgres advisory lock (`pg_try_advisory_lock`) on the single
connection it holds for the run, using one well-known constant int64 key.
The key MUST NOT be user-configurable.

#### Scenario: Deploy acquires the lock before touching migration history

- GIVEN `migrate deploy` starts against an unlocked database
- WHEN the run begins
- THEN `pg_try_advisory_lock` with the well-known constant key is called before `ensureHistory` and before any pending migration is applied

### Requirement: `migrate deploy` refuses immediately when the lock is already held, with no blocking, retry, or timeout

If `pg_try_advisory_lock` reports the lock is already held, `migrate
deploy` MUST refuse to apply any pending migration and MUST set
`process.exitCode = 1` with a clear message naming the lock conflict,
without throwing. The system MUST NOT block, wait, retry, or apply a
timeout before refusing — contention is reported on the first attempt.

#### Scenario: A second concurrent deploy refuses immediately

- GIVEN one `migrate deploy` run already holds the advisory lock on a database
- WHEN a second `migrate deploy` run starts against the same database
- THEN the second run's `pg_try_advisory_lock` attempt reports the lock is held, `process.exitCode` is set to `1`, a message naming the lock conflict is shown, and no pending migration is applied by the second run

#### Scenario: Lock refusal does not block, wait, or retry

- GIVEN `migrate deploy` fails to acquire the advisory lock
- WHEN the refusal is reported
- THEN the run returns immediately without waiting, retrying the acquisition, or applying any timeout

### Requirement: The advisory lock is released on both success and failure

`migrate deploy` MUST release the advisory lock (`pg_advisory_unlock`)
before or alongside closing the connection, on every exit path: after all
pending migrations apply successfully, and after any migration fails
partway through the run. A run that never acquired the lock (refused on
contention) MUST NOT attempt to release it.

#### Scenario: Lock is released after a successful deploy

- GIVEN `migrate deploy` acquired the advisory lock and applied all pending migrations successfully
- WHEN the run finishes
- THEN `pg_advisory_unlock` with the same well-known key is called before or alongside the connection closing

#### Scenario: Lock is released after a failed migration mid-run

- GIVEN `migrate deploy` acquired the advisory lock and a pending migration fails partway through the run
- WHEN the failure is handled
- THEN `pg_advisory_unlock` with the same well-known key is still called before or alongside the connection closing

### Requirement: `migrate dev` and `migrate status` are unaffected

The advisory lock MUST be scoped to `migrate deploy` only. `migrate dev`
and `migrate status` MUST NOT acquire, check, or release this lock, and
their existing behavior MUST remain unchanged.

#### Scenario: `migrate dev` runs without touching the lock

- GIVEN a database with or without the advisory lock held by a `migrate deploy` run
- WHEN `migrate dev` runs
- THEN it does not call `pg_try_advisory_lock`, `pg_advisory_lock`, or `pg_advisory_unlock`, and its existing apply behavior is unchanged

#### Scenario: `migrate status` runs without touching the lock

- GIVEN a database with or without the advisory lock held by a `migrate deploy` run
- WHEN `migrate status` runs
- THEN it does not call `pg_try_advisory_lock`, `pg_advisory_lock`, or `pg_advisory_unlock`, and its existing reporting behavior is unchanged

### Requirement: There is no flag or configuration to bypass the lock

`migrate deploy` MUST NOT provide any flag, environment variable, or
configuration option to skip lock acquisition, override a contention
refusal, or change the lock key.

#### Scenario: No override surface exists for lock contention

- GIVEN a `migrate deploy` run refuses due to lock contention
- WHEN the user attempts to proceed anyway
- THEN no documented flag, environment variable, or configuration bypasses the acquisition or the refusal

## Non-Normative Notes

- **Test-coverage limitation**: PGlite, this repository's only test harness
  for `migrate-runner.ts`, has an open upstream bug (PGlite issue #704)
  where `pg_advisory_lock` does not actually block on repeated acquisition
  against the same key, and PGlite is a single in-process instance, so
  genuinely racing connections cannot be simulated. As a result, tests for
  this capability assert the SQL call sequence and key (lock acquired
  before any migration runs, unlock called on both the success and failure
  paths) via a spy/mock `MigrationClient`, rather than asserting real lock
  contention end-to-end. This is a known, accepted gap, not a hidden one;
  true contention behavior is a manual/real-Postgres verification concern.
