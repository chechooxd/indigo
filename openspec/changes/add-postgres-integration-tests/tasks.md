# Tasks: PostgreSQL Appliability Tests for the Migrator

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~370-420 authored (appliability.mjs ~220, pg-harness.mjs ~90, new fixture ~15, lib.mjs ~10, package.json ~4, spec delta ~10, RED capture ~notes) |
| 400-line budget review | 800-line budget per orchestrator instruction — Low risk against 800; Medium against generic 400 default |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main (branch stacks on `fix/migrator-diff-completeness-and-guards`) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Full appliability suite (harness + fixture + runner + wiring) | PR 1 (single) | `node packages/migrator/test/appliability.mjs` | PGlite in-process, real (Task 3.3, 4.x, 5.x) | Revert `test/appliability.mjs`, `test/pg-harness.mjs`, `lib.mjs` export, `package.json` scripts/devDep, new fixture dir; golden suite (`test/migrator.mjs`) stays green independently |

## Phase 1: Dependency and Fixture Foundation

- [x] 1.1 Add `@electric-sql/pglite ^0.5.4` devDependency to `packages/migrator/package.json`; run `pnpm install` to update `pnpm-lock.yaml`.
- [x] 1.2 Create fixture `packages/migrator/test/fixtures/enum-add-value-and-use/prev.indigo`: `enum S { A }` + `Table T { id Int @id  s S }`.
- [x] 1.3 Create fixture `packages/migrator/test/fixtures/enum-add-value-and-use/next.indigo`: `enum S { A B }` + `Table T { id Int @id  s S @default(B) }`.
- [x] 1.4 Run `node packages/migrator/test/regen-goldens.mjs` to generate `enum-add-value-and-use/expected.json`; verify it contains the pre-transaction `ALTER TYPE ... ADD VALUE` and transactional `SET DEFAULT` split (per design Decision C/orchestrator correction).
- [x] 1.5 Run `node packages/migrator/test/migrator.mjs` — confirm the new golden fixture passes alongside the existing 20 (21 total).

## Phase 2: Shared Fixture/Harness Refactor

- [x] 2.1 In `packages/migrator/test/lib.mjs`, export `loadFixture(dir)` returning `{prev, next}` (parsed+resolved), extracted from the existing `resolveFixture`-based logic.
- [x] 2.2 Refactor `computeActual(dir)` in `lib.mjs` to call `loadFixture(dir)` internally — no behaviour change; re-run `node packages/migrator/test/migrator.mjs` to confirm all 21 fixtures still pass identically.
- [x] 2.3 Create `packages/migrator/test/pg-harness.mjs` with `withDatabase(fn)`: boots a fresh `new PGlite()`, invokes `fn(db)`, always closes the instance (try/finally).
- [x] 2.4 Add `applyPlan(db, migrationSql)` to `pg-harness.mjs`: derives phases via real `splitMigrationSql(migrationSql)`, executes each pre-transaction statement individually, then wraps the transactional body in `BEGIN`/`COMMIT`; returns executed-statement count.
- [x] 2.5 Add `assertApplies(db, sql)` and `assertRejects(db, sql, pattern)` to `pg-harness.mjs`.
- [x] 2.6 Add a harness self-test helper (`CREATE TABLE "X" ("id" nosuchtype)`) proving the executed-statement counter and error path are real, per design Decision D.

## Phase 3: RED — Historical-Bug Regressions (Strict TDD)

- [x] 3.1 In `packages/migrator/test/appliability.mjs`, write the FK-ordering regression as `assertApplies(db, legacySql)` against hand-constructed pre-fix SQL (FK constraint before its referenced table is created) — sourced from the `fk-order-declaration` fixture's buggy shape.
- [x] 3.2 Run it and capture the RED failure: PGlite must reject with `relation "..." does not exist`. Record the captured output as the verification artifact (paste into PR description / commit message, per Decision F).
- [x] 3.3 Invert 3.1 to `assertRejects(db, legacySql, /does not exist/)` paired with `assertApplies(db, <current fk-order-declaration renderMigrationSql output>)`. Confirm GREEN.
- [x] 3.4 Write the enum-transaction regression as `assertApplies(db, legacySql)` against hand-constructed pre-fix SQL: `ALTER TYPE ... ADD VALUE` + consuming statement inside one `BEGIN`/`COMMIT` (no phase split) — sourced from the new `enum-add-value-and-use` fixture's SQL shape, single-transaction variant.
- [x] 3.5 Run it and capture the RED failure: PGlite must reject with `unsafe use of new value`. Record the captured output.
- [x] 3.6 Invert 3.4 to `assertRejects(db, legacySql, /unsafe use of new value/)` paired with `assertApplies` via `applyPlan(db, renderMigrationSql(plan))` for the real `enum-add-value-and-use` fixture (split phases, real `splitMigrationSql`). Confirm GREEN.

## Phase 4: Fixture Replay Suite

- [x] 4.1 In `appliability.mjs`, iterate all 21 fixtures (`readdirSync(fixturesDir)`); for each, `loadFixture(dir)` then `planMigration(null, prev)` (or skip if `prev` absent) inside `withDatabase`, asserting each statement applies via `assertApplies`.
- [x] 4.2 For the same fixture, `planMigration(prev, next)` → `renderMigrationSql(plan)` → `applyPlan(db, migrationSql)` on the same seeded DB; assert success, reporting fixture name + failing statement on error.
- [x] 4.3 Add the round-trip invariant (all fixtures): `splitMigrationSql(renderMigrationSql(plan)).preTransaction` matches `plan.statements.filter(s => s.phase === "pre-transaction")` in count and text.
- [x] 4.4 For refusal fixtures (`enum-value-removed`, `map-rename-ambiguous`, `not-null-no-default`): assert `diagnostics.length > 0` with a known `MigrationDiagnosticCode`, `statements.length === 0`, `renderMigrationSql(plan) === ""`, and executed-statement counter `=== 0`; still apply `prev` and run the pushSql idempotency check (Task 4.5).
- [x] 4.5 For each of the 21 fixtures, on a second fresh `withDatabase`, run `renderPushSql(next)` twice; assert both executions succeed (idempotency requirement).
- [x] 4.6 Add an explicit fixture-isolation assertion: two fixtures creating same-named objects (e.g. any two using `Table "User"`/similar) do not interfere — confirmed structurally by the fresh-instance-per-fixture design; add one assertion that reuses a common object name across two distinct `withDatabase` calls without cross-contamination.

## Phase 5: Wiring, Scope Statement, Verification

- [x] 5.1 Update `packages/migrator/package.json` scripts: `"test": "node test/migrator.mjs && node test/appliability.mjs"`, `"test:goldens": "node test/migrator.mjs"`, `"test:appliability": "node test/appliability.mjs"`.
- [x] 5.2 Add a banner/log line in `appliability.mjs` stating the "appliability" scope and explicitly excluding concurrency, advisory locking, and connection-pool behaviour (spec requirement: scope statement is honest).
- [x] 5.3 Run `pnpm test --filter=@indigodb/migrator` and confirm both suites pass (21 golden fixtures + appliability suite green).
- [x] 5.4 Run `pnpm test` from repo root; confirm the appliability suite executes as part of the workspace fan-out.
- [ ] 5.5 Update `openspec/specs/migration-golden-tests/spec.md`: narrow the "Golden fixtures pin generated text, not applicability" requirement per spec delta (rename to "...applicability is proven separately", cross-reference `migration-appliability-tests`). Apply during archive per design's stated file-changes table. **Deferred to sdd-archive by design** — the delta already exists at `openspec/changes/add-postgres-integration-tests/specs/migration-golden-tests/spec.md` and is content-consistent with what shipped; archiving promotes it into `openspec/specs/`.

## Deviation from Design (documented, in-scope fix)

A genuine production bug was discovered by the round-trip invariant (Task 4.3), not by the two seeded historical-bug regressions: `splitMigrationSql` (`packages/migrator/src/plan.ts`) failed to recognize a pre-transaction marker block when it was the LAST block in the rendered file — `renderMigrationSql`'s single trailing `"\n"` landed inside that block's final line, so `lines[lines.length-1] === NO_TRANSACTION_END` was `false` and the whole ADD VALUE statement silently fell back to running inside the migration transaction instead of before it. This reproduces for any migration whose ONLY/LAST change is an enum `ADD VALUE` (e.g. the pre-existing `enum-add-value` and `enum-value-mapped` fixtures) — exactly the shape the `migration-appliability-tests` capability exists to catch. It happened to not error for those two fixtures only because nothing in the SAME migration consumed the new value.
Fixed with a minimal, backward-compatible change (marker detection tolerates one trailing blank line; unmarked-block byte-for-byte output is unaffected — both pre-existing `splitMigrationSql` unit tests in `migrator.mjs` still pass unchanged) plus one new dedicated regression unit test. This is a 1-file, ~10-line production fix directly required to make the appliability suite pass without weakening any assertion; per the apply-phase rule "if the design is wrong or incomplete, note it — don't silently deviate," it is called out here rather than hidden. Design's "no production code change" framing predates this discovery.

## Key Learnings Input (for sdd-apply)

- Orchestrator correction: the enum phase-split negative proof MUST use the real `enum-add-value-and-use` fixture (Phase 1), not hand-constructed SQL alone; hand-constructed SQL is retained only for the RED/legacy-bug demonstration (Phase 3.4-3.6), where its single-transaction variant is the load-bearing negative case.
- RED is real only for Phase 3 (historical-bug regressions); Phase 4 fixture replay exercises already-correct code and is expected to go green immediately — do not force artificial RED there.
