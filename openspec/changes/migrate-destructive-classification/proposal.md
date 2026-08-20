# Proposal: Destructive-Statement Classification and `--force` Gating

Change: `migrate-destructive-classification` (Road to 1.0, Phase 3, epic "Introspection — `indigodb db pull`", task 5/8). One focused slice, not the epic.

## Context

Working tree is on `feature/migration-checksum-staleness`, which carries tasks 3/8 and 4/8 (commits through `d969fe8`) and is **neither merged to `main` nor pushed**. This change continues on that same branch. The merge question stays open and is not resolved here.

## Intent

`MigrationStatement` (`packages/migrator/src/plan.ts`) is `{ sql, phase }` — zero risk tagging. `migrateDev`/`migrateDeploy` apply every generated statement unconditionally, so a `DROP TABLE ... CASCADE` from a renamed model destroys data with no acknowledgment step. `migration-safety-guards` only refuses statements provably broken from the diff; statements that *apply cleanly but destroy data* have no gate at all.

## Scope

### In Scope
- A risk tag on `MigrationStatement`, populated at the existing `computeStatements` call sites in `migrate.ts` that already know their semantics — **no SQL re-parsing**.
- **Two categories only: `safe` vs `requires-force`.** No intermediate tier.
  - `requires-force`: `DROP TABLE`, `DROP COLUMN`, `DROP CONSTRAINT`, column type narrowing (`ALTER COLUMN ... TYPE`), `SET NOT NULL` added without a default.
  - `safe`: everything else (CREATE TABLE/TYPE/INDEX, ADD VALUE, ADD COLUMN, ADD CONSTRAINT, renames, realtime triggers).
- `--force` flag on **both** `migrate dev` and `migrate deploy` (`packages/cli/src/index.ts`), threaded into the runner.
- Refusal when a plan contains any `requires-force` statement and `--force` was absent: `process.exitCode = 1`, no apply, message listing exactly which statements triggered it — same shape as `checksumPreflight` and the advisory-lock refusal.
- Tests: kind-tagging correctness (migrator) + spy-based gating behavior (CLI runner).

### Out of Scope
- Task 6/8 plan/apply separation; task 7/8 history/recovery/transaction-boundary control.
- Interactive prompts, `inquirer` or any new dependency; env-var bypass.
- `db push`/`renderPushSql` — confirmed additive-only, never emits destructive DDL.
- Changing which SQL is generated, or `MigrationDiagnostic` semantics.

## Capabilities

### New Capabilities
- `migration-destructive-gating`: statement risk taxonomy, tagging boundary, `--force` semantics, refusal contract, dev/deploy symmetry.

### Modified Capabilities
- None.

## Approach

Tag at generation time, gate at apply time. Exploration confirmed each emitting helper already knows whether it drops or narrows, so classification is a field threaded through existing call sites — cheap, exhaustive, and impossible to drift from the SQL it describes.

**Deliberate departure from precedent:** tasks 3/8 (checksum) and 4/8 (advisory lock) were dev/deploy-asymmetric. This one is **symmetric**. Data loss is not less real on a dev database — arguably more so, since dev databases are casually iterated and rarely backed up. Prisma warns in dev too. Flag-only (no prompt) keeps both paths non-interactive and CI-safe with one mechanism.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/migrator/src/plan.ts` | Modified | risk field on `MigrationStatement` |
| `packages/migrator/src/migrate.ts` | Modified | tag at existing emit sites in `computeStatements` |
| `packages/cli/src/index.ts` | Modified | `--force` on `migrate dev` and `migrate deploy` |
| `packages/cli/src/migrate-runner.ts` | Modified | pre-apply refusal in both runners |
| `packages/migrator/test/`, `packages/cli/test/migrate-runner.mjs` | Modified | new coverage (none exists today) |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Misclassification lets destruction through silently | Med | Exhaustive per-call-site tagging; tests assert every emitting branch |
| Symmetric gating annoys dev iteration loops | Med | Accepted: `--force` is one flag; refusal names exact statements |
| `MigrationStatement` shape change breaks consumers | Low | Additive optional field; `renderMigrationSql` unchanged |
| Scope creep into 6/8 plan/apply separation | Med | Gate only; no plan-file or apply-phase restructuring |

## Rollback Plan

1. Remove the `--force` options and the two refusal blocks — runners return to unconditional apply.
2. Remove the risk field from `MigrationStatement` and its call-site assignments.
3. No schema change, no on-disk migration format change, no persisted state.

## Dependencies

- Builds on `migration-history-integrity` / `migrate-deploy-concurrency` for refusal-message and exit-code convention. Branch merge state unresolved (see Context).

## Success Criteria

- [ ] A plan containing a `DROP COLUMN` refuses under both `migrate dev` and `migrate deploy` without `--force`, applying nothing, exit code 1
- [ ] The refusal message lists the offending statements
- [ ] `--force` applies the same plan unchanged
- [ ] A purely additive plan is unaffected in both commands
- [ ] Type narrowing and `SET NOT NULL`-without-default are tagged `requires-force`
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` stay green

## Open questions for sdd-design (auto mode: no interactive round held; taxonomy and gate mechanism were user-confirmed)

1. Field name/shape: `kind: MigrationStatementKind` vs. `risk: "safe" | "requires-force"`; optional-with-default vs. required.
2. Should `renderMigrationSql` annotate `requires-force` statements with a comment marker in the `.sql` file?
3. Does the refusal list raw SQL, or a rendered summary (table/column names)?
