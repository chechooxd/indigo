# Studio Server Tests Specification

## Purpose

`packages/cli` has zero tests today. This spec establishes its first test
harness, scoped to proving the four Studio server hardening blockers are
fixed, and wires it into `pnpm test`.

## Requirements

### Requirement: Harness spins up a real Studio server instance

The test harness MUST start `startStudio` (or an equivalent entry point)
against a real or real-enough PostgreSQL instance and issue actual HTTP
requests against it, rather than mocking `node:http` or `pg`.

#### Scenario: Harness boots the server and a database for the test run

- GIVEN the test suite is invoked
- WHEN the harness sets up a test case
- THEN it starts a Postgres instance (or connects to one provisioned for
  tests) and starts the Studio server bound to an ephemeral local port
- AND it tears both down after the test case completes

### Requirement: Coverage of all four hardening blockers

The harness MUST include at least one scenario per blocker, each proving the
behavior fails before the fix and passes after it:

1. Bind defaults to loopback; explicit opt-in required for remote bind.
2. `datasource` is absent from `/api/schema` and `/api/schema/source`.
3. The CTE-wrapped `DELETE` regression query is rejected with no row change.
4. A cross-origin request is rejected.

#### Scenario: Bind default is asserted

- GIVEN the server is started with no host override
- WHEN a client attempts to connect via a non-loopback address
- THEN the connection is refused or unreachable, proving the loopback default

#### Scenario: Redaction is asserted

- GIVEN a schema with a literal datasource URL
- WHEN the harness requests `/api/schema` and `/api/schema/source`
- THEN neither response contains the connection string or a `datasource` key

#### Scenario: Write-via-CTE regression is asserted

- GIVEN a seeded `"User"` table with existing rows
- WHEN the harness sends the CTE-wrapped `DELETE` payload to `/api/query`
- THEN the request fails and the row count is unchanged

#### Scenario: Cross-origin rejection is asserted

- GIVEN the server is running
- WHEN the harness sends a request with a mismatched `Origin` header
- THEN the response status is 403

### Requirement: Write-route coverage on the PGlite-backed harness

The harness MUST cover UPDATE, INSERT, and DELETE row routes against the writable pool,
including composite primary keys, identifier-injection rejection, and a regression
scenario proving the read-only path is unaffected by the write routes' existence.

#### Scenario: UPDATE by single and composite primary key

- GIVEN seeded tables with a single-column and a composite primary key
- WHEN the harness sends `PATCH` for each
- THEN each targeted row is updated and no other row changes

#### Scenario: INSERT returns the generated primary key

- GIVEN a table with a database-generated primary key
- WHEN the harness sends `POST` with the remaining column values
- THEN the response includes the generated key and the row exists in the database

#### Scenario: DELETE removes exactly one row by composite key

- GIVEN a table with a composite primary key and multiple rows
- WHEN the harness sends `DELETE` for one full key combination
- THEN only that row is removed

#### Scenario: Unknown table/column identifiers are rejected

- GIVEN a write request references a table or column absent from the resolved schema
- WHEN the harness sends that request
- THEN the response is an error (4xx) and no SQL statement executes

#### Scenario: Existing read-only regression still passes with write routes present

- GIVEN the writable pool and routes are registered
- WHEN the harness re-runs the CTE-wrapped `DELETE`-via-`/api/query` regression
- THEN it still fails with no row change, proving the read-only path was not
  broadened by adding write routes

### Requirement: Wired into `pnpm test`

The harness MUST run as part of `packages/cli`'s `test` script, and that
script MUST be reachable through the root `pnpm test` (Turborepo) run.

#### Scenario: Root test run includes the new harness

- GIVEN a clean checkout
- WHEN `pnpm test` is run from the repo root
- THEN `packages/cli`'s new test suite executes and its results are reported
- AND a failing scenario in this suite fails the overall `pnpm test` run
</content>
