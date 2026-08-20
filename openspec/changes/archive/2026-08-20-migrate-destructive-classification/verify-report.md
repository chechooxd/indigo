# Verification Report: migrate-destructive-classification

**Branch**: `feature/migration-checksum-staleness` (not on `main`, not pushed)
**Commits**: Slice A `f2a1be8` "feat(migrator): classify migration statements safe vs requires-force", Slice B `9c7632b` "feat(cli): gate destructive migrations behind --force"
**Verified**: 2026-08-20

## Completeness

| Slice | Tasks | Status |
|---|---|---|
| A — migrator | A.1–A.14 (14) | 14/14 `[x]` |
| B — cli | B.1–B.17 (17) | 17/17 `[x]` |
| C — cleanup | C.1 (1) | 1/1 `[x]` |
| **Total** | **32** | **32/32 complete** |

## Build / Lint / Test Evidence (executed live, not trusted from apply-progress)

| Command | Result |
|---|---|
| `pnpm --filter @indigodb/migrator build` | exit 0, clean |
| `pnpm --filter @indigodb/migrator lint` | exit 0, clean |
| `pnpm --filter @indigodb/migrator test` (standalone, not via turbo) | exit 0 — migrator.mjs, native-type, index-ddl, appliability, replay, introspect, shadow, pull-roundtrip all green |
| `pnpm --filter @indigodb/cli build` | exit 0, clean |
| `pnpm --filter @indigodb/cli lint` | exit 0, clean |
| `node packages/cli/test/migrate-runner.mjs` (standalone) | exit 0 — 9 new gating cases + full pre-existing checksum/advisory-lock suite green |
| `pnpm build` (root, 10 packages) | exit 0, FULL TURBO |
| `pnpm lint` (root, 18 tasks) | exit 0, FULL TURBO |
| `pnpm test` (root, turbo) | `@indigodb/compiler#test` FAILS on `13-ambiguous-relations.indigo` `ValidationError[]` — **array ORDER only**, same two diagnostics reordered; confirmed pre-existing, zero relation to this change (`packages/compiler` untouched by either commit). Turbo cascades `ELIFECYCLE` to concurrently-scheduled sibling tasks (migrator/cli/client/studio/generator) it aborts mid-flight — **not real failures**, confirmed by running migrator/cli standalone above, both green. |
| `cd crates && cargo test --locked` | exit 0 — 36 unit + 1 panic-fuzz + doctests, all pass |

## Spec Compliance Matrix (`migration-destructive-gating`, 5 requirements / 14 scenarios)

| # | Requirement / Scenario | Evidence | Status |
|---|---|---|---|
| 1 | DROP TABLE → requires-force | `migrator.mjs`: "drop-table: DROP TABLE tagged requires-force" | PASS |
| 1 | DROP COLUMN → requires-force | `migrator.mjs`: "drop-column: DROP COLUMN tagged requires-force" | PASS |
| 1 | DROP CONSTRAINT → requires-force | `migrator.mjs`: "fk-actions-changed", "pk-change" checks | PASS |
| 1 | Type-narrowing ALTER → requires-force | `migrator.mjs`: "column-type-narrowed: ALTER COLUMN TYPE tagged requires-force" | PASS |
| 1 | ADD COLUMN NOT NULL w/o default → requires-force | Satisfied by the STRONGER pre-existing `required-column-without-default` diagnostic refusal (zero statements emitted, generation blocked) — design's documented finding that this path is unreachable by the tagging mechanism itself. `migrator.mjs` check 11 asserts the diagnostic still fires. | PASS (via stronger guarantee, not a tag) |
| 1 | Purely additive → safe | `migrator.mjs`: "every statement in purely-additive fixtures is safe" | PASS |
| 2 | `migrate dev` refuses DROP COLUMN w/o `--force` | `migrate-runner.mjs`: "migrateDev refuses a destructive plan without --force" (exitCode 1, no dir written) | PASS |
| 2 | `migrate deploy` refuses DROP TABLE w/o `--force` | `migrate-runner.mjs`: "migrateDeploy refuses a pending file carrying the marker without --force" — test fixture uses DROP COLUMN, not a literal DROP TABLE, through the deploy path. Mechanism (`scanRequiresForce`) is content-agnostic and DROP TABLE tagging is independently verified in migrator.mjs, so functional risk is low. | PASS (mechanism verified; scenario's specific statement kind not literally exercised through deploy) |
| 2 | Refusal lists every offending statement | `migrate-runner.mjs`: "migrateDev refusal message lists every offending statement, bulleted" (2 impacts) | PASS |
| 3 | `--force` applies requires-force statements | `migrate-runner.mjs`: "migrateDev --force applies a destructive plan", "migrateDeploy --force applies marker-carrying files" | PASS |
| 3 | `--force` on safe-only plan is a no-op | Not explicitly tested with `force: true` on a safe-only plan. Provable by code structure: the gate is `destructive.length > 0 && !force` (`migrate-runner.ts:350`, `:428`) — for a safe-only plan `destructive.length === 0`, so `force` never enters the branch. | PASS (by code inspection; no dedicated positive test) |
| 4 | Safe-only plan applies w/o `--force` | `migrate-runner.mjs`: "a safe-only plan applies under both commands without --force, no gating output" | PASS |
| 5 | No partial-force | No per-statement override path exists in the code (`--force` is one boolean gating the whole plan/run). No dedicated negative test. | PASS (by code inspection) |
| 5 | No env-var bypass | `grep` across `packages/cli/src`, `packages/migrator/src` for FORCE/bypass/skip-force finds only `REQUIRES_FORCE_MARKER` (unrelated) and `INDIGODB_MIGRATE_PREV` (prev-schema resolution seam, not a refusal bypass). No dedicated negative test. | PASS (by code inspection) |

## Correctness — Data Flow Trace (design decisions vs. live code)

- `MigrationRisk`, discriminated `MigrationStatement` union, `REQUIRES_FORCE_MARKER`, `scanRequiresForce` all present in `plan.ts:29,39-41,143,154-162` exactly as designed.
- `safe()`/`forced()` builders in `migrate.ts:56-69`; `stripNewlines` strips CR/LF before the impact enters the marker line (`migrate.ts:51-53`).
- Confirmed `migrateDeploy` never calls `planMigration` — it reads on-disk `migration.sql` and calls `scanRequiresForce(sql)` per pending file (`migrate-runner.ts:423-426`), aggregating impacts across ALL pending files before refusing the whole run (`:420-437`), matching the design's "pre-scan all, refuse whole run" decision (a per-file gate would half-migrate the DB).
- `renderMigrationSql` (`migrate.ts:944-951`) writes `${REQUIRES_FORCE_MARKER}${stmt.impact}\n${stmt.sql}` directly above each requires-force statement — the marker is the only carrier that reaches deploy, confirmed live in code, not narrative.
- Gate ordering in `migrateDeploy`: lock → `ensureHistory` → `checksumPreflight` → force gate → apply loop (`migrate-runner.ts:394-439`), matching design exactly.
- Gate placement in `migrateDev`: force gate at `:346-357`, strictly before `mkdirSync`/`writeFileSync` at `:359-363` — an unapplied file never lands on disk.

## Symmetric Gating / Message Shape

Both `migrateDev` (`:351`) and `migrateDeploy` (`:431`) call the SAME `printForceRefusal(header, impacts)` helper (`migrate-runner.ts:263-267`) — byte-identical shape by construction: `❌ <header>`, `   • <impact>` per bullet, `   Re-run with --force to apply them.` Only the `header` string differs (command name + subject).

## Refusal Shape

Both gates use `process.exitCode = 1; return;` (`:355-356`, `:435-436`) — confirmed literally in code, no `throw` anywhere in either gate. This avoids `migrateDeploy`'s catch-block "Deploy failed, rolled back" mislabel, as the design specifies.

## No Override Beyond `--force`

`grep -n "FORCE|bypass|--yes|skip-force|no-force"` across `packages/cli/src` and `packages/migrator/src` returns only `REQUIRES_FORCE_MARKER` (the file annotation, unrelated to bypass) and `--force` itself. No environment variable or secondary flag exists.

## `migrate status` Never Gates

`migrateStatus` (`migrate-runner.ts:470-491`) only reads/reports (`⚠ modified` / `✓ applied` / `· pending`) and never sets `process.exitCode`. Test: "migrateStatus never gates and never sets exitCode on a destructive pending file" — PASS. Apply-progress notes a PGlite/Node environmental quirk (async `exitCode` normalization after 20+ instance cycles) was correctly worked around by asserting `!== 1` rather than `=== undefined`, which is the behaviorally meaningful assertion.

## Golden Fixture Spot-Check

36 fixture directories total (32 pre-existing + 4 new: `drop-table`, `drop-column`, `column-type-narrowed`, `set-not-null`). Spot-checked `drop-table`, `set-not-null`, `column-type-narrowed`, `not-null-no-default`, `index-name-changed`, `fk-actions-changed` — all render sane, non-corrupted, non-truncated JSON with correct `risk`/`impact` tagging and marker placement in `migrationSql`. `not-null-no-default` confirms zero statements + `required-column-without-default` diagnostic (design's unreachable-scenario claim holds).

## Design Coherence

All architecture decisions (Q1 discriminated union, Q1b emit-site builder enforcement, Q2 `.sql` marker as deploy's only gate input, Q3 rendered-summary refusal message, deploy pre-scan-all gating, gate ordering, dev gate placement before file write, separate `DeployOptions`) are implemented exactly as documented in design #667 — no deviations found.

## TDD Compliance Note (Strict TDD Mode active)

`tasks.md` tags every task `[RED]`/`[GREEN]`/`[GENERATED]`/`[VERIFY]`/`[COMMIT]` per this codebase's established convention (matches sibling change `migration-checksum-staleness`'s house style) rather than a literal "TDD Cycle Evidence" table. Substantive RED→GREEN evidence is present and cross-verified live: test files exist for every task, and this report independently re-ran them (not trusted from apply-progress narrative) with all green. Treated as a WARNING (format deviation from the strict template), not a CRITICAL, since the underlying evidence is real and independently reproduced.

## Issues

**CRITICAL**: None.

**WARNING** (3):
1. Deploy-path scenario "refuses a plan with a DROP TABLE" is exercised in tests via a DROP COLUMN-marked file, not a literal DROP TABLE, through `migrateDeploy`. The underlying mechanism (`scanRequiresForce`) is statement-content-agnostic and DROP TABLE tagging is independently verified in `migrator.mjs`, so functional risk is low, but the exact spec scenario wording is not literally exercised end-to-end through deploy.
2. "`--force` on a purely safe plan is a no-op" and "no partial-force"/"no env-var bypass" are proven by code inspection (gate structure, grep) rather than a dedicated positive/negative test.
3. TDD evidence in `tasks.md` uses this codebase's own `[RED]`/`[GREEN]`/`[VERIFY]`/`[COMMIT]` tagging convention rather than the strict-tdd-verify.md table template — substance present, format differs.

**SUGGESTION** (1):
1. Consider adding one more `migrate-runner.mjs` case that scans a literal DROP TABLE-marked file through `migrateDeploy`'s force gate, and one asserting `--force: true` is inert on a safe-only plan, to close the scenario-to-test literalness gap noted above.

## Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 3 WARNING, 1 SUGGESTION. Implementation matches spec and design; all 32 tasks complete; all applicable test suites green; the one root `pnpm test` failure is the confirmed pre-existing, unrelated `@indigodb/compiler` ordering flake. Warnings are coverage-literalness and documentation-format observations, not functional defects. Safe to proceed to archive.
