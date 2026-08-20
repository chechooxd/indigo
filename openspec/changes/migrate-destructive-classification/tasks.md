# Tasks: Destructive-Statement Classification and `--force` Gating

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~450 authored total (Slice A ~250, Slice B ~200); excludes the 32-fixture generated golden diff |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Slice A (migrator: types/tagging/marker/goldens) -> Slice B (cli: --force, both gates, targets Slice A branch) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `MigrationRisk` union, `safe()`/`forced()` builders, ~30 emit-site tags, `.sql` marker, `scanRequiresForce`, zero CLI behavior change | PR 1 (base: feature/migration-checksum-staleness) | `node packages/migrator/test/migrator.mjs` | N/A — plan/render is a pure function over the resolved schema, no database involved | Revert `plan.ts`/`migrate.ts`/`index.ts` + regenerated goldens; no consumer references `risk` yet |
| 2 | `--force` on `migrate dev`/`migrate deploy`, `DeployOptions`, dev+deploy refusal gates, runner suite | PR 2 (base: PR 1 branch) | `node packages/cli/test/migrate-runner.mjs` | PGlite via existing `packages/cli/test/migrate-harness.mjs` | Revert `--force` options + both gates in `migrate-runner.ts`/`index.ts`; Slice A's tagging stays intact and inert |

## Slice A — migrator (PR 1, base: feature/migration-checksum-staleness)

Satisfies (spec): "Every generated migration statement is classified safe or requires-force at generation time" (all taxonomy scenarios), "Purely additive statements are classified safe", no-SQL-reparsing constraint.

- [x] A.1 [RED] Create 4 fixtures `packages/migrator/test/fixtures/{drop-table,drop-column,column-type-narrowed,set-not-null}/` exercising each requires-force taxonomy edge.
- [x] A.2 [RED] `packages/migrator/test/migrator.mjs`: import not-yet-exported `MigrationRisk`/`scanRequiresForce`/`REQUIRES_FORCE_MARKER`; add checks 1-6 (drop-table, drop-column, column-type-narrowed, set-not-null-requires-force-vs-drop-not-null-safe, pk-change DROP CONSTRAINT requires-force/ADD PRIMARY KEY safe, fk-actions-changed DROP CONSTRAINT requires-force/ADD CONSTRAINT safe). Run `node packages/migrator/test/migrator.mjs` — confirm failure (missing export).
- [x] A.3 [RED] `migrator.mjs`: add checks 7-8 — every statement in optional-column-added/enum-add-value/index-* fixtures is `safe`; `renderMigrationSql` output has the marker line directly above each requires-force statement and nowhere else.
- [x] A.4 [RED] `migrator.mjs`: add checks 9-10 — `scanRequiresForce` round-trips rendered impacts in file order; a legacy file with no marker returns `[]`.
- [x] A.5 [RED] `migrator.mjs`: add check 11 — the not-null-no-default fixture still produces zero statements plus the `required-column-without-default` diagnostic (guards the design's unreachable-scenario finding — no requires-force tag site is added for this case).
- [x] A.6 [GREEN] `packages/migrator/src/plan.ts`: add `MigrationRisk`, discriminated `MigrationStatement` union (`risk: "safe"` vs `risk: "requires-force", impact: string`), `REQUIRES_FORCE_MARKER`, `scanRequiresForce(sql): string[]`.
- [x] A.7 [GREEN] `packages/migrator/src/migrate.ts`: add `safe()`/`forced()` builders; change `createTable`, `tableConstraintsNoFk`, `alterColumn`, `diffTable`, `diffTableFks` return types to `MigrationStatement[]`; collapse `push(stmts, sqls, phase)` sites to `stmts.push(...list)`.
- [x] A.8 [GREEN] `migrate.ts`: tag the ~30 emit sites per the design taxonomy — requires-force: `dropForeignKey`/`diffTableFks` drops, `diffTable` DROP COLUMN, `diffTable` PK drop, `alterColumn` TYPE...USING, `alterColumn` SET NOT NULL (split the nullability ternary so DROP NOT NULL stays safe), dropped-table DROP TABLE. Safe: createEnum/ADD VALUE/RENAME VALUE, notify fn, createTable/tableConstraintsNoFk/createIndex/createUniqueColIndex, addForeignKey, RENAME COLUMN/CONSTRAINT/INDEX, ADD PRIMARY KEY, SET/DROP DEFAULT, DROP NOT NULL, create/drop trigger, every DROP INDEX, DROP TYPE.
- [x] A.9 [GREEN] `migrate.ts`: strip newlines/CR from `impact` before building the marker line; wire `renderMigrationSql` to emit `-- indigo:requires-force <impact>` directly above each requires-force statement.
- [x] A.10 [GREEN] `packages/migrator/src/index.ts`: export `MigrationRisk`, `scanRequiresForce`, `REQUIRES_FORCE_MARKER`.
- [x] A.11 [GENERATED] Regenerate all 32 golden fixtures: `node packages/migrator/test/regen-goldens.mjs`. Mechanical byte regen, not hand-authored — same treatment as the compiler's snapshot regen in CLAUDE.md: review the diff (new `risk`/`impact` keys, marker lines in `migrationSql`), do not hand-edit `expected.json`, and exclude this diff from the authored-line budget.
- [x] A.12 [VERIFY] Run `node packages/migrator/test/migrator.mjs` — confirm checks 1-11 pass and no other golden regressed.
- [x] A.13 [VERIFY] `pnpm --filter @indigodb/migrator build && pnpm --filter @indigodb/migrator lint && pnpm --filter @indigodb/migrator test`; confirm `packages/cli` untouched this slice.
- [x] A.14 [COMMIT] Direct commit to `feature/migration-checksum-staleness`: `feat(migrator): classify migration statements safe vs requires-force`.

## Slice B — cli (PR 2, base: Slice A's commit on feature/migration-checksum-staleness)

Satisfies (spec): dev+deploy symmetric refusal, `--force` applies the full plan unchanged, safe-only plan unaffected, no partial-force/no env-var bypass.

- [ ] B.1 [RED] `packages/cli/test/migrate-runner.mjs`: add case 1 — `migrateDev` refuses a DROP COLUMN plan without `--force`: exitCode 1, no `migrations/<id>/` dir created, zero history rows. Run suite — confirm failure (no `force` option/gate exists).
- [ ] B.2 [RED] `migrate-runner.mjs`: add case 2 — `migrateDev --force` applies the same plan.
- [ ] B.3 [RED] `migrate-runner.mjs`: add case 3 — refusal message lists every offending statement (two impacts, both bulleted, `❌ migrate dev refused: ...` / `   • <impact>` shape).
- [ ] B.4 [RED] `migrate-runner.mjs`: add case 4 — `migrateDeploy` refuses a pending file carrying the marker without `--force`.
- [ ] B.5 [RED] `migrate-runner.mjs`: add case 5 — `migrateDeploy` refuses the whole run when a LATER pending file is destructive; the earlier safe file is NOT applied.
- [ ] B.6 [RED] `migrate-runner.mjs`: add case 6 — `migrateDeploy --force` applies marker-carrying files.
- [ ] B.7 [RED] `migrate-runner.mjs`: add case 7 — `migrateDeploy` applies a legacy (unmarked) file without `--force` — backward compat.
- [ ] B.8 [RED] `migrate-runner.mjs`: add case 8 — a safe-only plan applies under both commands without `--force`, no gating output.
- [ ] B.9 [RED] `migrate-runner.mjs`: add case 9 — `migrateStatus` never gates and never sets `exitCode` on a destructive pending file.
- [ ] B.10 [GREEN] `packages/cli/src/migrate-runner.ts`: add `force?: boolean` to `DevOptions`; add `DeployOptions extends RunnerSeams { force?: boolean }`, threaded through `migrateDeploy`.
- [ ] B.11 [GREEN] `migrate-runner.ts`: in `migrateDev`, scan `plan.statements` for `risk === "requires-force"` and refuse (`exitCode = 1`, `❌ migrate dev refused: ...` + bulleted impacts, `return`, never `throw`) BEFORE `mkdirSync`/`writeFileSync`, unless `force`.
- [ ] B.12 [GREEN] `migrate-runner.ts`: in `migrateDeploy`, after `checksumPreflight` and before the apply loop, run `scanRequiresForce` over every pending file's on-disk SQL, aggregate impacts across all pending files, refuse the whole run (`exitCode = 1`, same message shape, `return`) unless `force`. Confirm gate order: lock -> `ensureHistory` -> `checksumPreflight` -> force gate -> apply loop.
- [ ] B.13 [GREEN] `packages/cli/src/index.ts`: add `--force` to `migrate dev` (~150-157) and `migrate deploy` (~158-166), threaded into the runner calls.
- [ ] B.14 [VERIFY] Run `node packages/cli/test/migrate-runner.mjs` — confirm cases 1-9 pass and the pre-existing checksum/advisory-lock suite is unaffected.
- [ ] B.15 [VERIFY] `pnpm --filter @indigodb/cli build && pnpm --filter @indigodb/cli lint && pnpm --filter @indigodb/cli test`.
- [ ] B.16 [VERIFY] `pnpm build && pnpm lint && pnpm test` (root) and `cd crates && cargo test` — no Rust/compiler files touched, sanity gate per project convention.
- [ ] B.17 [COMMIT] Commit to a branch based on Slice A's commit: `feat(cli): gate destructive migrations behind --force`.

## Post-slice cleanup

- [ ] C.1 Confirm the proposal's Success Criteria are demonstrably met by the two slices' suites: DROP COLUMN refuses under both commands without `--force` (exit 1, nothing applied); refusal names offending statements; `--force` applies the plan unchanged; a purely additive plan is unaffected; type narrowing and SET NOT NULL-without-default tag `requires-force`; `pnpm build`/`lint`/`test` and `cargo test` stay green.
