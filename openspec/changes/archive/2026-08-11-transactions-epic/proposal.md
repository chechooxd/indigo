# Proposal: Transactions epic (`$transaction`)

## Intent

`@indigodb/client` has **zero atomicity today**. `pool.query()` checks out an arbitrary idle
connection per statement, so `$queryRaw("BEGIN")` opens a transaction on one connection while
subsequent writes autocommit on others — silent data corruption on any multi-statement write.
No `pool.connect()`/`PoolClient` usage exists anywhere in the repo. This blocks roadmap Phase 2's
"Nested writes" epic, which needs atomic multi-statement writes across relations.

## Scope

### In Scope

- `IndigoClientBase.$transaction(fn)` — interactive callback form: one exclusive session for
  `BEGIN` → statements → `COMMIT`, `ROLLBACK` on throw, release in `finally`.
- `IndigoClientOptions.db` grows optional `transaction?: <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>`
  so non-`pg` executors (PGlite harness, custom engines) support `$transaction` on the same seam.
- Injected `db` **without** the hook → clear "executor does not support transactions" error.
- Nesting rejected with an explicit error (no savepoints).
- Generator emits a shared delegate-factory + `TransactionClient` type so `tx.user`, `tx.post`
  are typed inside the callback; `IndigoClient`'s own fields reuse the same factory.
- PGlite-backed regression tests (`packages/client/test/*.mjs`, plain Node) covering commit,
  rollback-on-throw, same-session guarantee, nesting rejection, unsupported-executor error.

### Out of Scope

- **Sequential array form `$transaction([...])`** — true Prisma parity requires *deferred,
  unexecuted* operations; delegate methods fire `exec` eagerly today. Deferred-operation support
  is a separate API-shape change; deferred to a follow-up epic.
- Transaction options (isolation level, timeout, read-only), savepoints, explicit
  `tx.commit()`/`tx.rollback()`, distributed/nested transactions.

## Capabilities

### New Capabilities
- `client-transactions`: interactive `$transaction` semantics — session exclusivity, commit/rollback,
  nesting rejection, unsupported-executor behavior, typed `tx` delegates.

### Modified Capabilities
- `client-executor-injection`: the injected `db` contract gains an optional `transaction` hook;
  all existing requirements stay unchanged when it is absent.

## Approach

`$transaction` acquires an exclusive session — `pool.connect()` on the pg path, the injected
`db.transaction` hook otherwise — wraps it as a transaction-scoped `Executor`, builds fresh
delegates bound to it, runs the callback, then commits/rolls back/releases deterministically.
The pg path issues raw `BEGIN`/`COMMIT`/`ROLLBACK`; the hook path delegates lifecycle to the host
engine (PGlite's own `db.transaction`), which also satisfies PGlite's rule that nested statements
must not touch the outer `db`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/client.ts` | Modified | `$transaction`, session checkout, `db.transaction` option |
| `packages/client/src/types.ts` | Modified | Transaction-session / hook types |
| `packages/client/src/delegate.ts` | Modified | Delegate construction reusable per-executor |
| `packages/generator/src/client.ts` | Modified | Delegate factory + typed `TransactionClient` |
| `packages/client/test/` | New | PGlite transaction suite + harness hook |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Connection leak / double-release on error paths | Med | `try/catch/finally`, release exactly once; explicit leak test |
| PGlite hook diverges from real pg semantics | Med | Spec behavior contract-first; keep hook thin |
| Generator has no precedent for extra client methods | Med | Factory function, minimal template surface; golden coverage |
| `client-executor-seam` (PR #7) not yet on `main` | Med | Code is present in-tree; sequence this change after that merge |

## Rollback Plan

Additive only. Revert the commit(s): `$transaction` and the optional `db.transaction` field
disappear; existing `pg.Pool` and injected-executor paths are untouched by construction.

## Dependencies

- `client-executor-seam` (PR #7) merged to `main`.

## Success Criteria

- [ ] Writes inside `$transaction(fn)` run on one session and are atomic (commit/rollback proven).
- [ ] A throw inside the callback rolls back all statements and rethrows.
- [ ] PGlite regression suite exercises `$transaction` through the injected seam.
- [ ] Nesting and unsupported executors fail with explicit, actionable errors.
- [ ] `pnpm lint` and `pnpm test` pass; no behavior change when `$transaction` is unused.
