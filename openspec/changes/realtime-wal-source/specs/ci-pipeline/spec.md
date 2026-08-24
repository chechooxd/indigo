# Delta for CI Pipeline

## ADDED Requirements

### Requirement: Postgres job runs the real-Postgres realtime suite

A fourth, independent `postgres` job MUST run in a real Postgres service container started
with `-c wal_level=logical`, executing the `@indigodb/realtime` real-Postgres test harness
(logical replication parity and resume-after-disconnect tests). The job MUST have no `needs:`
dependency on `ts`, `rust`, or `wasm-drift`, so its failure is isolated and visible without
gating or being gated by the other jobs.

#### Scenario: Postgres job passes on unmodified WAL source code

- GIVEN `packages/realtime/src/wal-source.ts` and the replication DDL are unchanged from `main`
- WHEN the `postgres` job runs against a `wal_level=logical` service container
- THEN the real-Postgres realtime suite passes

#### Scenario: Postgres job fails on a broken WAL source change

- GIVEN a pull request introduces a change that breaks WAL event parity or resume behavior
- WHEN the `postgres` job runs
- THEN it fails, and the overall workflow run reports failure independently of `ts`/`rust`/`wasm-drift`

### Requirement: TS job stays Postgres-service-free

The `ts` job MUST NOT start or depend on a Postgres service container or Docker; any test
requiring a real Postgres with `wal_level=logical` belongs exclusively to the `postgres` job.
The `ts` job's existing PGlite-based (in-process) tests are unaffected and remain in `ts`.

#### Scenario: TS job succeeds with no external Postgres

- GIVEN the `ts` job's runner has no Postgres service container configured
- WHEN `pnpm install`, `pnpm build`, `pnpm lint`, and `pnpm test` run
- THEN all four succeed using only in-process PGlite, with no external Postgres dependency

## MODIFIED Requirements

### Requirement: Any failing job fails the run

If any of the four jobs (TS, Rust, WASM drift, Postgres) fails, the overall workflow run MUST
report failure.
(Previously: covered three jobs — TS, Rust, WASM drift — before the `postgres` job existed.)

#### Scenario: One red job reds the whole run

- GIVEN the TS, Rust, and WASM drift jobs pass but the Postgres job fails
- WHEN the workflow run completes
- THEN the overall run status MUST be failure

#### Scenario: WASM drift alone still reds the run

- GIVEN the TS, Rust, and Postgres jobs pass but the WASM drift job fails
- WHEN the workflow run completes
- THEN the overall run status MUST be failure
