# Client Database Errors Specification

## Purpose

Real Postgres failures (unique violation, FK violation, connection loss, etc.)
currently escape `@indigodb/client` unwrapped, forcing callers to string-match
SQLSTATE on an untyped `Error`. This capability introduces a typed
`IndigoDatabaseError` with a stable, minimal code taxonomy, wrapping pg
errors at every exec site without losing the original error.

## Requirements

### Requirement: `IndigoDatabaseError` wraps driver-level Postgres failures

`IndigoDatabaseError` MUST extend `Error` and expose a `code` field whose
value is one of a minimal taxonomy: `"UNIQUE_VIOLATION"` for SQLSTATE
`23505`, and `"UNKNOWN"` for every other pg `DatabaseError`. `IndigoClientBase`
MUST wrap and throw `IndigoDatabaseError` at every SQL exec site: the pool
path and both `$withSession` raw `client.query` calls.

#### Scenario: Unique violation is classified

- GIVEN a Postgres query fails with SQLSTATE `23505`
- WHEN the client executes that query through any exec site (pool or
  `$withSession`)
- THEN it MUST throw an `IndigoDatabaseError` whose `code` is
  `"UNIQUE_VIOLATION"`

#### Scenario: Non-unique-violation failures fall into UNKNOWN

- GIVEN a Postgres query fails with a SQLSTATE other than `23505` (e.g. FK
  violation `23503`, connection loss)
- WHEN the client executes that query
- THEN it MUST throw an `IndigoDatabaseError` whose `code` is `"UNKNOWN"`

#### Scenario: Non-pg errors are not wrapped as database errors

- GIVEN an exec site throws an error that is not a pg `DatabaseError`
  (e.g. a JS `TypeError` from caller misuse)
- WHEN that error propagates
- THEN it MUST NOT be wrapped into `IndigoDatabaseError`

### Requirement: Original pg error and SQLSTATE are preserved, never swallowed

`IndigoDatabaseError` MUST preserve the original pg `DatabaseError` instance
on its `cause` property, and MUST expose the raw SQLSTATE string on the
wrapper itself (e.g. a `sqlstate` field), so callers needing detail beyond
the minimal taxonomy can still inspect the original failure.

#### Scenario: cause chain is intact

- GIVEN a query fails with any SQLSTATE
- WHEN the resulting `IndigoDatabaseError` is caught
- THEN `error.cause` MUST be the original pg `DatabaseError` instance
- AND `error.cause` MUST NOT be `undefined` or a re-serialized copy

#### Scenario: raw SQLSTATE is exposed alongside the taxonomy code

- GIVEN a query fails with SQLSTATE `23503` (foreign key violation)
- WHEN the resulting `IndigoDatabaseError` is caught
- THEN `error.code` MUST be `"UNKNOWN"`
- AND the wrapper MUST still expose `"23503"` as the raw SQLSTATE value
</content>
