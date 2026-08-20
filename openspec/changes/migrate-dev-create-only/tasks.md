# Tasks: `migrate dev --create-only` (Plan/Apply Separation)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~170 total (~18 src + ~150 test) |
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
| 1 | `--create-only` flag on `migrate dev`: full pre-flight unchanged, early return after `writeFileSync` skips apply/history/commit/snapshot, distinct output message | Single PR | `node packages/cli/test/migrate-runner.mjs` | Existing PGlite harness (`packages/cli/test/migrate-harness.mjs`: `createMigrationClient`, `spyMigrationClient`, `createMigrationsRoot`) — no harness changes needed | Remove `.option("--create-only", …)` from `index.ts`, remove `DevOptions.createOnly` and the `if (options.createOnly)` early-return block from `migrate-runner.ts`, delete the 6 new test cases — `migrateDev` returns to today's atomic behavior exactly |

## Slice — `--create-only` Flag + Early Return (single PR)

Satisfies (spec): `migration-plan-apply-separation` — "MUST accept a `--create-only` boolean option … threaded as `DevOptions.createOnly`", "MUST connect … run `ensureHistory` … `resolvePrevSchema` … `planMigration` … apply the existing diagnostics-refusal and destructive-statement `--force` gate exactly as it does without the flag", "MUST write `migrations/<ts>_<name>/migration.sql` to disk and MUST NOT apply the SQL … MUST NOT insert a row into `_indigo_migrations` … MUST NOT commit a transaction … MUST NOT save `.snapshot.json`", "MUST be byte-identical to one produced by a normal run", "Without `--create-only`, `migrate dev` MUST continue to write, apply, record history, commit, and save the snapshot in one atomic run", "MUST NOT be treated as an offline or no-database mode".

Design ref: Engram #676 — seam is the early `return` inserted between `migrate-runner.ts:363` (`writeFileSync`) and `:365` (commit-phase `try`); `DevOptions.createOnly?: boolean` next to existing `force?: boolean` (line 245); CLI option on `migrate dev` (`index.ts:147-158`), threaded as `createOnly: options.createOnly`.

- [x] 1.1 [RED] `packages/cli/test/migrate-runner.mjs`: new section "`migrate dev --create-only`" with case "writes the migration file, database untouched" — run `migrateDev({ ..., createOnly: true })` against a PGlite-backed `createMigrationClient` harness with a pending non-destructive change; assert `migrations/<id>/migration.sql` exists on disk (via `createMigrationsRoot`'s `readdirSync`), `historyRows(db)` (or equivalent existing history-row helper) is empty, and no `.snapshot.json` exists in the migrations root. Run `node packages/cli/test/migrate-runner.mjs` and confirm it fails to compile/run (`createOnly` not yet a recognized `DevOptions` field / no behavioral difference from today).
- [x] 1.2 [RED] `packages/cli/test/migrate-runner.mjs`: add case "distinct success message" — `captureLogs` around the same `createOnly: true` run; assert the captured output contains a line matching `/created \(not applied\)/` and no line matching `/created and applied/`. Confirm it fails (today's code always prints "created and applied").
- [x] 1.3 [RED] `packages/cli/test/migrate-runner.mjs`: add case "no commit-phase SQL" — wrap the client with `spyMigrationClient` (already exported by the harness, added for `migrate-deploy-advisory-lock`), run `migrateDev({ ..., createOnly: true })`, assert the recorded query list contains zero `BEGIN`/`COMMIT` and zero `INSERT INTO "_indigo_migrations"` queries (`ensureHistory`'s own DDL queries are permitted and NOT asserted against). Confirm it fails (today's run performs `BEGIN`, `INSERT`, `COMMIT`).
- [x] 1.4 [RED] `packages/cli/test/migrate-runner.mjs`: add case "gates still refuse before any file is written" with two sub-assertions — (a) a plan with diagnostics + `createOnly: true` → `process.exitCode === 1`, no new directory under the migrations root, identical refusal message to the no-flag path; (b) a plan containing a `requires-force` statement + `createOnly: true` WITHOUT `--force` → `process.exitCode === 1`, force-refusal message, no new directory. Confirm both fail only insofar as they must first prove `createOnly` doesn't bypass gating (may already pass trivially pre-GREEN since gating is untouched — still run to lock in the contract before the flag exists).
- [x] 1.5 [RED] `packages/cli/test/migrate-runner.mjs`: add case "`--create-only --force` writes a plan containing requires-force statements" — same destructive plan as 1.4(b) but with `createOnly: true, force: true`; assert the migration file IS written to disk and zero history rows exist (commit phase still skipped). Confirm it fails/is not yet meaningfully distinguished from the plain no-flag path until GREEN.
- [x] 1.6 [RED] `packages/cli/test/migrate-runner.mjs`: add case "hand-off: `migrate status` then `migrate deploy` pick up the file" — run `migrateDev({ ..., createOnly: true })`, then `migrateStatus` against the same cwd/db and assert the migration id is reported pending; then `migrateDeploy` against the same cwd/db and assert it applies successfully, inserting one history row whose `checksum === migrationChecksum(readFileSync(...))` of the on-disk file. Confirm it fails today (no `createOnly` field exists to isolate the "not yet applied" state from the default atomic path).
- [x] 1.7 [GREEN] `packages/cli/src/migrate-runner.ts`: add `createOnly?: boolean` to `DevOptions` (after `force?: boolean`, line 245) with a doc comment: "Plan/apply separation: runs the full pre-flight (connect, ensureHistory, prev resolution, plan, every refusal gate) and writes migration.sql, then skips apply, the history INSERT, COMMIT and saveSnapshot. Still requires a live connection — shadow replay reads `_indigo_migrations`."
- [x] 1.8 [GREEN] `packages/cli/src/migrate-runner.ts`: insert an `if (options.createOnly) { ... return; }` block between the `writeFileSync` call (line 363) and the commit-phase `try` (line 365) that prints the distinct 3-line message (`✅ Migration created (not applied): <id>`, `   <n> statement(s) → migrations/<id>/migration.sql`, `   Apply it with \`indigodb migrate dev\` or \`indigodb migrate deploy\`.`) and returns before the commit-phase `try` runs. The existing `finally { client.end() }` at 382-384 remains unchanged and covers this early return.
- [x] 1.9 [GREEN] `packages/cli/src/migrate-runner.ts`: update the module header comment (or the `migrateDev` doc comment at line 311) with one sentence noting `migrateDev` supports `--create-only` to split pre-flight (write) from commit (apply/history/snapshot).
- [x] 1.10 [GREEN] `packages/cli/src/index.ts`: add `.option("--create-only", "Write the migration file without applying it")` to the `migrate dev` command (after the existing `--force` option, line 152); widen the action's inline options type to `{ name: string; schema: string; force?: boolean; createOnly?: boolean }`; thread `createOnly: options.createOnly` into the `migrateDev({ ... })` call (line 157).
- [x] 1.11 [GREEN] Run `node packages/cli/test/migrate-runner.mjs` — confirm 1.1-1.6 now pass, plus all pre-existing cases (checksum staleness, advisory lock, destructive classification, shadow-replay) still pass unchanged.
- [x] 1.12 [GREEN] `packages/cli/test/migrate-runner.mjs`: add case "default `migrate dev` unchanged" — plain `migrateDev` (no `createOnly`) against a pending non-destructive change asserts the file is written, applied, one history row with checksum + `success: true`, `.snapshot.json` present, and `created and applied` logged — regression guard proving the default path is byte-identical to pre-change behavior.
- [x] 1.13 [VERIFY] `pnpm --filter @indigodb/cli build && pnpm --filter @indigodb/cli lint && pnpm --filter @indigodb/cli test` green.
- [x] 1.14 [VERIFY] `pnpm build && pnpm lint && pnpm test` (full workspace) and `cd crates && cargo test` — confirm no cross-package regression (no Rust/compiler files touched, sanity gate per project convention).
- [x] 1.15 [COMMIT] Commit: `feat(cli): add --create-only flag to migrate dev`.

## Post-slice cleanup

- [x] 2.1 Confirm the proposal's Success Criteria checklist items are all demonstrably met by this slice's tests (`--create-only -n x` writes the file and applies nothing; no `_indigo_migrations` row, `.snapshot.json` untouched; `migrate status` reports pending and `migrate deploy` applies it; diagnostics and destructive-without-`--force` still refuse before any file is written; plain `migrate dev` byte-identical to today; `pnpm build`, `lint`, `test` and `cd crates && cargo test` all green).
