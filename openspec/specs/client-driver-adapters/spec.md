# Client Driver Adapters Specification

## Purpose

The `Executor` injection seam (`client-executor-injection`) is anonymous: callers must
hand-write `{ exec, transaction, close }` and can silently lose `$transaction` support or
typed `IndigoDatabaseError`s. This capability defines named, exported adapter factories
that produce `IndigoClientOptions["db"]` values carrying the same parity guarantees as the
built-in `connectionString` path, plus the refactor that makes `connectionString`
construction reuse the pg adapter internally.

## Requirements

### Requirement: `createPgAdapter` accepts a PoolConfig or an existing Pool

`createPgAdapter` MUST accept either a `pg.PoolConfig` (and construct an internally-owned
`pg.Pool` from it) or an existing `pg.Pool` instance (and embed over it without taking
ownership of its lifecycle). Both forms MUST return an object shaped as
`IndigoClientOptions["db"]`.

#### Scenario: Constructed from PoolConfig

- GIVEN `createPgAdapter` is called with a `PoolConfig` object
- WHEN the adapter is used to build a client
- THEN a new `pg.Pool` MUST be constructed from that config
- AND queries issued through the client MUST route through that pool

#### Scenario: Constructed from an existing Pool

- GIVEN `createPgAdapter` is called with an already-constructed `pg.Pool` instance
- WHEN the adapter is used to build a client
- THEN the adapter MUST use that exact pool instance for queries
- AND MUST NOT construct a second pool

#### Scenario: Caller-owned pool is not closed by the adapter

- GIVEN `createPgAdapter` was called with an existing `pg.Pool` instance
- WHEN the resulting client's `$disconnect()` (or adapter `close`) is invoked
- THEN the adapter MUST NOT call `.end()` on that pool
- AND the pool MUST remain usable by the caller after disconnect

#### Scenario: Adapter-owned pool is closed on disconnect

- GIVEN `createPgAdapter` was called with a `PoolConfig` (adapter constructs its own pool)
- WHEN the resulting client's `$disconnect()` is invoked
- THEN the adapter MUST call `.end()` on the pool it constructed

### Requirement: `createPgAdapter` provides full transaction-hook parity

`createPgAdapter` MUST include a `transaction` hook equivalent to the built-in
`connectionString` path: it MUST check out a client from the pool, issue `BEGIN`, run the
caller's callback, issue `COMMIT` on success or `ROLLBACK` on failure, and release the
client back to the pool in a poison-aware manner (passing a poison signal to
`client.release` when the transaction could not be safely reset).

#### Scenario: Transaction commits on success via the adapter path

- GIVEN a client built with `createPgAdapter`
- WHEN `$transaction(fn)` is called and `fn` resolves without throwing
- THEN the underlying pool client MUST receive `BEGIN` then `COMMIT`
- AND the pool client MUST be released back to the pool

#### Scenario: Transaction rolls back on failure via the adapter path

- GIVEN a client built with `createPgAdapter`
- WHEN `$transaction(fn)` is called and `fn` throws
- THEN the underlying pool client MUST receive `BEGIN` then `ROLLBACK`
- AND the error MUST propagate to the caller of `$transaction`

#### Scenario: Adapter-path transaction behaves identically to connectionString-path

- GIVEN two clients — one built via `connectionString` and one built via
  `createPgAdapter` pointed at an equivalent database
- WHEN the same `$transaction(fn)` sequence is run against each
- THEN both clients MUST exhibit identical commit/rollback/release behavior

### Requirement: `createPgAdapter` preserves typed database errors

`createPgAdapter` MUST re-apply `withDatabaseErrors` wrapping to its exec sites so that
Postgres failures surfaced through the adapter path throw `IndigoDatabaseError` exactly as
they do on the built-in `connectionString` path.

#### Scenario: Typed error thrown via the adapter path

- GIVEN a client built with `createPgAdapter`
- WHEN a query fails with a Postgres SQLSTATE (e.g. `23505`)
- THEN the client MUST throw an `IndigoDatabaseError` with the corresponding taxonomy
  `code`, identically to the `connectionString` path

### Requirement: `IndigoClientBase`'s default constructor delegates to `createPgAdapter`

When `IndigoClientBase` is constructed with a `connectionString` (or `options.pool`) and no
injected executor, it MUST build its `db` internally by calling `createPgAdapter`, rather
than duplicating pool/transaction/error-wrapping logic in the constructor. This MUST NOT
change any observable behavior of the `connectionString` construction path.

#### Scenario: connectionString path is behavior-preserving after the refactor

- GIVEN a client constructed with only `connectionString`
- WHEN queries, `$transaction`, error handling, and `$disconnect` are exercised
- THEN observed behavior MUST be identical to the pre-refactor implementation
- AND `IndigoClientBase` MUST NOT re-implement pool/transaction/error logic separately from
  `createPgAdapter`

### Requirement: `createPGliteAdapter` promotes the PGlite test harness to a public export

`createPGliteAdapter(pglite)` MUST accept a structurally-typed `{ query, transaction }`
object (matching the shape already used by `test/pglite-harness.mjs`'s
`createPgliteDb`) and return an `IndigoClientOptions["db"]` value, without importing any
PGlite runtime type into the public package surface. PGlite MUST remain a devDependency
only. `createPGliteAdapter` MUST re-apply `withDatabaseErrors` wrapping to both of its exec
sites — the pool-equivalent `exec` used outside a transaction, and the executor handed to
the caller's callback inside `transaction(fn)` — so PGlite failures surface as typed
`IndigoDatabaseError`, matching `createPgAdapter`'s existing error-parity requirement.
PGlite exposes no `BEGIN`/`COMMIT` statement sites of its own (it wraps its native
`transaction(tx => …)` API instead of issuing those statements), so parity for this adapter
is scoped to wrapping the two query exec sites; the outer `transaction()` call's own
rejection path is not a separate statement site and needs no additional wrapping beyond
what wrapping the transaction-scoped exec already provides.
(Previously: this requirement covered only the public-export shape and the
no-runtime-dependency constraint; it did not address error typing on either exec path.)

#### Scenario: Client built through the PGlite adapter executes queries

- GIVEN a PGlite instance is passed to `createPGliteAdapter`
- WHEN the resulting client executes a query
- THEN the query MUST run against the PGlite instance and return matching rows

#### Scenario: No PGlite runtime dependency is introduced

- GIVEN `packages/client/package.json`
- WHEN its `dependencies` are inspected
- THEN PGlite MUST NOT appear as a runtime dependency (devDependency only)

#### Scenario: Typed error thrown on a plain exec

- GIVEN a client built with `createPGliteAdapter`
- WHEN a query outside a transaction fails with a unique-constraint violation
- THEN the client MUST throw an `IndigoDatabaseError` with `code === "UNIQUE_VIOLATION"`
  and `sqlstate === "23505"`
- AND the error's `cause` MUST be the original PGlite error instance

#### Scenario: Typed error thrown inside a transaction callback

- GIVEN a client built with `createPGliteAdapter`
- WHEN `$transaction(fn)` is called and a query inside `fn` fails with a unique-constraint
  violation
- THEN the client MUST throw an `IndigoDatabaseError` with `code === "UNIQUE_VIOLATION"`
  and `sqlstate === "23505"`
- AND the error's `cause` MUST be the original PGlite error instance

#### Scenario: Non-database error still receives best-effort typing

- GIVEN a client built with `createPGliteAdapter`
- WHEN a query fails for a reason that is not a Postgres SQLSTATE (e.g. malformed SQL
  rejected before execution)
- THEN the error MUST still pass through `withDatabaseErrors`
- AND classification MUST follow the existing structural `sqlstateOf()` check (`"code" in
  err`), producing the same best-effort typed or passthrough result as `createPgAdapter`
  would for an equivalent non-SQLSTATE failure

### Requirement: Neon is documented as a recipe, not a bundled adapter

The bring-your-own-driver documentation MUST include a Neon HTTP driver recipe shaped as an
`Executor`, MUST state that Neon's serverless HTTP transport cannot honor the session-bound
`transaction` hook contract (no persistent connection to `BEGIN`/`COMMIT`/`ROLLBACK` on),
and MUST NOT be backed by a `createNeonAdapter` export or a new `@neondatabase/serverless`
dependency.

#### Scenario: Documentation exists without a code adapter

- GIVEN the bring-your-own-driver guide
- WHEN a reader looks for Neon support
- THEN they MUST find a documented `Executor`-shaping recipe
- AND `@indigodb/client` MUST NOT export `createNeonAdapter`
- AND `packages/client/package.json` MUST NOT gain a Neon dependency

#### Scenario: Documented recipe discloses the transaction-hook limitation

- GIVEN a reader follows the Neon recipe
- WHEN they check whether `$transaction` is supported
- THEN the documentation MUST state that the Neon HTTP driver cannot supply a working
  `transaction` hook due to its stateless request model
