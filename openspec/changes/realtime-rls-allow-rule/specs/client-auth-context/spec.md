# Client Auth Context Specification

## Purpose

Defines the `@indigodb/client` `$auth` API that binds the RLS identity (`auth.userId`) to a
Postgres session via a transaction-scoped `SET LOCAL`, and the guarantees that prevent identity
leakage across pooled connections.

## Requirements

### Requirement: `$auth({ userId })` runs inside a transaction with `SET LOCAL`

`IndigoClientBase` MUST expose `$auth({ userId })`, which opens a transaction and issues
`SET LOCAL app.user_id = <value>` before delegating the wrapped queries to the underlying
`ModelDelegate`. The client MUST NOT use `SET` (session-scoped) for this purpose.

#### Scenario: `$auth` scopes queries to the identity

- GIVEN a client calling `$auth({ userId: "u1" })` and reading a model with
  `@@allow(read, auth.userId == this.ownerId)`
- WHEN the query executes
- THEN only rows where `ownerId == "u1"` are returned

#### Scenario: `SET LOCAL`, not `SET`, is used

- GIVEN any `$auth({ userId })` call
- WHEN the underlying SQL is inspected
- THEN the identity-binding statement is `SET LOCAL`, never a session-scoped `SET`

### Requirement: A query without `$auth` sees no protected rows

Queries executed outside an `$auth` context MUST NOT read or write rows governed by an
`@@allow` policy, relying on native Postgres deny-by-default RLS behavior rather than any
client-side check.

#### Scenario: Unauthenticated read returns nothing

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and existing owned rows
- WHEN a query runs without calling `$auth` first
- THEN the query returns zero rows for that model

### Requirement: A recycled pooled connection carries no prior identity

Because `SET LOCAL` is transaction-scoped, a connection returned to the pool after an `$auth`
transaction commits or rolls back MUST NOT retain the previous `app.user_id` value for any
subsequent, unrelated query on that connection.

#### Scenario: Identity does not leak across pool reuse

- GIVEN a pooled connection used inside `$auth({ userId: "u1" })` and then released back to
  the pool
- WHEN a different, unauthenticated query later reuses that same physical connection
- THEN that query observes no `app.user_id` setting from the prior `$auth` call

### Requirement: `$auth` is additive and does not alter existing call sites

Introducing `$auth` MUST NOT change the behavior or signature of existing `ModelDelegate`
methods for models without `@@allow`.

#### Scenario: Existing queries on unprotected models are unaffected

- GIVEN a model with no `@@allow` declarations
- WHEN existing `findMany`/`create`/etc. calls run without `$auth`
- THEN behavior is unchanged from before this change
