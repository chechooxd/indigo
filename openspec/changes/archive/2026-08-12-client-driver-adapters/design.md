# Design: Client Driver Adapters

## Technical Approach

Extract the `pg`-specific logic currently inlined in `IndigoClientBase` (constructor `else`
branch, `$withSession`'s pool branch, `$disconnect`'s `pool.end()`) into
`createPgAdapter`, then have the `connectionString` branch *consume* that factory. The
built-in path and the "bring your own driver" path become the same code, so they cannot
drift (proposal Risk #1). `createPGliteAdapter` promotes `test/pglite-harness.mjs`'s
`createPgliteDb` to a public export. Neon is documentation only.

The refactor is invisible from outside: `withDatabaseErrors` stays innermost, `wrapLog` +
`applyExtensions` still compose on top inside `IndigoClientBase`, and `BEGIN`/`COMMIT`/
`ROLLBACK` still never pass through the extension chain (they now live inside the adapter,
which is by construction outside `scoped`). See `client-extension-seam` and
`client-type-honesty` designs — both invariants are preserved verbatim.

## Architecture Decisions

| # | Decision | Choice | Alternatives rejected | Rationale |
|---|---|---|---|---|
| 1 | Adapter return type | New `DriverAdapter` interface in `types.ts`; `IndigoClientOptions.db?: DriverAdapter` references it | Duplicate the inline shape in `adapters/`; derive `NonNullable<IndigoClientOptions["db"]>` | `types.ts` is a leaf module → no import cycle with `client.ts`. Type-identical to today's inline shape, so this is not a semantic change to `IndigoClientOptions` (proposal Out of Scope holds). |
| 2 | Input discrimination | `PgAdapterConfig = PoolConfig \| { pool: PgPool }`, discriminated by `"pool" in config` | `instanceof pg.Pool`; a `kind` tag | `PoolConfig` has no `pool` key, so the `in` check is unambiguous. `instanceof` breaks across duplicate `pg` copies in a pnpm tree — same reasoning `errors.ts` already documents for `DatabaseError`. |
| 3 | Ownership | Internal `const ownsPool = !("pool" in config)`; `close()` calls `pool.end()` only when `ownsPool`, otherwise resolves immediately | Always `end()`; never `end()`; require an explicit `owns` flag | Ending a caller-supplied pool silently kills connections the host app still uses. Inference from the input shape needs no extra argument and is impossible to get wrong. |
| 4 | Adapter exposes `pool` | Return `{ exec, transaction, close, pool }` | Return only `{ exec, transaction, close }` | Lets `IndigoClientBase` keep its `private pool` field truthful (see Decision 5) and gives callers an escape hatch (`pool.totalCount`) without reconstructing it. |
| 5 | `IndigoClientBase.pool` field | Kept, assigned from `adapter.pool` on the `connectionString` branch, `null` on the `db` branch — but **no longer used for routing** | Delete the field | `test/client.mjs:59` white-box-asserts `client["pool"] === null` for the `options.db` path (the `client-executor-seam` spec's "no pg.Pool is constructed" scenario). Keeping the field means **zero test edits**; its meaning narrows honestly to "this client constructed its own pool". |
| 6 | PGlite transaction | Wrap `pglite.transaction(tx => …)`, never raw `BEGIN`/`COMMIT` | Issue raw control statements like the pg path | PGlite is single-connection; its own `transaction()` is the supported API, and the inner closure must use the `tx` handle, never the outer instance (electric-sql/pglite#76 — already documented in the harness). |
| 7 | PGlite `close` | Omitted by default; opt in via `createPGliteAdapter(pglite, { close: true })` | Always close | Same ownership rule as Decision 3 — the caller constructed the PGlite instance. |
| 8 | Module layout | `src/adapters/pg.ts`, `src/adapters/pglite.ts`, `src/adapters/index.ts` barrel | Single `src/adapters.ts` | Matches the accepted proposal's Affected Areas table and keeps `pg` (real dependency) separate from `pglite` (structurally typed, zero import). |

## Data Flow

    createPgAdapter(config)
      ├─ ownsPool? new Pool(config) : config.pool
      ├─ exec        = withDatabaseErrors(pool.query)
      ├─ transaction = connect → BEGIN → withDatabaseErrors(client.query) → COMMIT/ROLLBACK → release(poison)
      └─ close       = ownsPool ? pool.end() : noop
                │
                ▼
    IndigoClientBase constructor  ── run/txHook/closeInjected (ONE path)
                │
                ▼
    this.exec = applyExtensions(wrapLog(run))          ← unchanged
    $withSession: txHook(scoped) where scoped = applyExtensions(wrapLog(sessionExec))

Control statements (`BEGIN`/`COMMIT`/`ROLLBACK`) are issued inside the adapter, so they are
structurally unreachable from `scoped` — the extension-bypass boundary is now enforced by
module layering rather than by a comment.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/adapters/pg.ts` | Create | `createPgAdapter`, `PgAdapterConfig`, `PgAdapter` |
| `packages/client/src/adapters/pglite.ts` | Create | `createPGliteAdapter` + structural `PGliteLike` interface |
| `packages/client/src/adapters/index.ts` | Create | Barrel re-export |
| `packages/client/src/types.ts` | Modify | Add `DriverAdapter` |
| `packages/client/src/client.ts` | Modify | `IndigoClientOptions.db?: DriverAdapter`; `connectionString` branch calls `createPgAdapter`; delete `$withSession`'s pool branch and `$disconnect`'s `pool.end()` |
| `packages/client/src/index.ts` | Modify | `export * from "./adapters/index.js"` |
| `packages/client/test/pglite-harness.mjs` | Modify | `createPgliteDb` becomes a one-line delegation to `createPGliteAdapter` (duplicate logic deleted) |
| `packages/client/test/adapters.mjs` | Create | Fake-executor + PGlite adapter tests |
| `packages/client/test/adapters-pg.mjs` | Create | pg adapter over `pglite-socket-harness.mjs` |
| `packages/client/package.json` | Modify | Add both files to the `test` script |
| `packages/client/README.md` | Create | Bring-your-own-driver guide, incl. the Neon HTTP recipe |

## Interfaces / Contracts

```ts
// types.ts
export interface DriverAdapter {
  exec: Executor;
  close?: () => Promise<void>;
  transaction?: TransactionHook;
}

// adapters/pg.ts
export type PgAdapterConfig = PoolConfig | { pool: PgPool };
export interface PgAdapter extends Required<DriverAdapter> { pool: PgPool }
export function createPgAdapter(config?: PgAdapterConfig): PgAdapter;

// adapters/pglite.ts — structural, no @electric-sql/pglite import
export interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
export function createPGliteAdapter(
  pglite: PGliteLike,
  options?: { close?: boolean },
): DriverAdapter;
```

`client.ts`'s constructor keeps its own "no connection string" guard **before** calling
`createPgAdapter` — that message is `IndigoClient`-specific and `test/client.mjs:63`
asserts it verbatim.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | `createPgAdapter` shape; `ownsPool` inference | Fake pool object (`{ query, connect, end }` spies): assert `close()` calls `end()` for a `PoolConfig` input and **does not** for a `{ pool }` input |
| Unit | `transaction` hook ordering | Fake client spy: assert `BEGIN` → fn → `COMMIT`; throw → `ROLLBACK` + `release(poison)`; assert control statements never reach an injected extension |
| Unit | `withDatabaseErrors` at `exec` | Fake pool rejecting with `{ code: "23505" }` → `IndigoDatabaseError` |
| Integration | `createPGliteAdapter` end-to-end | New `adapters.mjs` builds `IndigoClientBase({ db: createPGliteAdapter(pglite) })` and runs commit/rollback/isolation |
| Integration | pg adapter parity | `adapters-pg.mjs` reuses `pglite-socket-harness.mjs` and mirrors `transactions-pg.mjs`'s assertions against `{ db: createPgAdapter({ connectionString }) }` |
| Regression | Refactor invisibility | `transactions.mjs`, `transactions-pg.mjs`, `database-errors.mjs`, `extensions.mjs`, `client.mjs` run **unmodified** — they are the proof the `connectionString` path is unchanged |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Purely in-process library composition.

## Migration / Rollout

No migration. Purely additive public surface plus an internal refactor with no observable
behavior change. Revert = revert the single PR.

## Open Questions

- [ ] None blocking. Deviation from the task brief's parenthetical `src/adapters.ts`: the
      accepted proposal specifies `src/adapters/pg.ts` + `src/adapters/pglite.ts`, and this
      design follows the proposal (Decision 8).
