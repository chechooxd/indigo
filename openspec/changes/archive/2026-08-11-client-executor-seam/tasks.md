# Tasks: Carve the Executor seam in `@indigodb/client`

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~270 authored (~35 `client.ts`, ~4 `package.json`, ~230 test) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Executor seam + regression harness, single slice | PR 1 | `pnpm --filter @indigodb/client test` | `test/pglite-harness.mjs` — in-process PGlite via `withDatabase`/`createPgliteExecutor` | Revert `client.ts`, `package.json`, `test/` — no other package touches this seam |

## Phase 1: Harness Foundation

- [x] 1.1 Add `@electric-sql/pglite@^0.5.4` devDependency and `"test": "node test/client.mjs"` script to `packages/client/package.json`.
- [x] 1.2 Create `packages/client/test/pglite-harness.mjs`: `withDatabase(fn)` (spins up in-memory PGlite, runs `fn`, tears down) and `createPgliteExecutor(db) = async (sql, params) => (await db.query(sql, params)).rows`, following the house style of `packages/migrator/test/pg-harness.mjs` / `packages/cli/test/studio-harness.mjs`.

## Phase 2: Constructor seam (RED → GREEN)

- [x] 2.1 RED — in `packages/client/test/client.mjs`, write a failing test: constructing `IndigoClientBase` with `options.db = { exec: stub }` and no `connectionString`/`pool`/`DATABASE_URL` does not throw (spec: Executor supplied, no connectionString, no options.pool).
- [x] 2.2 GREEN — in `packages/client/src/client.ts`, add `db?: { exec: Executor; close?: () => Promise<void> }` to `IndigoClientOptions`; replace `pool: PgPool` field with `pool: PgPool | null`, add `run: Executor` and `closeInjected: (() => Promise<void>) | undefined`; branch the constructor exactly per design (`if (options.db) {...} else {...}`), moving the missing-connection-string guard inside the `else` branch unchanged.
- [x] 2.3 RED — write a failing test asserting construction with no `options.db`, no `connectionString`, no `options.pool`, and no `DATABASE_URL` throws `Error("IndigoClient: no connection string. Pass \`connectionString\` or set DATABASE_URL.")` (byte-for-byte, regression-guarding the pre-existing string).
- [x] 2.4 GREEN — confirm 2.2's guard placement satisfies 2.3 (no new production code expected; run the test to prove it).
- [x] 2.5 RED — write a failing test asserting no `pg.Pool` is constructed on the injected path (e.g. assert `client["pool"] === null` or equivalent observable check without touching internals improperly).
- [x] 2.6 GREEN — confirm 2.2 already satisfies this; run to prove.

## Phase 3: exec / $queryRaw path-independence

- [x] 3.1 GREEN (structural, no new test) — rewrite `exec` in `client.ts` as a branch-free logging wrapper delegating to `this.run`, per design's exact new logic.
- [x] 3.2 RED — write a failing test: `$queryRaw(sql, params)` on a client built with an injected stub executor returns exactly the rows the stub resolves with.
- [x] 3.3 GREEN — run 3.2 against the Phase 2/3.1 implementation; it should now pass with no further production change.

## Phase 4: $disconnect across all three variants + realtime teardown

- [x] 4.1 RED — write a failing test: `$disconnect()` on the default `pg.Pool` path calls `pool.end()` (stub/spy the pool, or use the PGlite integration path if a real pool is impractical to assert directly — prefer a lightweight stub `Pool`-shaped object if unit-level).
- [x] 4.2 RED — write a failing test: `$disconnect()` on the injected-with-`close` path calls the injected `close` and does NOT call `pool.end()`.
- [x] 4.3 RED — write a failing test: `$disconnect()` on the injected-without-`close` path resolves without throwing (this is the crash scenario against `undefined` before the fix).
- [x] 4.4 GREEN — rewrite `$disconnect()` in `client.ts` per design: tear down `realtimeManager` first, then `if (this.pool) await this.pool.end(); else await this.closeInjected?.();`.
- [x] 4.5 RED — write a failing test: after `$realtime()` is invoked once on the default path, `$disconnect()` closes and clears the realtime connection manager.
- [x] 4.6 RED — write a failing test: after `$realtime()` is invoked once on the injected path, `$disconnect()` closes and clears the realtime connection manager identically.
- [x] 4.7 GREEN — run 4.1–4.3, 4.5–4.6 against 4.4; all should pass with no further production change.

## Phase 5: CRUD passthrough smoke test

- [x] 5.1 RED — in `packages/client/test/client.mjs`, using `withDatabase` + `createPgliteExecutor` from `pglite-harness.mjs`, write one failing integration test: construct an `IndigoClient`-shaped delegate (or `IndigoClientBase` + a minimal `ModelDelegate`) against a PGlite-backed table, then run `create` → `findMany` → `update` → `delete` sequentially and assert each step's result.
- [x] 5.2 GREEN — run 5.1 against the completed seam; it should pass with no further production change, proving `this.exec` is path-independent end-to-end. Do not add defensive `::type` casts to fixtures unless 5.1 actually fails without one.

## Phase 6: Verification

- [x] 6.1 Run `pnpm --filter @indigodb/client test` — full suite green.
- [x] 6.2 Run `pnpm build`, `pnpm lint`, `pnpm test` (root) — confirm no regressions elsewhere.
- [x] 6.3 Confirm `packages/client/src/delegate.ts` and `packages/generator/src/client.ts` are untouched in the diff (`git diff --stat`).
- [x] 6.4 Confirm `packages/client/src/index.ts` needs no edit (types already re-exported); leave untouched.
