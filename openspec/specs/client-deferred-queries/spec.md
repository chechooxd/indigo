# Client Deferred Queries Specification

## Purpose

Every `ModelDelegate` query method MUST return a deferred, lazy, thenable object
(`IndigoPromise<T>`) instead of executing SQL immediately, so the same operation
can either be awaited standalone (executing exactly as today) or handed to
`$transaction([...])` to execute once, atomically, inside a shared session.
`$queryRaw`'s deferred form is explicitly OUT of scope — no model exists to
rebind it through; it is a documented follow-up.

## Requirements

### Requirement: IndigoPromise extends Promise for type compatibility

`IndigoPromise<T>` MUST extend `Promise<T>` so every existing call site typed as
`Promise<T>`, `Promise.all([...])`, and `.then()` chains keep compiling and
behaving correctly without changes.

#### Scenario: Existing Promise-typed call sites keep compiling

- GIVEN `const p: Promise<User> = db.user.findUnique({ where: { id: 1 } })`
- WHEN the project is typechecked
- THEN it MUST compile with no type errors
- AND `Promise.all([db.user.findMany(), db.post.count()])` MUST typecheck and resolve normally

### Requirement: Execution is deferred until awaited or transacted

Calling a delegate method MUST NOT issue any SQL. SQL execution MUST only begin
when the returned `IndigoPromise` is awaited/`.then()`ed directly, or when it is
passed into `$transaction([...])`.

#### Scenario: Constructing the call issues no SQL

- GIVEN `const op = db.user.create({ data: { name: "A" } })`
- WHEN `op` is constructed but never awaited or passed to `$transaction`
- THEN no SQL statement MUST be sent to the database

### Requirement: Standalone await executes immediately, identical to today

Awaiting an `IndigoPromise` outside `$transaction` MUST execute it immediately
against the delegate's own bound executor, producing byte-identical SQL and
results to the pre-existing eager behavior.

#### Scenario: Standalone await matches today's SQL

- GIVEN `await db.user.create({ data: { name: "A" } })`
- WHEN executed outside any `$transaction`
- THEN the emitted SQL MUST be identical to the eager implementation this change replaces
- AND the resolved value MUST match today's return shape

### Requirement: Result is memoized and single-fire

An `IndigoPromise` MUST execute its underlying operation at most once. Awaiting
it multiple times MUST return the same memoized result without re-issuing SQL.
Passing an already-settled or already-claimed op into `$transaction([...])`
MUST throw a typed reuse error rather than re-executing or silently no-op-ing.

#### Scenario: Double await reuses the memoized result

- GIVEN `const op = db.user.create({ data: { name: "A" } })`
- WHEN `op` is awaited twice
- THEN the SQL MUST be issued only once
- AND both awaits MUST resolve to the same value

#### Scenario: Reusing a standalone-awaited op in $transaction throws

- GIVEN `const op = db.user.create({ data: { name: "A" } })` that has already been awaited standalone
- WHEN `op` is later passed into `db.$transaction([op])`
- THEN it MUST throw a typed reuse error (e.g. `IndigoPromiseReusedError`)
- AND no additional SQL MUST be issued

#### Scenario: Reusing an op across two $transaction calls throws

- GIVEN `const op = db.user.create({ data: { name: "A" } })`
- WHEN `op` is passed into `db.$transaction([op])` and, after that resolves, passed into a second `db.$transaction([op])`
- THEN the second call MUST throw a typed reuse error before opening a session
- AND the first transaction's committed effect MUST NOT be duplicated

### Requirement: Rebindable by model name, not captured SQL

An `IndigoPromise` MUST carry enough information (model name, operation name,
original arguments) to be re-invoked against a different session-bound delegate
instance, rather than carrying pre-built SQL — required because several
operations are multi-statement (`findMany` + relation loads, nested writes,
`upsert`) and cannot be represented as a single captured statement.

#### Scenario: Multi-statement op rebinds correctly inside a transaction

- GIVEN `db.user.create({ data: { name: "A", posts: { create: [{ title: "x" }] } } })` passed into `$transaction([...])`
- WHEN the transaction executes
- THEN both the parent and nested statements MUST run on the transaction's single session, not the client's default executor
