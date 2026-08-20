# Tasks: Migration Checksum + Staleness Detection

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~750 total (Slice 1 ~400, Slice 2 ~350) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Slice 1 (seam+schema+harness) -> Slice 2 (enforcement, targets Slice 1 branch) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `MigrationClient` seam, DDL+ALTER+backfill, checksum/success recorded on apply, NO enforcement | PR 1 (base: feature/migration-checksum-staleness) | `node packages/cli/test/migrate-runner.mjs` | PGlite via new `packages/cli/test/migrate-harness.mjs` (mirrors `studio-harness.mjs`) | Revert `migrate-runner.ts`'s DDL/backfill/record changes + delete the two new test files; columns become unused, no consumer yet |
| 2 | 4th shadow desync rule, deploy preflight refusal, status drift reporting, doc-comment fixes | PR 2 (base: PR 1 branch) | `node packages/migrator/test/shadow.mjs && node packages/cli/test/migrate-runner.mjs` | Same PGlite harness (`migrate-harness.mjs`) + existing `shadow.mjs` injected doubles | Revert enforcement call sites in `shadow.ts`/`migrate-runner.ts`; PR 1's schema/recording stays intact and inert |

## Slice 1 — Seam + Schema + Harness (PR 1, base: feature/migration-checksum-staleness)

Satisfies (spec): `migration-history-integrity` — "records a checksum and success flag per row", "sha256 hex of exact bytes", "legacy table silently backfills", "success recorded forward-compatible, no enforcement yet".

- [x] 1.1 [RED] Create `packages/cli/test/migrate-harness.mjs`: `withDatabase(fn)` (fresh PGlite per test, mirrors `studio-harness.mjs`) + `createMigrationClient(db)` adapting `MigrationClient` (`query`->`db.query` with `$n` params, `exec`->`db.exec` for multi-statement/BEGIN-COMMIT bodies, `end`->no-op) + a `mkdtempSync`-based migrations-root helper usable as `cwd`.
- [x] 1.2 [RED] Create `packages/cli/test/migrate-runner.mjs` (first-ever direct suite) with failing assertions against not-yet-existing seams: `ensureHistory` creates `checksum text` + `success boolean NOT NULL DEFAULT true` columns on fresh install; a pre-seeded legacy 3-column table gets `checksum`/`success` added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Run `node packages/cli/test/migrate-runner.mjs` and confirm failure (module/export missing).
- [x] 1.3 [RED] Extend `migrate-runner.mjs`: legacy rows with NULL checksum get silently backfilled from on-disk `migration.sql` content on the next `ensureHistory` call, no prompt/output; a second run is a no-op (idempotent, zero rows touched).
- [x] 1.4 [RED] Extend `migrate-runner.mjs`: `migrateDev` records `checksum` (sha256 hex of the exact written `migration.sql` bytes) + `success = true` on the INSERT for a newly created migration.
- [x] 1.5 [RED] Extend `migrate-runner.mjs`: `migrateDeploy` records `checksum` + `success = true` on the INSERT for each pending migration it applies (same computation, no comparison yet).
- [x] 1.6 [GREEN] `packages/cli/src/migrate-runner.ts`: export a `MigrationClient` port (`query(sql, params?)`, `exec(sql)`, `end()`) and thread an optional `RunnerSeams { createClient?, cwd? }` through `migrateDev`'s `DevOptions`, `migrateDeploy(connectionString, seams?)`, `migrateStatus(connectionString, seams?)`; default `createClient` still builds a real `pg.Client`, default `cwd` still `process.cwd()`. `index.ts` unchanged (no new CLI flags). NOTE: `shadow.ts` untouched this slice — `MigrationClient` is a CLI-only pg.Client abstraction; `MigrationSource`'s checksum fields are Slice 2 per the design's file-changes table.
- [x] 1.7 [GREEN] `packages/cli/src/migrate-runner.ts`: add `migrationChecksum(sql: string): string` using `node:crypto`'s `createHash("sha256")` over the exact `migration.sql` bytes.
- [x] 1.8 [GREEN] `packages/cli/src/migrate-runner.ts`: rewrite `ensureHistory` to `CREATE TABLE IF NOT EXISTS` with the full 5-column shape (`id, name, applied_at, checksum, success`) plus the two idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements for upgrade.
- [x] 1.9 [GREEN] `packages/cli/src/migrate-runner.ts`: implement silent backfill in `ensureHistory` — `SELECT name FROM "_indigo_migrations" WHERE checksum IS NULL ORDER BY id`, compute checksum from `migrations/<id>/migration.sql` when the file exists, `UPDATE ... SET checksum = $1 WHERE name = $2 AND checksum IS NULL`; missing file leaves the row NULL (left to existing desync rules).
- [x] 1.10 [GREEN] `packages/cli/src/migrate-runner.ts`: `migrateDev`'s success INSERT includes `checksum` (via `migrationChecksum(sql)`) and `success = true`; `migrateDeploy`'s per-pending-migration INSERT does the same.
- [x] 1.11 [GREEN] Run `node packages/cli/test/migrate-runner.mjs` — confirm all 1.2-1.5 assertions now pass.
- [x] 1.12 [VERIFY] `packages/cli/package.json`: append `&& node test/migrate-runner.mjs` to the `test` script.
- [x] 1.13 [VERIFY] `pnpm --filter @indigodb/cli build && pnpm --filter @indigodb/cli lint && pnpm --filter @indigodb/cli test` green. No other package touched in this slice, so `pnpm build && pnpm lint` (root) stays green too.
- [x] 1.14 [COMMIT] Direct commit to `feature/migration-checksum-staleness`: `feat(cli): record migration checksums, no enforcement yet`.

## Slice 2 — Enforcement + Reporting (PR 2, base: PR 1 branch — requires Slice 1 merged first)

Satisfies (spec): `migration-history-integrity` — "`migrate deploy` refuses on checksum drift before applying any pending migration", "checksum drift is a hard refusal with no override", "`migrate status` reports drift as a non-fatal diagnostic". `shadow-database-replay` (delta) — "a checksum mismatch on a recorded migration produces a hard refusal" (ADDED), "order divergence and checksum drift are two independent desync signals" (MODIFIED, doc comment).

- [ ] 2.1 [RED] `packages/migrator/test/shadow.mjs`: update every existing `MigrationSource` test double to also satisfy the new required `checksum(id)` + `recordedChecksums` fields (non-optional per design — a forgetful caller must not silently lose enforcement). Confirm the existing suite fails to compile/run until 2.4 lands.
- [ ] 2.2 [RED] `packages/migrator/test/shadow.mjs`: add case C.12 — a recorded id whose on-disk checksum differs from `recordedChecksums[id]` refuses via `ShadowReplayError` naming the drifted id, same shape as the existing missing/pending refusals.
- [ ] 2.3 [RED] `packages/migrator/test/shadow.mjs`: add case C.13 — matching checksums for all recorded ids replay clean, no diagnostic; a `null` stored checksum (legacy, unbackfilled) skips comparison for that id without refusing.
- [ ] 2.4 [GREEN] `packages/migrator/src/shadow.ts`: extend `MigrationSource` with `checksum(id: string): string` and `recordedChecksums: Record<string, string | null>` (jsdoc block, lines 33-45 today); implement the 4th desync rule in `buildShadowSchema` — for each recorded id with a non-null `recordedChecksums[id]`, compare against `source.checksum(id)`, mismatch throws `ShadowReplayError` naming the drifted id(s), reusing the existing error class/shape.
- [ ] 2.5 [GREEN] `packages/migrator/src/shadow.ts`: rewrite the header doc comment (lines 14-17, "records NAMES, not checksums ... no stronger signal than 'recorded' vs 'on disk'") to state order divergence and checksum drift are two independent desync signals, neither substitutes for the other. Reword `buildShadowSchema`'s jsdoc (lines 126-127, "Desync rules (no checksums exist; ...)") to drop the false premise and add the 4th bullet for the checksum-mismatch rule.
- [ ] 2.6 [GREEN] Run `node packages/migrator/test/shadow.mjs` — confirm C.12/C.13 and all pre-existing desync cases (C.8-C.11) pass unchanged.
- [ ] 2.7 [RED] `packages/cli/test/migrate-runner.mjs`: add a case — editing an applied migration's on-disk `migration.sql` (recorded checksum now stale) causes `migrateDev` to refuse via the shadow-replay path, printing the drifted id, `process.exitCode = 1`, no schema/history mutation.
- [ ] 2.8 [RED] `packages/cli/test/migrate-runner.mjs`: add a case — `migrateDeploy` against a database with a drifted already-recorded migration refuses BEFORE applying any pending migration; `process.exitCode = 1` (not thrown — the existing `catch` block's "Deploy failed, rolled back" message would mislabel a preflight refusal); zero pending migrations get applied.
- [ ] 2.9 [RED] `packages/cli/test/migrate-runner.mjs`: add a case — `migrateDeploy` with no drift applies pending migrations normally (regression guard for 2.11).
- [ ] 2.10 [RED] `packages/cli/test/migrate-runner.mjs`: add a case — `migrateStatus` prints `⚠ modified` for a drifted row and `✓ applied` for clean rows, `process.exitCode` untouched (exit 0); confirm no env var/flag exists to bypass drift refusal (assert `migrateDev`/`migrateDeploy` behavior is identical regardless of any injected override attempt).
- [ ] 2.11 [GREEN] `packages/cli/src/migrate-runner.ts`: update `fsMigrationSource`/`recordedMigrations` to supply `checksum(id)` (reads + hashes `migrations/<id>/migration.sql`) and `recordedChecksums` (from the history table's `checksum` column, `ORDER BY id`) into the `MigrationSource` passed to `buildShadowSchema`, satisfying `migrateDev`'s enforcement via the Slice-1-landed shadow path.
- [ ] 2.12 [GREEN] `packages/cli/src/migrate-runner.ts`: add `checksumPreflight(client)` in `migrateDeploy` — recompute + compare checksums for every already-recorded id before applying any pending migration; on mismatch, print `❌ migrate deploy refused: ...` naming the drifted id(s), set `process.exitCode = 1`, `return` (no throw, no partial apply).
- [ ] 2.13 [GREEN] `packages/cli/src/migrate-runner.ts`: extend `migrateStatus` to compute per-row drift (compare recorded vs on-disk checksum where both are non-null) and print `⚠ modified` vs `✓ applied` vs `· pending`; never sets `process.exitCode`.
- [ ] 2.14 [GREEN] `packages/cli/src/migrate-runner.ts`: update the module header comment (lines 1-10) to mention checksum/drift responsibilities alongside the existing dev/deploy/status description.
- [ ] 2.15 [GREEN] Run `node packages/cli/test/migrate-runner.mjs` — confirm 2.7-2.10 now pass, plus all Slice 1 cases still pass unchanged.
- [ ] 2.16 [VERIFY] `pnpm --filter @indigodb/migrator build && pnpm --filter @indigodb/migrator lint && pnpm --filter @indigodb/migrator test` and `pnpm --filter @indigodb/cli build && pnpm --filter @indigodb/cli lint && pnpm --filter @indigodb/cli test` both green.
- [ ] 2.17 [VERIFY] `pnpm build && pnpm lint && pnpm test` (full workspace) and `cd crates && cargo test` — confirm no cross-package regression (no Rust/compiler files touched, sanity gate per project convention).
- [ ] 2.18 [COMMIT] Direct commit to a branch based on Slice 1's branch: `feat(migrator,cli): enforce migration checksum drift`. Requires Slice 1 already merged/present on its branch. Confirm the diff against Slice 1's branch shows only Slice 2 changes (no Slice 1 changes re-appearing).

## Post-slice cleanup

- [ ] 3.1 Confirm the proposal's Success Criteria checklist items are all demonstrably met by the two slices' test suites (drift refusal messages name the id; deploy refuses before applying; status distinguishes applied/modified; legacy table upgrades without data loss; `migrate-runner.ts` has direct coverage for the first time).
