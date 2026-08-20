# Tasks: Advisory Lock Around `migrate deploy`

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~170 total (~25 src + ~145 test) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | None — single slice |
| Delivery strategy | auto-chain (single slice, no chaining needed) |
| Chain strategy | N/A |

Decision needed before apply: No
Chained PRs recommended: No
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Session-level `pg_try_advisory_lock`/`pg_advisory_unlock` around `migrateDeploy`, deploy-only, fail-fast refusal | Single PR | `node packages/cli/test/migrate-runner.mjs` | PGlite via extended `packages/cli/test/migrate-harness.mjs` (`spyMigrationClient`) | Remove `MIGRATION_LOCK_KEY` + the two `client.query` lock calls + `locked` guard from `migrateDeploy`; delete `spyMigrationClient` and the 4 new test cases — `migrateDeploy` returns to today's unlocked behavior exactly |

## Slice — Lock Acquire/Release + Refusal (single PR)

Satisfies (spec): `migrate-deploy-concurrency` — "acquires session-level `pg_try_advisory_lock` before `ensureHistory`/`checksumPreflight`/any pending migration apply", "fail-fast refusal on contention, no block/wait/retry/timeout", "lock released via `pg_advisory_unlock` on both success and failure paths, not released if never acquired", "`migrate dev`/`migrate status` unaffected", "no flag/env/config bypass".

- [x] 1.1 [RED] `packages/cli/test/migrate-harness.mjs`: add `spyMigrationClient(inner, { onQuery } = {})` — wraps a `MigrationClient`, records every `{ sql, params }` pair passed to `query` (and `exec`) in order, forwards to `inner` by default, and lets `onQuery(sql, params)` override the return value (used to force `pg_try_advisory_lock` to resolve `false` for the contention case) without touching `inner`'s real state. Export `queries` (the recorded array) alongside the wrapped client so tests can assert on it directly.
- [x] 1.2 [RED] `packages/cli/test/migrate-runner.mjs`: new section "advisory lock around `migrate deploy`" with a case — happy-path deploy against a `spyMigrationClient`-wrapped harness client asserts `pg_try_advisory_lock` is the FIRST recorded query, `params[0]` equals the exported `MIGRATION_LOCK_KEY` constant (import it from `../dist/migrate-runner.js` once it exists), and occurs before any `"_indigo_migrations"`-touching query; asserts `pg_advisory_unlock` is the LAST recorded query, same key. Run `node packages/cli/test/migrate-runner.mjs` and confirm it fails (`MIGRATION_LOCK_KEY` / lock calls do not exist yet).
- [x] 1.3 [RED] `packages/cli/test/migrate-runner.mjs`: add a contention case — `spyMigrationClient`'s `onQuery` forces the `pg_try_advisory_lock` query to return `{ rows: [{ pg_try_advisory_lock: false }] }`; assert `migrateDeploy` sets `process.exitCode = 1`, the printed message names the lock conflict, zero rows are added to `_indigo_migrations` (no pending migration applied), no `pg_advisory_unlock` is recorded, and the "Deploy failed, rolled back" message is NOT printed (refusal, not a caught throw).
- [x] 1.4 [RED] `packages/cli/test/migrate-runner.mjs`: add a failure-path case — a pending migration file with invalid SQL causes `applyMigrationSql` to throw mid-loop after the lock was already acquired; assert `pg_advisory_unlock` is still recorded exactly once (in `finally`), same key, after the failure — regression guard that the `locked` guard doesn't skip release on the existing catch/rollback path.
- [x] 1.5 [RED] `packages/cli/test/migrate-runner.mjs`: add a deploy-only-scope case — run `migrateDev` and `migrateStatus` (both already covered by existing harness setup) through `spyMigrationClient` and assert zero recorded queries contain `advisory` in their SQL text, proving the lock is deploy-only.
- [x] 1.6 [GREEN] `packages/cli/src/migrate-runner.ts`: add `const MIGRATION_LOCK_KEY = 80_600_501_929_807;` as a module constant next to `HISTORY_TABLE`, with a doc comment noting it is `0x494E4449474F` (ASCII "INDIGO"), a fixed non-configurable per-database session-advisory-lock key.
- [x] 1.7 [GREEN] `packages/cli/src/migrate-runner.ts`: in `migrateDeploy`, as the first statement inside the existing `try` (before `ensureHistory`), add a `let locked = false;` and acquire: `const lockResult = await client.query("SELECT pg_try_advisory_lock($1)", [MIGRATION_LOCK_KEY]);` — check the returned boolean; on `true` set `locked = true` and continue; on `false`, print `❌ migrate deploy refused: another deploy already holds the migration lock`, set `process.exitCode = 1`, and `return` (no throw — matches the `checksumPreflight` refusal shape at line 348-354, avoiding the catch block's "Deploy failed, rolled back" mislabel).
- [x] 1.8 [GREEN] `packages/cli/src/migrate-runner.ts`: in the existing `finally` block, before `await client.end();`, add `if (locked) { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); }` — ignore the returned boolean (unlock failure is not surfaced; `client.end()` releases the session lock regardless).
- [x] 1.9 [GREEN] `packages/cli/src/migrate-runner.ts`: update the module header comment (lines 1-10) with one sentence noting `migrateDeploy` serializes concurrent runs via a session-level advisory lock, deploy-only.
- [x] 1.10 [GREEN] Run `node packages/cli/test/migrate-runner.mjs` — confirm 1.2-1.5 now pass, plus all pre-existing cases (Slice 1/2 of `migration-checksum-staleness`) still pass unchanged.
- [x] 1.11 [VERIFY] `packages/cli/test/migrate-runner.mjs`: add a comment in the new "advisory lock" section documenting the accepted PGlite test-coverage gap — upstream issue #704 (`pg_advisory_lock` does not block on re-acquisition; PGlite is also a single in-process instance, so true racing-connection contention cannot be simulated here) — tests assert SQL call sequence/key/ordering via `spyMigrationClient`, not real blocking; real-Postgres contention verification stays manual/out of harness.
- [x] 1.12 [VERIFY] `pnpm --filter @indigodb/cli build && pnpm --filter @indigodb/cli lint && pnpm --filter @indigodb/cli test` green.
- [x] 1.13 [VERIFY] `pnpm build && pnpm lint && pnpm test` (full workspace) and `cd crates && cargo test` — confirm no cross-package regression (no Rust/compiler files touched, sanity gate per project convention).
- [x] 1.14 [COMMIT] Commit: `feat(cli): serialize migrate deploy with a session advisory lock`.

## Post-slice cleanup

- [x] 2.1 Confirm the proposal's Success Criteria checklist items are all demonstrably met by this slice's tests (contention refusal message names the lock conflict, applies nothing; lock acquired before `ensureHistory`/released before/with `client.end()` including on the error path; `migrate dev`/`migrate status` behavior unchanged; PGlite contention gap documented in-repo; `pnpm build`, `lint`, `test` and `cd crates && cargo test` all green).
