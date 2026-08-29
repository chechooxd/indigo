# Delta for Studio Server Tests

## ADDED Requirements

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
</content>
