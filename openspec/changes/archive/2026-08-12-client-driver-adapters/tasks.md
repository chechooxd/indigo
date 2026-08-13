# Tasks: Client Driver Adapters

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~350-450 (2 new adapters, 2 new test files, client.ts refactor, README, harness simplification) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (matches proposal's explicit Rollback Plan: "revert the single PR") |
| Delivery strategy | auto-chain |
| Chain strategy | pending (not applicable — single PR fits scope) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `createPgAdapter` + `createPGliteAdapter`, `IndigoClientBase` refactor, docs | PR 1 (single PR) | `node --test packages/client/test/adapters.mjs packages/client/test/adapters-pg.mjs` | `pglite-socket-harness.mjs` (real PGlite over a Postgres wire socket) | Revert the single PR; nothing else imports `src/adapters/` |

## Phase 1: Foundation — Types & Barrel

- [x] 1.1 Add `DriverAdapter` interface to `packages/client/src/types.ts` (Decision 1); type `IndigoClientOptions.db?: DriverAdapter`.
- [x] 1.2 Create empty `packages/client/src/adapters/index.ts` barrel scaffold (populated in Phase 3). — barrel exists and is already fully populated (Phase 3.3 content), not left as an empty scaffold.

## Phase 2: `createPgAdapter` (RED → GREEN)

- [x] 2.1 RED: `packages/client/test/adapters.mjs` — fake `{query,connect,end}` pool spies: `close()` calls `end()` for `PoolConfig` input, does not for `{pool}` input (spec scenarios: Constructed from PoolConfig/existing Pool, caller-owned not closed, adapter-owned closed). — done this pass; both scenarios pass against the existing `createPgAdapter` implementation.
- [x] 2.2 RED: extend `adapters.mjs` — fake client spy asserts `BEGIN`→fn→`COMMIT` on success; `BEGIN`→fn→`ROLLBACK`+poison-aware `release` on throw (spec: transaction commit/rollback scenarios). — done this pass; also covers the rollback-itself-fails poison path.
- [x] 2.3 RED: extend `adapters.mjs` — fake pool rejecting `{code:"23505"}` → `IndigoDatabaseError` (spec: Typed error thrown via the adapter path). — done this pass.
- [x] 2.4 GREEN: implement `packages/client/src/adapters/pg.ts` — `createPgAdapter(config)`, `"pool" in config` discrimination, `exec`/`transaction`/`close`/`pool` (Decisions 2-4); make 2.1-2.3 pass. — confirmed green: all of 2.1-2.3's new tests pass against the existing implementation, no adapter code changes needed.

## Phase 3: `createPGliteAdapter` (RED → GREEN)

- [x] 3.1 RED: `adapters.mjs` — real PGlite devDependency instance, assert query execution and `transaction(tx => …)` delegation, never raw BEGIN/COMMIT (spec: Client built through the PGlite adapter executes queries). — done this pass: wraps a real `PGlite` instance's `query`/`transaction` to record every literal control statement, drives `IndigoClientBase` through `createPGliteAdapter`, asserts commit/rollback/isolation and zero raw BEGIN/COMMIT/ROLLBACK.
- [x] 3.2 GREEN: implement `packages/client/src/adapters/pglite.ts` — `createPGliteAdapter(pglite, {close?})`, structural `PGliteLike` interface, no `@electric-sql/pglite` runtime import (Decisions 6-7).
- [x] 3.3 Populate `packages/client/src/adapters/index.ts` barrel with both `createPgAdapter`/`createPGliteAdapter` exports.

## Phase 4: Wire `IndigoClientBase` to `createPgAdapter`

- [x] 4.1 Baseline: confirm `test/client.mjs`, `test/transactions-pg.mjs`, `test/database-errors.mjs`, `test/extensions.mjs` pass unmodified before refactor. — confirmed post-fix (prior apply pass had left `client.ts` in a broken, non-compiling state; this pass fixed the constructor refactor first, then ran all four suites individually — all pass, and `git diff --stat`/SHA-256 confirm none of the 4 files were touched).
- [x] 4.2 GREEN: refactor `packages/client/src/client.ts`'s `connectionString` constructor branch to call `createPgAdapter` internally; keep the pre-adapter "no connection string" guard message verbatim (`test/client.mjs:63`); keep `pool` field assigned from `adapter.pool` (`test/client.mjs:59` asserts `null` on `db` path). — DONE this pass: fixed dangling references to unimported `Pool`/`withDatabaseErrors` left by the stalled prior apply.
- [x] 4.3 GREEN: delete `$withSession`'s pool branch and `$disconnect`'s `pool.end()`; route both off `adapter.txHook`/`adapter.close`. — DONE this pass.
- [x] 4.4 Create `packages/client/test/adapters-pg.mjs` — pg adapter parity test over `pglite-socket-harness.mjs`, mirroring `transactions-pg.mjs` assertions against `{db: createPgAdapter({connectionString})}`. — done this pass: commit, rollback, sequential-release-under-pool-max-1, caller-owned-pool-not-ended-by-$disconnect, and typed-unique-violation scenarios, all against a real Postgres engine over a real TCP socket.
- [x] 4.5 Regression proof: `transactions.mjs`, `transactions-pg.mjs`, `database-errors.mjs`, `extensions.mjs`, `client.mjs` still pass byte-unmodified; any required edit means STOP and re-check design, not patch the test. — verified: all pass, zero edits, SHA-256 hashes unchanged across the fix.

## Phase 5: Public Exports & Harness Simplification

- [x] 5.1 `packages/client/src/index.ts`: add `export * from "./adapters/index.js"`. — done this pass.
- [x] 5.2 Simplify `packages/client/test/pglite-harness.mjs`'s `createPgliteDb` to delegate to `createPGliteAdapter` (delete duplicated logic). — done this pass; `createPgliteDb(db)` is now a one-line delegation.
- [x] 5.3 Add `adapters.mjs` and `adapters-pg.mjs` to `packages/client/package.json`'s `test` script. — done this pass.

## Phase 6: Docs & Closing Verification

- [x] 6.1 Create `packages/client/README.md` — bring-your-own-driver guide incl. Neon HTTP recipe shaped as an `Executor`; state Neon cannot honor the session-bound `transaction` hook; no `createNeonAdapter` export, no new dependency. — done this pass.
- [x] 6.2 Run `pnpm build --filter=@indigodb/client`; fix type errors only in new/modified adapter files. — DONE this pass, zero type errors (fixed the stalled apply's broken `client.ts`).
- [x] 6.3 Run full `pnpm build && pnpm lint && pnpm test` at repo root — all green. — confirmed this pass (18/18 lint, 10/10 build, 16/16 test tasks succeeded).
- [x] 6.4 Confirm `git diff --stat` for the 4 named pre-existing suites is empty (byte-unmodified) per design's proof requirement; confirm `packages/client/package.json` gained zero new runtime dependencies. — confirmed: `client.ts`'s import list still uses only pre-existing `pg` (dependency) — no new `dependencies` entries added.

### Remaining work

None. All 21 tasks are complete: `test/adapters.mjs` (2.1-2.3, 3.1), `test/adapters-pg.mjs`
(4.4), the public `adapters` barrel re-export (5.1), `pglite-harness.mjs` simplification (5.2),
`package.json` test-script wiring (5.3), and `packages/client/README.md` (6.1) were all added
this pass. Full monorepo `pnpm build`/`pnpm lint`/`pnpm test` are green (10/10 build, 18/18 lint,
16/16 test tasks), and the critical regression proof — `transactions-pg.mjs`, `database-errors.mjs`,
`extensions.mjs`, `client.mjs` untouched by this pass (only `pglite-harness.mjs`, itself listed
as "Modify" in design.md's File Changes table, was intentionally changed) — holds.
