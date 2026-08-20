# Proposal: `$transaction([...])` array form (full Prisma parity)

## Intent

Only the interactive callback form exists (`client.ts` `$transaction(fn)` → `$withSession`, real BEGIN/COMMIT/ROLLBACK; `generator/src/client.ts` emits a typed override). The array form has **zero** implementation: no client method, no emission, no tests. `client-transactions/spec.md` explicitly declares it out of scope.

**Architectural finding**: every `ModelDelegate` method in `delegate.ts` executes SQL **immediately** and returns a live `Promise` — there is no "build without executing" seam. Worse, several operations are **multi-statement** (`findMany` + `loadRelations`, nested-write `create`/`update` via `runAtomic`, `upsert`), so a captured `{sql, params}` record cannot represent them. A faithful array form needs a **new deferred-execution return contract** adopted by every delegate method. This is architecture, not a bugfix.

**Fixed constraint (user-approved)**: full Prisma parity. A deferred, unexecuted object that either (a) is awaited standalone and executes immediately, exactly like today, or (b) is passed to `$transaction([...])` and executes only inside that transaction — never twice, never independently.

## Scope

### In Scope

- `IndigoPromise<T> extends Promise<T>` in `types.ts`: lazy thenable capturing `{ model, operation, invoke(delegate) }`, memoized, single-fire.
- Every `ModelDelegate` query method returns it uniformly: `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `count`, `createMany`, `updateMany`, `deleteMany`, `aggregate`, `groupBy`, `upsert`.
- `$transaction(ops[])` overload on `IndigoClientBase` + generated override: opens one `$withSession`, rebinds each op **by model name** against `__delegates(sessionExec, ...)`, runs in array order, returns a tuple-typed result.
- Guards: reuse of a settled/consumed op, non-`IndigoPromise` element, empty array, no-`transaction`-hook adapter, nesting.
- Generator emission + tests (`packages/client/test/`, typecheck fixture).

### Out of Scope

- `$queryRaw` deferred form (client-level, no model to rebind through) — follow-up.
- Isolation/timeout/read-only options; savepoints; parallel/batched single round trip.
- Nested-write inner ops stay eager inside their planner.

## Capabilities

### New Capabilities
- `client-deferred-queries`: the deferred query object contract (lazy, memoized, single-fire, standalone-awaitable).

### Modified Capabilities
- `client-transactions`: array form moves from explicitly-out-of-scope to specified — ordering, atomicity, rebinding, error/rollback semantics.

## Approach

**Rebindable operation thunks, not captured SQL** — the only mechanism that survives multi-statement operations. Each public delegate method becomes a one-line wrapper returning `defer(this, "<op>", d => d.<op>Impl(args))`; the existing body moves to (or already is) `<op>Impl`. Awaiting runs `invoke` against the delegate's own bound executor (today's behavior, byte-identical SQL). `$transaction([...])` instead resolves each op's model against the session-scoped `TransactionClient` that `__delegates` already builds — reusing the exact wiring the callback form uses, so both forms cannot drift.

`extends Promise<T>` is the compatibility key: `Promise<Row>`-annotated call sites, `Promise.all`, and `.then` chains keep compiling. Internal callers (`findFirst`→`findMany`, planner→siblings, `loadRelations`) `await` immediately and need no change.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/client/src/types.ts` | Modified | `IndigoPromise<T>`, tuple result type |
| `packages/client/src/promise.ts` | New | Lazy thenable + `defer()` |
| `packages/client/src/delegate.ts` | Modified | 13 methods rewrapped; `*Impl` split completed |
| `packages/client/src/client.ts` | Modified | `$transaction` overload + array path |
| `packages/generator/src/client.ts` | Modified | `TransactionClient` types, `$transaction` overloads, emitted signatures |
| `packages/client/test/*` | New/Modified | Deferral, atomicity, guards, typecheck fixture |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Breaking change on delegate return types** | Med | `IndigoPromise<T> extends Promise<T>` keeps assignability; typecheck fixture asserts it; any regenerated client stays source-compatible |
| Stale generated clients mismatch new runtime | Med | Runtime accepts plain Promises in the array only by rejecting with a clear "regenerate your client" error |
| Double execution / op reused across arrays | Med | Single-fire state machine (`pending`→`claimed`→`settled`), typed error on reuse |
| Lost eagerness changes error timing (throw at call vs. await) | Med | Argument validation stays eager where it is today; spec pins which errors surface when |
| Multi-statement ops make partial-array failure semantics subtle | Med | Sequential execution + rollback of the whole session; specced explicitly |
| Exceeds 800-line review budget | High | Slice: PR1 contract+`promise.ts`, PR2 delegate rewrap, PR3 client+generator+tests |

## Rollback Plan

Revert per slice. The contract is additive: reverting `promise.ts` + the delegate wrappers restores byte-identical eager `Promise` returns, since `*Impl` bodies are unchanged. Generated clients regenerate from the reverted generator; no schema, SQL, or migration state is touched.

## Dependencies

- None external. Requires `client-transactions` spec amendment (line 20 out-of-scope declaration).
- Generator and client must ship together; `pnpm build` ordering already enforces it.

## Success Criteria

- [ ] `await db.user.create(...)` behaves and emits identical SQL to today.
- [ ] `$transaction([a, b, c])` runs all three on one session in order, commits once, rolls back all on any failure.
- [ ] An op passed to `$transaction` never executes independently; a reused op throws.
- [ ] `const p: Promise<User> = db.user.findUnique(...)` still typechecks.
- [ ] Nested/no-hook/empty-array cases have explicit specced behavior and tests.

## Proposal question round

Unable to ask interactively. Assumptions needing review:

1. **Uniform coverage** — all 13 delegate methods deferred in the first change, not a subset. Rationale: the cost is the mechanism, not the per-method wrap; a partial rollout gives a two-tier API where `db.user.count()` cannot join an array.
2. **`$queryRaw` deferred** — deferred to follow-up (needs a model-less rebinding path). Confirm this is acceptable for parity claims.
3. **Partial-failure semantics** — sequential execution, whole-transaction rollback (no partial commit, no continue-on-error). Confirm no per-op error tolerance is wanted.
