# Delta for Client Transactions

## ADDED Requirements

### Requirement: Nested writes reuse the in-flight session instead of opening a new transaction

`ModelDelegate.create`/`.update` MUST run their nested relation
sub-operations through an atomic-run seam supplied by the client: the
client's own `$withSession` when no transaction is already active, or an
identity thunk bound to the current session when the call happens inside an
active `$transaction(fn)` callback. Calling nested-write `create`/`update`
from inside `tx` (the callback-scoped delegate set) MUST NOT open a second,
nested transaction and MUST NOT trigger the existing "nested transactions
are not supported" rejection.

#### Scenario: top-level nested create opens exactly one transaction

- GIVEN `db.user.create({ data: { name: "A", posts: { create: [{ title: "x" }] } } })` called directly on the top-level client
- WHEN the call executes
- THEN exactly one `$withSession`-backed transaction MUST be opened for the
  whole call (parent + nested child writes)

#### Scenario: nested create inside an active $transaction joins it, no double-open

- GIVEN an active `$transaction(fn)` callback
- WHEN `fn` calls `tx.user.create({ data: { name: "A", posts: { create: [{ title: "x" }] } } })`
- THEN the nested relation writes MUST run on the same already-open session
  as the rest of `fn`
- AND this MUST NOT throw a "nested transactions are not supported" error
- AND a failure later in `fn` MUST still roll back the user and post rows
  created by this call, since they share the outer transaction
</content>
