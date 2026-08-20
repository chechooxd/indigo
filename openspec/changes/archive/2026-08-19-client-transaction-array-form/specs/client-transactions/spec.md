# Delta for Client Transactions

> **Purpose update**: the main spec's Purpose paragraph states "The sequential
> array form (`$transaction([...])`) is out of scope for this spec." This
> sentence MUST be removed at archive time — the array form is now specified
> below, uniformly on the generated `IndigoClient`, and explicitly NOT on the
> bare `IndigoClientBase`.

## ADDED Requirements

### Requirement: Array form executes ops atomically in order on one session

`$transaction(ops[])` on the generated `IndigoClient` MUST acquire one
exclusive session (identical acquisition mechanism as the callback form),
execute every `IndigoPromise` in `ops` sequentially in array order against
that session, commit once all ops resolve, and return their results as a
typed tuple matching input order.

#### Scenario: Two ops commit atomically in order

- GIVEN `db.$transaction([db.user.create({ data: { name: "A" } }), db.post.create({ data: { title: "x" } })])`
- WHEN the call resolves
- THEN both rows MUST exist and be visible outside the transaction
- AND the user row MUST have been inserted before the post row
- AND exactly one `COMMIT` MUST have been issued

### Requirement: Any op failure rolls back the whole array

If any op in the array throws or rejects, execution MUST stop, every op
already run in that array MUST be rolled back via the shared session's
`ROLLBACK`, and `$transaction` MUST reject with that op's error. There is no
per-op error tolerance.

#### Scenario: Second op failing rolls back the first

- GIVEN `db.$transaction([db.user.create({ data: { name: "A" } }), db.post.create({ data: { title: null } })])` where the second op violates a NOT NULL constraint
- WHEN the call executes
- THEN the user row created by the first op MUST NOT be visible afterward
- AND `$transaction` MUST reject with the constraint error

### Requirement: Ops rebind by model name against the session

Each `IndigoPromise` in the array MUST be re-invoked against the session-scoped
delegate for its model, obtained the same way `__delegates(sessionExec, ...)`
builds `tx` for the callback form, so both transaction forms share one wiring
and cannot drift.

#### Scenario: Rebinding matches the callback form's session wiring

- GIVEN `db.$transaction([db.user.create({ data: { name: "A" } })])`
- WHEN the op executes
- THEN it MUST run through the same `__delegates`-built session executor the callback form (`tx.user.create`) uses

### Requirement: Empty array is a no-op

`$transaction([])` MUST resolve immediately with an empty tuple `[]` without
opening a session, issuing `BEGIN`, or requiring a `transaction` hook.

#### Scenario: Empty array resolves without opening a session

- GIVEN `db.$transaction([])`
- WHEN it is awaited
- THEN it MUST resolve to `[]`
- AND no connection/session MUST be checked out

### Requirement: Non-IndigoPromise array elements throw

`$transaction(ops[])` MUST validate every element is an `IndigoPromise` before
opening a session. A plain value, plain `Promise`, or already-awaited result in
the array MUST throw a clear, explicit error and MUST NOT open a session.

#### Scenario: Plain value in the array throws before opening a session

- GIVEN `db.$transaction([db.user.create({ data: { name: "A" } }), 42])`
- WHEN the call executes
- THEN it MUST throw before any `BEGIN` is issued
- AND no partial writes MUST occur

#### Scenario: A stale generated client's plain Promise is rejected with a regenerate hint

- GIVEN a delegate method from a pre-upgrade generated client that still returns a plain `Promise<T>` (not `IndigoPromise<T>`)
- WHEN that value is passed into `db.$transaction([...])` on an upgraded runtime
- THEN it MUST throw a clear error instructing the caller to regenerate their client
- AND it MUST NOT silently execute the op eagerly or produce a wrong result

### Requirement: Nesting the array form inside an interactive callback is rejected

Calling `$transaction([...])` from inside an active `$transaction(fn)`
callback's `fn` — whether on `tx` or on the outer `client` — MUST be rejected
the same way existing nesting is rejected: structurally (`tx` exposes no
`$transaction` member) or, on the outer client, via the existing
`AsyncLocalStorage` reentrancy guard.

#### Scenario: Array form via the outer client while a callback is active rejects

- GIVEN an active `$transaction(fn)` callback on `client`
- WHEN `fn` calls `client.$transaction([db.user.create({ data: { name: "A" } })])`
- THEN the call MUST reject with the existing "nested transactions are not supported" error

### Requirement: IndigoClientBase does not support the array form

`IndigoClientBase.$transaction` MUST accept only the callback form. The array
form (`$transaction(ops[])`) requires the generated client's
`TransactionClient`/`__delegates` model registry, which the bare base client
does not have, so it is exposed only on the generated `IndigoClient`. This is
enforced at compile time (no array-accepting overload exists on the base
class); a caller bypassing types with a raw array at runtime MUST receive a
clear "array form requires a generated client" error, not silent misbehavior.

#### Scenario: Base client has no array-accepting overload

- GIVEN `IndigoClientBase` with no generated delegates
- WHEN a TypeScript caller writes `client.$transaction([op1, op2])`
- THEN it MUST fail to compile, since no such overload exists
- AND a dynamic/JS caller bypassing types MUST receive an explicit
  "array form requires a generated client" error at runtime, not a callback-form misinterpretation

## MODIFIED Requirements

### Requirement: Unsupported executors fail explicitly

When the client was constructed with an injected executor that has no
`transaction` hook, `$transaction` MUST reject with a clear, explicit "executor
does not support transactions" error instead of silently falling back to
non-atomic execution — for both the callback form (`fn`) and, on the generated
client, the array form (`ops[]`).
(Previously: only described the callback form.)

#### Scenario: Injected executor without a transaction hook (callback form)

- GIVEN a client constructed with an injected executor that does not implement `transaction`
- WHEN `$transaction(fn)` is called
- THEN it MUST reject with an explicit unsupported-operation error
- AND `fn` MUST NOT be invoked

#### Scenario: Injected executor without a transaction hook (array form)

- GIVEN a generated client constructed with an injected executor that does not implement `transaction`
- WHEN `$transaction([op1, op2])` is called
- THEN it MUST reject with the same explicit unsupported-operation error
- AND none of the ops MUST be invoked
