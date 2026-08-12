# Design: Transactions epic (`$transaction`)

## Technical Approach

`IndigoClientBase` gains one protected primitive, `$withSession(fn)`, that yields an
`Executor` bound to a single exclusive session, plus a public `$transaction(fn)` that
hands the callback a delegate bundle built on that executor. Two session sources: the
`pg.Pool` path checks out a `PoolClient` and issues raw `BEGIN`/`COMMIT`/`ROLLBACK`; the
injected path delegates lifecycle to a new optional `options.db.transaction` hook. The
generator stops initializing delegates as class-field expressions and emits one
`__delegates(exec, realtime)` factory reused by both the constructor and `$transaction`.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|----------|----------------------|-----------|
| 1 | pg path: `pool.connect()` → session-bound `Executor` closing over `client.query`; raw `BEGIN`/`COMMIT`/`ROLLBACK`; `client.release()` in `finally` | `pool.query` with `BEGIN` (today's bug — different connection per statement) | Only a checked-out `PoolClient` guarantees one session |
| 2 | Injected path: optional `db.transaction?: <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>`; absent ⇒ explicit error | Emit `BEGIN`/`COMMIT` through injected `exec` | The host engine owns its own session; PGlite forbids touching the outer `db` inside `db.transaction` (electric-sql/pglite#76), so the hook must *own* the callback |
| 3 | Delegates via an emitted `__delegates(exec, realtime)` factory; `IndigoClient` assigns fields explicitly in a generated constructor | `Object.assign` (loses `readonly` typing), delegate `setExec()` mutation (shared mutable state) | One construction site, exact same delegate wiring for `this.exec` and a session exec; `readonly` fields remain assignable inside the constructor |
| 4 | Nesting: `TransactionClient` has no `$transaction` (compile-time) **plus** an `AsyncLocalStorage<true>` guard on the base for JS callers | Boolean in-flight flag on the instance | A flag would also reject legitimate *concurrent* independent transactions from one pooled client; ALS distinguishes "inside this callback" from "in parallel". Context loss fails open, which is safe |
| 5 | `TransactionClient` is a distinct emitted interface | `Omit<IndigoClient, "$transaction">` | Omit leaks `$disconnect`/options surface into the tx object and makes the tx look closeable |

## Data Flow

    $transaction(fn)
       │
       ├─ pool path ─→ pool.connect() ─→ BEGIN ─→ sessionExec ─┐
       │                                                        ├─→ __delegates(sessionExec) → fn(tx)
       └─ db.transaction(hook) ─→ hostExec ─────────────────────┘        │
                                                        ok → COMMIT / throw → ROLLBACK
                                                                 finally → release()

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/client.ts` | Modify | `IndigoClientOptions.db.transaction?`, `$withSession`, ALS nesting guard, session-exec logging |
| `packages/client/src/types.ts` | Modify | `TransactionHook` type alias |
| `packages/generator/src/client.ts` | Modify | `__delegates` factory, `TransactionClient` interface, generated constructor + `$transaction` |
| `packages/client/test/pglite-harness.mjs` | Modify | `createPgliteDb(db)` → `{ exec, transaction }` |
| `packages/client/test/transactions.mjs` | Create | Transaction regression suite |
| `packages/generator/test/*.mjs` | Modify/Create | Assert factory + `TransactionClient` emission |

`packages/client/src/delegate.ts` needs **no change** — it already takes `exec` per instance.

## Interfaces / Contracts

```ts
// types.ts
export type TransactionHook = <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;

// client.ts (shape)
protected async $withSession<T>(fn: (exec: Executor) => Promise<T>): Promise<T> {
  if (this.txContext.getStore()) throw new Error("IndigoClient: $transaction cannot be nested.");
  const scoped = (exec: Executor) => this.txContext.run(true, () => fn(this.wrapLog(exec)));
  if (!this.pool) {
    if (!this.txHook)
      throw new Error("IndigoClient: the injected executor does not support transactions. Provide `db.transaction`.");
    return this.txHook(scoped);                      // host owns BEGIN/COMMIT/ROLLBACK
  }
  const client = await this.pool.connect();
  let poison: unknown;
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await scoped(async (sql, p) => (await client.query(sql, p as unknown[])).rows as Record<string, unknown>[]);
    } catch (err) {
      try { await client.query("ROLLBACK"); }
      catch (rbErr) { poison = rbErr; console.error("[indigodb] ROLLBACK failed", rbErr); }
      throw err;                                     // original error is never masked
    }
    await client.query("COMMIT");                    // COMMIT failure propagates as-is
    return result;
  } finally {
    client.release(poison as Error | undefined);     // truthy ⇒ destroy, never re-pool a poisoned session
  }
}
```

Generated (`indigo.ts`):

```ts
export interface TransactionClient {
  readonly user: ModelDelegate<User, UserCreateInput, UserUpdateInput>;
  /* …one per model; realtime models still get RealtimeModelDelegate… */
  $queryRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
function __delegates(exec: Executor, realtime: () => RealtimeConnectionManager): TransactionClient { … }

export class IndigoClient extends IndigoClientBase {
  readonly user: ModelDelegate<User, UserCreateInput, UserUpdateInput>;
  constructor(options?: IndigoClientOptions) {
    super(options);
    const d = __delegates(this.exec, this.$realtime);
    this.user = d.user; /* …per model… */
  }
  $transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.$withSession((exec) => fn(__delegates(exec, this.$realtime)));
  }
}
```

Harness hook (PGlite owns the session; the closure never touches the outer `db`):

```js
export function createPgliteDb(db) {
  return {
    exec: async (sql, params) => (await db.query(sql, params)).rows,
    transaction: (fn) => db.transaction(async (tx) =>
      fn(async (sql, params) => (await tx.query(sql, params)).rows)),
  };
}
```

`@indigodb/client` already re-exports `Executor` (`export type * from "./types.js"`) and
`RealtimeConnectionManager`, so the generated factory signature needs no new exports.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Nesting rejection; unsupported-executor error; no `pg.Pool` regression | Stub executor + `IndigoClientBase` directly in `transactions.mjs` |
| Integration | Commit visibility; rollback on `throw`; rollback on returned rejected promise; state after a failed tx is clean | Real PGlite via `createPgliteDb`, `ModelDelegate` bound to the session exec |
| Generator | `__delegates` factory, `TransactionClient` interface, constructor assignments emitted | String assertions on `generateClient()` output, as `enum-mapping.mjs` does |

Plain-Node `.mjs` against `dist/` — no framework, matching the existing suites; register the
new file in `packages/client`'s `test` script.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. All changes are in-process library code.

## Migration / Rollout

No migration. Purely additive: absent `$transaction` usage, both existing paths are
byte-identical in behavior. Regenerating `indigo.ts` is required to get typed `tx`; an
unregenerated client keeps working (the base method is inherited but untyped delegates).

## Open Questions

Both resolved during Slice 2 implementation/verification:

- [x] Should `tx.$queryRaw` be exposed on `TransactionClient` in this slice? **Yes**, as designed —
  `__delegates` emits it (`packages/generator/src/client.ts`), asserted by
  `packages/generator/test/transaction-emission.mjs`.
- [x] AsyncLocalStorage (`node:async_hooks`) makes `@indigodb/client`'s base module Node-only at
  import time. Confirmed acceptable: `apps/studio` does not import `@indigodb/client` anywhere
  (`rg "@indigodb/client" apps/studio/package.json apps/studio/src` is empty), so no browser
  bundling risk exists in this repo.
