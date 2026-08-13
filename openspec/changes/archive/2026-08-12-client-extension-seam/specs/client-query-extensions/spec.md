# Client Query Extensions Specification

## Purpose

`@indigodb/client` MUST let consumers register middleware that composes around the
existing `Executor` seam, observing and optionally rewriting every query (SQL text,
params, and result rows) without forking the client. This is the seam mechanism plus
per-query context; declarative filter injection (soft delete, tenant scoping) is out
of scope for this capability and belongs to `client-where-composition`.

## Requirements

### Requirement: QueryExtension type and constructor-only registration

`packages/client/src/types.ts` MUST export `QueryExtension = (next: Executor) =>
Executor`, matching the shape already used internally by `wrapLog`. `IndigoClientOptions`
MUST gain an optional `extensions?: QueryExtension[]`, consumed only at construction time.

#### Scenario: Extensions array is immutable after construction

- GIVEN a client constructed with `extensions: [ext]`
- WHEN the client is used after construction
- THEN there MUST be no public API to add, remove, or reorder extensions post-construction
- AND the composed chain MUST remain the one built at construction time

#### Scenario: No public API mutates registration

- GIVEN a constructed client
- WHEN inspecting the client's public surface
- THEN no method (e.g. `$use`) for registering extensions after construction MUST exist

### Requirement: Extension composition order and wrapLog placement

Extensions MUST compose right-to-left around the base executor, so `extensions[0]` is
outermost (first to observe the call, last to observe the result) and the last extension
is innermost, closest to the base executor. `wrapLog`'s `log: boolean` behavior MUST
remain innermost — between the last extension and the base executor — logging the exact
SQL/params actually sent, with zero behavior change from today.

#### Scenario: Extensions run in declared order

- GIVEN a client constructed with `extensions: [a, b]`
- WHEN a query executes
- THEN `a` MUST observe the call before `b`
- AND `a` MUST observe the result after `b`

#### Scenario: wrapLog logs the SQL each extension actually forwards

- GIVEN a client constructed with `log: true` and an extension that rewrites `sql`
- WHEN a query executes
- THEN the logged SQL MUST be the SQL produced after all extensions have run, not the
  original caller-supplied SQL

#### Scenario: Absent extensions leaves current behavior unchanged

- GIVEN a client constructed with no `extensions` option (or an empty array)
- WHEN any query executes
- THEN behavior (including `log`) MUST be identical to the client before this capability
  existed, with no composition overhead applied

### Requirement: Extensions may mutate sql/params or short-circuit

An extension MUST be able to call `next(sql, params)` with modified `sql` and/or `params`,
and MUST be able to skip calling `next` entirely and return rows itself (e.g. a cache).

#### Scenario: Extension rewrites SQL before execution

- GIVEN an extension that appends a `WHERE` clause to `sql` before calling `next`
- WHEN a query executes through that extension
- THEN the base executor MUST receive the rewritten `sql`, not the original

#### Scenario: Extension short-circuits without calling next

- GIVEN an extension that returns cached rows without calling `next`
- WHEN a query executes through that extension
- THEN the base executor and any inner extensions MUST NOT be invoked
- AND the caller MUST receive the rows the extension returned

### Requirement: Extension coverage on all executor paths, including transactions

Extensions MUST apply to `this.exec` (the default query path), to `$queryRaw`, and to
every session executor produced inside `$withSession` (covering `$transaction`), so no
executor path bypasses the composed chain.

#### Scenario: Extension observes default-path queries

- GIVEN a client constructed with an extension
- WHEN any model delegate issues a query on the default (non-transaction) path
- THEN the extension MUST observe that query

#### Scenario: Extension observes $queryRaw

- GIVEN a client constructed with an extension
- WHEN `$queryRaw(sql, params)` is called
- THEN the extension MUST observe that query

#### Scenario: Extension observes queries inside $transaction

- GIVEN a client constructed with an extension
- WHEN `$transaction(fn)` runs delegate queries against the transaction-scoped executor
- THEN the extension MUST observe each of those queries
- AND the composition order MUST match the non-transaction path

### Requirement: Per-query context via AsyncLocalStorage

`ModelDelegate` methods MUST set a `QueryContext` (`{ model: string; operation: string }`)
via `AsyncLocalStorage` for the duration of each delegate-issued query, readable by
extensions. Internal statements and `$queryRaw` calls MUST expose `undefined` context.

#### Scenario: Extension reads model/operation for a delegate call

- GIVEN a client constructed with an extension that reads the ambient `QueryContext`
- WHEN `db.user.findMany(...)` executes
- THEN the extension MUST observe `{ model: "user", operation: "findMany" }` (or the
  equivalent for the invoked method)

#### Scenario: $queryRaw has no delegate context

- GIVEN a client constructed with an extension that reads the ambient `QueryContext`
- WHEN `$queryRaw(sql, params)` executes
- THEN the extension MUST observe `undefined` context

#### Scenario: Concurrent delegate queries do not bleed context

- GIVEN a client constructed with an extension that reads the ambient `QueryContext`
- WHEN two delegate queries for different models (e.g. `db.user.findMany()` and
  `db.post.create(...)`) are issued concurrently (interleaved, not awaited sequentially)
- THEN each query MUST observe only its own model/operation context
- AND neither query's context MUST leak into the other's observed values

### Requirement: Error propagation is unwrapped

When an extension throws (synchronously or via a rejected promise) at any point in the
chain, the query MUST fail with that error, unmodified, and outer extensions MUST observe
the rejection rather than a fallback result.

#### Scenario: Throwing extension fails the query

- GIVEN a client constructed with an extension that throws for a given query
- WHEN that query executes
- THEN the caller MUST receive the extension's thrown error, unwrapped
- AND no fallback or swallowed-error result MUST be returned

#### Scenario: Outer extension observes an inner rejection

- GIVEN a client constructed with `extensions: [outer, inner]` where `inner` throws
- WHEN a query executes
- THEN `outer`'s call to `next` MUST reject with `inner`'s error
- AND `outer` MAY observe and rethrow it, but MUST NOT be able to suppress propagation to
  the caller unless it explicitly returns a substitute result
