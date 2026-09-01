# Client Runtime Tests Specification

## Purpose

`packages/client` currently has zero tests and no `test` script. This capability
establishes a minimal, plain-Node test harness — matching the house style already
proven in `packages/migrator/test/pg-harness.mjs` and `packages/cli/test/studio-harness.mjs`
— backed by a test-only PGlite-based executor adapter, so the executor-injection seam
can be exercised without a live PostgreSQL.

## Requirements

### Requirement: Plain-Node harness matching house style

`packages/client` MUST gain a test suite runnable via a `test` script, written in plain
Node (no test framework), consistent with the existing package conventions.

#### Scenario: Test script exists and runs

- GIVEN `packages/client/package.json`
- WHEN `pnpm test` is run for `@indigodb/client`
- THEN it MUST execute the package's test files with plain Node and exit non-zero on any failure

### Requirement: PGlite-backed executor adapter

The test suite MUST provide a test-only executor adapter backed by PGlite, mirroring the
proven pattern of `pg-harness.mjs` / `studio-harness.mjs`, usable as the injected executor
for `IndigoClientBase`.

#### Scenario: Adapter satisfies the Executor contract

- GIVEN the PGlite-backed adapter
- WHEN it is passed as the injected executor to `IndigoClientBase`
- THEN it MUST accept `(sql, params)` and resolve with result rows, matching the `Executor` type contract

### Requirement: Regression coverage for the executor seam

The test suite MUST include at least one scenario per requirement in
`client-executor-injection` that would fail before the fix and pass after it.

#### Scenario: Disconnect guard regression

- GIVEN a client constructed with the injected PGlite executor and no `close` function
- WHEN `$disconnect()` is called
- THEN the test MUST assert it resolves without throwing — this scenario crashes on `this.pool.end()` against `undefined` before the fix

#### Scenario: Missing-connection-string error regression

- GIVEN a client constructed with no `connectionString`, no `options.pool`, no injected executor, and no `DATABASE_URL`
- WHEN construction is attempted
- THEN the test MUST assert the thrown error message is exactly `"IndigoClient: no connection string. Pass \`connectionString\` or set DATABASE_URL."`

#### Scenario: CRUD passthrough regression

- GIVEN a client constructed with the injected PGlite executor against a schema-backed table
- WHEN a model delegate performs `create`, `findMany`, `update`, and `delete`
- THEN each operation MUST succeed against PGlite exactly as it would against real PostgreSQL, proving `this.exec` is path-independent

### Requirement: pglite suites cover the write-precondition and unique-selector guards

The test suite MUST gain pglite-backed coverage for `client-write-preconditions`
and `client-unique-write-selector`, exercising every guard at every affected
site, plus the flipped nested-write zero-match case.

#### Scenario: Empty-SET suite covers both the direct path and the relation-ops-guarded path

- GIVEN the PGlite-backed executor adapter and a seeded `User` table
- WHEN the empty-`SET` suite runs
- THEN it MUST assert `db.user.update({ where, data: { name: undefined } })`
  (no relation ops) throws `IndigoArgumentError` with `code: "EMPTY_UPDATE_DATA"`
  before any SQL is issued
- AND it MUST assert the pre-existing relation-ops-only empty-scalar guard
  still throws its own error unchanged (regression pin)

#### Scenario: Not-found suite covers all three write sites

- GIVEN the PGlite-backed executor adapter and a seeded `User`/`Post` schema
  with no row matching a chosen id
- WHEN the not-found suite runs
- THEN it MUST assert a zero-row `update` on the direct scalar path throws
  `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND it MUST assert a zero-row `delete` throws the same error
- AND it MUST assert a zero-row `update` whose `data` contains only relation
  operations (no scalar fields) also throws the same error

#### Scenario: nested-writes-update.mjs C1.4c is rewritten to assert the throw

- GIVEN `packages/client/test/nested-writes-update.mjs` case C1.4c, which
  previously asserted `result === undefined` for a zero-match
  relation-ops-only `update`
- WHEN the suite runs after this change
- THEN C1.4c MUST assert the call rejects with `IndigoNotFoundError` and
  `code: "RECORD_NOT_FOUND"`
- AND MUST NOT retain any assertion that the call resolves with `undefined`

#### Scenario: Unique-selector suite covers accept, reject, and ambiguous-target interaction

- GIVEN the PGlite-backed executor adapter and a model whose generated
  `__meta.uniqueGroups` declares a group with no matching database-level
  unique constraint, seeded with two rows sharing that value
- WHEN the unique-selector suite runs
- THEN it MUST assert `update`/`delete` with a `where` matching the declared
  unique group succeeds
- AND it MUST assert an `as any` bypass with a `where` matching no declared
  unique group throws `IndigoArgumentError` with `code: "NO_MATCHING_UNIQUE_CONSTRAINT"`
  before any SQL is issued
- AND it MUST assert `update` with both relation ops and a `where` that
  passes the unique-shape check but matches multiple rows still throws
  `IndigoNestedWriteError` with `code: "AMBIGUOUS_UPDATE_TARGET"`, unshadowed
  by the unique-selector guard

#### Scenario: findUnique and *Many where semantics are pinned as non-regressions

- GIVEN the PGlite-backed executor adapter and a model with a non-unique
  field
- WHEN the regression suite runs
- THEN it MUST assert `findUnique` still accepts a non-unique `where` and
  returns `Payload | null`
- AND it MUST assert `updateMany`/`deleteMany` still accept a non-unique,
  potentially multi-row-matching `where`

## ADDED Requirements (client-batch-aggregate)

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
