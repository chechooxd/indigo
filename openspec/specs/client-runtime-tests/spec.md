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
