# Delta for Client Driver Adapters

## MODIFIED Requirements

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
