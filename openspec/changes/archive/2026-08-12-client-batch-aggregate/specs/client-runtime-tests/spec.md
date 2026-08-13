# Delta for client-runtime-tests

## ADDED Requirements

### Requirement: pglite suites cover every new batch/cursor/aggregate/upsert operation

The test suite MUST gain one pglite-backed suite per PR (`batch`, `cursor`,
`aggregate`, `upsert`), each covering at minimum its happy path and its
typed-error rejection path, using the existing PGlite-backed executor
adapter.

#### Scenario: Batch suite covers happy path and EMPTY_WHERE rejection

- GIVEN the PGlite-backed executor adapter and a seeded `Tag` table
- WHEN the batch suite runs
- THEN it MUST assert `createMany` inserts all rows atomically and returns
  the correct count
- AND it MUST assert `updateMany`/`deleteMany` with an empty `where` throws
  `IndigoWhereError` with `code: "EMPTY_WHERE"`

#### Scenario: Cursor suite covers pagination and composite-PK rejection

- GIVEN the PGlite-backed executor adapter, a single-column PK model, and a
  composite-PK model
- WHEN the cursor suite runs
- THEN it MUST assert `findMany({ cursor, take })` pages correctly on the
  single-column PK model
- AND it MUST assert the composite-PK model throws the typed cursor-rejection
  error

#### Scenario: Aggregate suite covers numeric enforcement

- GIVEN the PGlite-backed executor adapter and a model with a numeric and a
  non-numeric field
- WHEN the aggregate suite runs
- THEN it MUST assert `aggregate`/`groupBy` compute correct sums/averages/
  counts against real PGlite rows
- AND it MUST assert requesting `_sum`/`_avg` on the non-numeric field throws
  a typed error before SQL is issued

#### Scenario: Upsert suite covers create/update branches and non-unique rejection

- GIVEN the PGlite-backed executor adapter and a model with a declared unique
  constraint
- WHEN the upsert suite runs
- THEN it MUST assert `upsert` creates when no row matches and updates when
  one does
- AND it MUST assert a `where` not matching a declared unique group throws a
  typed error before SQL is issued
</content>
