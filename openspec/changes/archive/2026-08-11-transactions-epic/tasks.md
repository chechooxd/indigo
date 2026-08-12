# Tasks: Transactions epic (`$transaction`)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice 1 ~260-320; Slice 2 ~140-180 (total ~450-500) |
| 400-line budget risk | Medium (Slice 1 alone under budget; combined exceeds it) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (client runtime + harness + tests) → PR 2 (generator template + tests) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `$withSession`/`$transaction` primitive on `IndigoClientBase`, pg.Pool + injected-hook paths, ALS nesting guard, harness + regression tests | PR 1 | `node packages/client/test/transactions.mjs` | PGlite via `pglite-harness.mjs` (real embedded Postgres, no network) | Revert `client.ts`/`types.ts` transaction additions + delete `transactions.mjs`; existing `client.mjs` suite untouched |
| 2 | Generator `__delegates` factory + `TransactionClient` + `$transaction` emission, generator tests | PR 2 (base = PR 1 branch) | `node packages/generator/test/enum-mapping.mjs && node packages/generator/test/transaction-emission.mjs` | N/A — generator tests are string/snapshot assertions over `generateClient()` output, no runtime DB needed | Revert `packages/generator/src/client.ts` template changes + delete new generator test file; PR 1's client runtime is independently mergeable/functional without it |

## Phase 1: Slice 1 — Client Runtime Types (Foundation)

- [x] 1.1 Add `TransactionHook` type alias to `packages/client/src/types.ts`: `export type TransactionHook = <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;`
- [x] 1.2 Add optional `transaction?: TransactionHook` field to the `db` shape inside `IndigoClientOptions` in `packages/client/src/types.ts`

## Phase 2: Slice 1 — RED Tests (Harness + Transaction Suite)

- [x] 2.1 Update `packages/client/test/pglite-harness.mjs`: change `createPgliteDb(db)` to return `{ exec, transaction }`, where `transaction(fn)` calls `db.transaction(async (tx) => fn(async (sql, params) => (await tx.query(sql, params)).rows))` per design's harness snippet
- [x] 2.2 Create `packages/client/test/transactions.mjs` and write failing scenario: commit — `fn` resolves, writes visible after `$transaction` resolves (spec: Commit on success)
- [x] 2.3 Add failing scenario: rollback-on-throw — `fn` throws synchronously, session rolled back, `$transaction` rejects, no writes visible (spec: Callback throws synchronously)
- [x] 2.4 Add failing scenario: rollback-on-rejected-promise — `fn` returns a rejected promise, session rolled back, rejection reason propagated (spec: Callback's promise rejects)
- [x] 2.5 Add failing scenario: nesting-rejected — `tx.$transaction(...)` inside an active transaction rejects with explicit nested-transaction error; outer transaction session unaffected (spec: Nesting via tx.$transaction, Reentrant call on the same client)
- [x] 2.6 Add failing scenario: unsupported-executor-error — client built with injected `db` lacking `transaction` hook rejects `$transaction(fn)` with explicit unsupported error, `fn` never invoked (spec: Injected executor without a transaction hook)
- [x] 2.7 Add failing scenario: no-leak-on-mid-callback-throw — a `tx.<model>.<op>(...)` call throws before `fn` settles; session released exactly once in `finally`, no connection leak, rejection surfaces (spec: A tx operation throws before fn settles, Release happens on every outcome)
- [x] 2.8 Register `transactions.mjs` in `packages/client/package.json`'s `test` script; run `node packages/client/test/transactions.mjs` and confirm all new scenarios fail (RED) against unmodified `client.ts`

## Phase 3: Slice 1 — GREEN Implementation

- [x] 3.1 In `packages/client/src/client.ts`, add a private `AsyncLocalStorage<true>` field (`node:async_hooks`) as the nesting-guard context
- [x] 3.2 Implement `protected async $withSession<T>(fn)` per design: nesting check via ALS store, pg.Pool path (`pool.connect()` → `BEGIN` → scoped exec → `COMMIT`/`ROLLBACK` → `client.release(poison)` in `finally`), injected path (delegate to `options.db.transaction` hook, throw explicit unsupported error when absent)
- [x] 3.3 Wire the pg.Pool path's session executor so every statement issued through `tx` runs on the checked-out `PoolClient`, not `pool.query`
- [x] 3.4 Ensure rollback failure (`ROLLBACK` itself throwing) logs via `console.error` and marks the connection poisoned for `release(poison)`, without masking the original error
- [x] 3.5 Add a public `$transaction<T>(fn)` on `IndigoClientBase` that calls `$withSession` (generator's emitted subclass overrides/wires typed delegates in Slice 2 — base method stays usable untyped)
- [x] 3.6 Run `node packages/client/test/transactions.mjs` and confirm all Phase 2 scenarios pass (GREEN)
- [x] 3.7 Run `node packages/client/test/client.mjs` to confirm no regression on existing non-transaction client behavior

## Phase 4: Slice 1 — Verification

- [x] 4.1 Run `pnpm --filter @indigodb/client build && pnpm --filter @indigodb/client lint` to confirm `tsc` passes with the new types
- [x] 4.2 Run `pnpm --filter @indigodb/client test` (full package test script) to confirm both suites pass together

## Phase 5: Slice 2 — RED Generator Tests

- [x] 5.1 Create `packages/generator/test/transaction-emission.mjs` following `enum-mapping.mjs`'s string-assertion pattern; write failing assertion that `generateClient()` output contains a `function __delegates(exec, realtime)` factory
- [x] 5.2 Add failing assertion that output contains an emitted `TransactionClient` interface exposing one delegate field per model (readonly, `RealtimeModelDelegate` for `@@realtime` models) plus `$queryRaw`
- [x] 5.3 Add failing assertion that the generated `IndigoClient` constructor calls `__delegates(this.exec, this.$realtime)` once and assigns fields from its result, rather than initializing delegates as class-field expressions
- [x] 5.4 Add failing assertion that the generated `IndigoClient` class emits `$transaction<T>(fn)` calling `this.$withSession((exec) => fn(__delegates(exec, this.$realtime)))`
- [x] 5.5 Run `node packages/generator/test/transaction-emission.mjs` and confirm all new assertions fail (RED) against unmodified `packages/generator/src/client.ts`

## Phase 6: Slice 2 — GREEN Implementation

- [x] 6.1 In `packages/generator/src/client.ts`, replace class-field-initializer delegate emission with an emitted `__delegates(exec, realtime)` factory function (one per-model delegate assignment inside)
- [x] 6.2 Emit the `TransactionClient` interface (readonly per-model delegates + `$queryRaw`) alongside the factory
- [x] 6.3 Update the emitted `IndigoClient` constructor to call `__delegates(this.exec, this.$realtime)` once and assign the result to `this.<model>` fields
- [x] 6.4 Emit `$transaction<T>(fn: (tx: TransactionClient) => Promise<T>)` on `IndigoClient` per the design's interface snippet
- [x] 6.5 Run `node packages/generator/test/transaction-emission.mjs` and confirm all Phase 5 assertions pass (GREEN)
- [x] 6.6 Run `node packages/generator/test/enum-mapping.mjs` to confirm no regression in existing generator output

## Phase 7: Slice 2 — Verification

- [x] 7.1 Run `pnpm --filter @indigodb/generator build && pnpm --filter @indigodb/generator lint`
- [x] 7.2 Run `pnpm build` from root to confirm the generated client template still compiles end-to-end through `@indigodb/client`'s exported `Executor`/`RealtimeConnectionManager` types
- [x] 7.3 Update `openspec/changes/transactions-epic/design.md`'s Open Questions: confirm `tx.$queryRaw` exposure decision and AsyncLocalStorage Node-only note are resolved in the shipped code

## Phase 8: Verification remediation — pg.Pool path real coverage (CRITICAL gap closure)

- [x] 8.1 Add `packages/client/test/pglite-socket-harness.mjs`: fronts a PGlite instance with `@electric-sql/pglite-socket` (pinned to the exact `@electric-sql/pglite` peer version already used) so a real `pg.Pool` genuinely speaks the wire protocol to it, matching this repo's "PGlite = real embedded Postgres" precedent (`pg-harness.mjs`) while actually exercising `pg`'s network path. Documents the verified limitation that PGlite's single-writer engine cannot service a second connection's `BEGIN` while another is mid-transaction (empirically confirmed hang, not theoretical), so the harness is scoped to dedicated-connection/commit/rollback/release proofs, never overlapping open transactions.
- [x] 8.2 Add `packages/client/test/transactions-pg.mjs`: constructs `IndigoClientBase` on the default `pg.Pool` path (no injected `db`) against `withRealPostgres`, and proves — (a) `$transaction` checks out a dedicated connection via `pool.connect()` and holds it for `fn`'s duration (a `pool: { max: 1 }` pool blocks a concurrent outside query until release — satisfies spec's "pg.Pool path checks out a dedicated connection" scenario), (b) commit persists the write, (c) rollback-on-throw actually rolls back, (d) N sequential transactions on a `max: 1` pool never hang/exhaust (session genuinely released every time), (e) a rolled-back transaction still releases its connection immediately. Each `check()` is wrapped in a 15s timeout so a leaked/hung connection fails fast instead of stalling CI.
- [x] 8.3 Wire `transactions-pg.mjs` into `packages/client/package.json`'s `test` script (unconditional — no live external Postgres or env var required, matching the migrator suite's PGlite-only convention) and add `@electric-sql/pglite-socket` as a devDependency pinned to the version matching the installed `@electric-sql/pglite` peer requirement.
- [x] 8.4 Run `pnpm --filter @indigodb/client test`, `pnpm build --force`, `pnpm lint --force`, `pnpm test --force` from root; confirm all green and the new suite is stable across repeated runs (no flakiness from timing-based assertions).
