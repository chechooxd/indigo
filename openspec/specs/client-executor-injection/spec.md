# Client Executor Injection Specification

## Purpose

`IndigoClientBase` (`packages/client/src/client.ts`) MUST support constructing a client
from a pre-built query executor, in addition to today's `pg.Pool`-only construction,
without changing default behavior for existing consumers.

## Requirements

### Requirement: Default pg.Pool construction is unchanged

When no executor is injected, `IndigoClientBase` MUST construct and use a `pg.Pool`
exactly as it does today, including the missing-connection-string error.

#### Scenario: No connection string, no pool, no executor

- GIVEN `IndigoClientOptions` has no `connectionString`, no `options.pool`, no injected executor, and `process.env.DATABASE_URL` is unset
- WHEN `IndigoClientBase` is constructed
- THEN it MUST throw `Error("IndigoClient: no connection string. Pass \`connectionString\` or set DATABASE_URL.")` — the exact string used today

#### Scenario: Only connectionString supplied

- GIVEN `IndigoClientOptions` has only `connectionString` set and no injected executor
- WHEN `IndigoClientBase` is constructed
- THEN construction MUST succeed
- AND `this.exec` MUST route queries through a `pg.Pool` built from that connection string, identically to today

### Requirement: Executor injection bypasses pool construction

When an executor is supplied via the injection path, `IndigoClientBase` MUST use it for
all queries and MUST NOT construct a `pg.Pool`.

#### Scenario: Executor supplied, no connectionString, no options.pool

- GIVEN `IndigoClientOptions` supplies an injected executor and no `connectionString`, no `options.pool`, and no `DATABASE_URL`
- WHEN `IndigoClientBase` is constructed
- THEN construction MUST succeed without throwing the missing-connection-string error
- AND no `pg.Pool` MUST be constructed

#### Scenario: All queries route through the injected executor

- GIVEN a client constructed with an injected executor
- WHEN any model delegate or `$queryRaw` issues a query
- THEN the injected executor MUST be invoked instead of a `pg.Pool`

### Requirement: $queryRaw is path-independent

`$queryRaw` MUST behave identically regardless of whether `this.exec` was built from a
`pg.Pool` or from an injected executor.

#### Scenario: $queryRaw on the injected path

- GIVEN a client constructed with an injected executor
- WHEN `$queryRaw(sql, params)` is called
- THEN it MUST return the same rows the injected executor resolves with, exactly as it would for the `pg.Pool` path with equivalent data

### Requirement: $disconnect closes whichever seam exists

`$disconnect()` MUST close a real `pg.Pool` when one was constructed, MUST call an
injected `close` when one was supplied and exists, and MUST NOT throw when an injected
executor was supplied without a `close`.

#### Scenario: Default path closes the pool

- GIVEN a client constructed on the default `pg.Pool` path
- WHEN `$disconnect()` is called
- THEN it MUST call `pool.end()` on the constructed pool

#### Scenario: Injected path with close calls close

- GIVEN a client constructed with an injected executor and a `close` function
- WHEN `$disconnect()` is called
- THEN it MUST call the injected `close` function
- AND it MUST NOT attempt to call `pool.end()`

#### Scenario: Injected path without close does not throw

- GIVEN a client constructed with an injected executor and no `close` function supplied
- WHEN `$disconnect()` is called
- THEN it MUST resolve without throwing

### Requirement: Realtime teardown is unaffected by construction path

`$disconnect()` MUST tear down the `$realtime()` connection manager identically on both
the default and injected-executor construction paths.

#### Scenario: Realtime torn down on the default path

- GIVEN a client constructed on the default `pg.Pool` path with `$realtime()` having been invoked at least once
- WHEN `$disconnect()` is called
- THEN the realtime connection manager MUST be closed and cleared

#### Scenario: Realtime torn down on the injected path

- GIVEN a client constructed with an injected executor, with `$realtime()` having been invoked at least once
- WHEN `$disconnect()` is called
- THEN the realtime connection manager MUST be closed and cleared, identically to the default path
