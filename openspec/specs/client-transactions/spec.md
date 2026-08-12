# Client Transactions Specification

> **Amendment note (post-verify):** `sdd-verify` flagged that the original
> "Nesting via tx.$transaction" scenario below required an explicit runtime
> "nested transactions are not supported" error from `tx.$transaction(...)`,
> but the shipped design deliberately never exposes `$transaction` on the
> transaction-scoped object (`Executor` on the base client, `TransactionClient`
> on the generated client) — nesting through `tx` is prevented at compile time
> instead. Per an explicit product decision, this scenario was corrected to
> describe that actual (safer) behavior rather than adding a runtime-only
> `$transaction` stub to `tx` purely to satisfy the old wording. The sibling
> "Reentrant call on the same client" scenario is unaffected and remains as
> originally specced/tested.

## Purpose

`IndigoClientBase` MUST support an interactive `$transaction(fn)` callback form that
runs an entire callback's statements on one exclusive session, committing on success
and rolling back on failure, with typed per-table delegates bound to that session.
The sequential array form (`$transaction([...])`) is out of scope for this spec.

## Requirements

### Requirement: Exclusive session per transaction

`$transaction(fn)` MUST acquire one exclusive session for the lifetime of `fn` — via
`pool.connect()` on the default `pg.Pool` path, or the injected `db.transaction` hook
on the executor-injection path — and MUST issue `BEGIN` before invoking `fn` on the
`pg.Pool` path (the hook path delegates lifecycle to the host engine's own
`db.transaction`).

#### Scenario: pg.Pool path checks out a dedicated connection

- GIVEN a client constructed on the default `pg.Pool` path
- WHEN `$transaction(fn)` is called
- THEN a single connection MUST be checked out via `pool.connect()` for the duration of `fn`
- AND every statement issued through `tx` inside `fn` MUST run on that same connection

### Requirement: Commit on success

`$transaction(fn)` MUST commit the session and resolve with `fn`'s return value when
the callback's returned promise resolves.

#### Scenario: Callback resolves successfully

- GIVEN a client with `$transaction`
- WHEN `fn` performs writes through `tx` and its returned promise resolves with a value
- THEN the session MUST be committed (`COMMIT` on the pg path)
- AND `$transaction` MUST resolve with that same value
- AND the writes MUST be visible to subsequent queries outside the transaction

### Requirement: Rollback on failure

`$transaction(fn)` MUST roll back the session and rethrow when the callback throws
synchronously or its returned promise rejects, including when the failure originates
from an operation issued through `tx` before `fn` itself settles.

#### Scenario: Callback throws synchronously

- GIVEN a client with `$transaction`
- WHEN `fn` throws synchronously after issuing writes through `tx`
- THEN the session MUST be rolled back (`ROLLBACK` on the pg path)
- AND `$transaction` MUST reject with the thrown error
- AND none of the writes issued through `tx` MUST be visible afterward

#### Scenario: Callback's promise rejects

- GIVEN a client with `$transaction`
- WHEN `fn` returns a promise that rejects
- THEN the session MUST be rolled back
- AND `$transaction` MUST reject with that rejection reason

#### Scenario: A tx operation throws before fn settles

- GIVEN a client with `$transaction`
- WHEN a `tx.<model>.<op>(...)` call inside `fn` throws or rejects
- THEN the session MUST still be released exactly once in a `finally`
- AND no connection MUST remain checked out afterward
- AND `$transaction` MUST reject with that error

### Requirement: Session always released

The checked-out session MUST be released (pg path) or its hook lifecycle completed
(injected path) exactly once, in a `finally`, regardless of commit, rollback, or an
error thrown before `fn` settles.

#### Scenario: Release happens on every outcome

- GIVEN a client with `$transaction`
- WHEN `$transaction(fn)` completes, whether by commit, rollback, or an error prior to `fn` settling
- THEN the underlying connection/session MUST be released exactly once
- AND it MUST NOT be released more than once nor leaked

### Requirement: Nested transactions are prevented

Calling `client.$transaction(...)` again on the same client while one is already
in flight MUST reject with an explicit error at runtime (via an `AsyncLocalStorage`
guard). Nesting through the transaction-scoped object passed into the callback
(`tx`) MUST instead be prevented structurally: `tx` MUST NOT expose a
`$transaction` member at all, so `tx.$transaction(...)` is a TypeScript compile
error rather than a runtime rejection. No savepoint support exists in this slice.

#### Scenario: tx has no $transaction member

- GIVEN the object passed to `fn` inside an active `$transaction(fn)` callback
  (the raw `Executor` on `IndigoClientBase`, or the generated `TransactionClient`
  interface on `IndigoClient`)
- WHEN its shape is inspected
- THEN it MUST NOT declare or expose a `$transaction` member
- AND a TypeScript caller writing `tx.$transaction(...)` MUST fail to compile
- AND a dynamic/JS caller that bypasses types and calls `tx.$transaction(...)`
  anyway MUST fail with a generic "not a function" runtime error (not the
  specific "nested transactions are not supported" message), since no such
  member exists to reject explicitly
- AND the outer transaction's session MUST remain otherwise unaffected

#### Scenario: Reentrant call on the same client

- GIVEN an active `$transaction(fn)` callback on a client
- WHEN `fn` calls `client.$transaction(...)` again on that same client instance
- THEN the call MUST reject with an explicit "nested transactions are not supported" error

### Requirement: Unsupported executors fail explicitly

When the client was constructed with an injected executor that has no `transaction`
hook, `$transaction(fn)` MUST reject with a clear, explicit "executor does not support
transactions" error instead of silently falling back to non-atomic execution.

#### Scenario: Injected executor without a transaction hook

- GIVEN a client constructed with an injected executor that does not implement `transaction`
- WHEN `$transaction(fn)` is called
- THEN it MUST reject with an explicit unsupported-operation error
- AND `fn` MUST NOT be invoked

### Requirement: Typed tx delegates scoped to the session

The object passed to `fn` MUST expose the same per-table delegates as the top-level
client (e.g. `tx.user.create(...)`), each bound to the transaction's session executor
rather than the client's default executor, so every operation issued through `tx`
participates in the same transaction.

#### Scenario: tx delegate writes participate in the transaction

- GIVEN an active `$transaction(fn)` callback
- WHEN `fn` calls `tx.user.create(...)` and then throws
- THEN that create MUST be rolled back along with every other statement in the callback

### Requirement: No isolation/timeout/read-only options accepted

`$transaction` MUST NOT accept isolation-level, timeout, or read-only options in this
slice; these are not part of the API surface and MUST NOT be silently accepted as no-ops.

#### Scenario: Options argument is not part of the surface

- GIVEN the current `$transaction` signature
- WHEN a caller inspects the accepted parameters
- THEN only the callback `fn` MUST be accepted — no second options argument for isolation level, timeout, or read-only mode exists

## ADDED from nested-writes

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
