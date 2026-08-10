# Tasks: Fix Migrator DDL Correctness

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~950–1,150 (design's ~935 baseline + enum-`dbName` closure: `client.ts` fix, `renderDefault` lookup threading, new `packages/generator/test/` harness) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR2 → PR3, stacked, in order |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High
```

Branch topology (hard constraint, confirmed): PR1 branches from `fix/compiler-schema-validation` (HEAD `f6e3faf`), NOT `main` — that branch is the only place `ForeignKey.onUpdate`/`ResolvedEnum.members` exist. PR2 stacks on PR1's branch, PR3 on PR2's; each merges to `main` in order. PR2 depends on PR1's `MigrationPlan` contract; PR3 depends on PR2's 3a/3b/3c pass structure.

**Per-PR risk note**: PR2 carries FK ordering + referential actions + enum-`dbName` (both renderers) + the scope-added `client.ts`/generator-harness work — closest to the 400-line ceiling. If it exceeds ~430–450 lines during apply, split the enum-`dbName`/generator work into a fourth stacked PR (2b) rather than breaching the ceiling.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|----|----|
| 1 | Golden harness + `MigrationPlan` contract, zero behavior change | PR1 | `pnpm --filter @indigodb/migrator test` | N/A — no PostgreSQL in CI; goldens pin generated SQL/diagnostic text only | Revert `plan.ts`, `migrate.ts` wrapper, `index.ts` export rename, `migrate-runner.ts`, harness+fixtures — no consumer outside `migrator`/`cli` touched |
| 2 | FK ordering (3a/3b/3c), phase split, referential actions, enum `dbName` in both renderers + generated client | PR2 | `pnpm --filter @indigodb/migrator test && pnpm --filter @indigodb/generator test` | N/A — same reason | Revert ordering/phase/`fkDefinition`/enum changes in `migrate.ts`, `postgres.ts`, `client.ts` + their fixtures; PR1 contract stands alone |
| 3 | Diff completeness (`@map` rename, PK change, enum removal) + safety guards | PR3 | `pnpm --filter @indigodb/migrator test` | N/A — same reason | Revert diff-completeness/guard additions in `migrate.ts` + fixtures + release note; PR1/PR2 behavior stands alone |

## Phase 1: Golden Harness + Plan Contract (PR1, no behavior change)

- [ ] 1.1 Branch from `fix/compiler-schema-validation` (HEAD `f6e3faf`), not `main`.
- [ ] 1.2 RED: `packages/migrator/test/migrator.mjs` (mirrors `compiler/test/parity.mjs`: plain Node, `check()`+`deepStrictEqual`) + 5 baseline fixtures (`no-changes`, `fk-order-declaration`, `enum-add-value`, `not-null-with-default`, `optional-column-added`) pinning TODAY's output, including today's buggy FK order.
- [ ] 1.3 GREEN: add `"test": "node test/migrator.mjs"` to `packages/migrator/package.json`; suite passes against current `diffResolved`/`renderMigrationSql`.
- [ ] 1.4 Create `packages/migrator/src/plan.ts`: `MigrationPhase`, `MigrationStatement`, `MigrationDiagnosticCode`, `MigrationDiagnostic`, `MigrationPlan`, `splitMigrationSql(sql)`.
- [ ] 1.5 Replace `diffResolved`/`renderMigrationSql` in `migrate.ts` with `planMigration(prev, next): MigrationPlan` (every statement `phase: "transaction"`, `diagnostics: []`, identical order to today) and `renderMigrationSql(plan)`.
- [ ] 1.6 `index.ts`: export `planMigration`, `renderMigrationSql`, `splitMigrationSql` + the 5 `plan.ts` types; REMOVE `diffResolved`.
- [ ] 1.7 `migrate-runner.ts`: one `planMigration` call (replaces two `diffResolved` calls at `:87`/`:96`); refuse to write when `plan.diagnostics.length > 0`; `migrateDev` runs `splitMigrationSql(sql).preTransaction` one `client.query()` per statement, then `BEGIN`+body+history insert+`COMMIT`; `migrateDeploy` splits on-disk files the same way.
- [ ] 1.8 Update the 5 fixtures' `expected.json` to `{plan, migrationSql, pushSql}`; add `test/regen-goldens.mjs` (explicit regen, mirrors `regen-snapshots.mjs`).
- [ ] 1.9 Gates: `pnpm test`, `pnpm build`, `pnpm lint`, `cd crates && cargo test` — all green.

## Phase 2: Ordering, Phase Split, Referential Actions, Enum `dbName` (PR2)

- [x] 2.1 RED: add fixtures `fk-self-reference`, `fk-cycle`, `fk-to-new-table-from-existing`, `category-order-combined`, `enum-value-mapped`, `fk-actions-emitted`, `fk-actions-changed`, `fk-unchanged`; update `fk-order-declaration`/`enum-add-value` expectations to correct output.
- [x] 2.2 GREEN: `migrate.ts` — split table DDL into 3a (all `DROP CONSTRAINT`) → 3b (per table: `CREATE TABLE`|`RENAME COLUMN`→ADD/DROP/ALTER COLUMN→PK→indexes→trigger) → 3c (all `ADD CONSTRAINT`); remove FK emission from `createTable`/`tableConstraints`. Top-level order (`:214-259`) unchanged; `postgres.ts` untouched (already correct per finding).
- [x] 2.3 GREEN: tag enum `ADD VALUE` `phase: "pre-transaction"`; emit `-- indigo:begin/end no-transaction` markers only when present.
- [x] 2.4 GREEN: add `fkDefinition()` (identity + onDelete/onUpdate); `fkSignature` (`:135`) stays identity-only. A definition-only change on an FK present both sides emits DROP (3a) + ADD (3c) same name; fully unchanged FK emits nothing.
- [x] 2.5 GREEN: emit `ON UPDATE` in `addForeignKey` (`migrate.ts:85`) and `renderForeignKey` (`postgres.ts:131`) from `fk.onUpdate`.
- [x] 2.6 GREEN: add `enumMembers(e) = e.members ?? e.values.map(v => ({name:v, dbName:v}))`; render `CREATE TYPE`/`ADD VALUE` from members' `dbName` in `migrate.ts` (`:50`, `:228`) and `postgres.ts` (`renderEnum`, `:146`/`:225`).
- [x] 2.7 GREEN (scope addition): fix `renderDefault` (`postgres.ts:52-74`) so an enum literal default casts using the member's `dbName`; thread the `enumMembers` lookup from `schema.enums` through `renderColumn`/`renderDefaultClause` call sites in `postgres.ts` (`renderCreateTable`, `renderAddColumns`) and `migrate.ts` (`createTable`, `alterColumn`, `columnSignature`). Confirm `migrate.ts` has no separate default-rendering path (it reuses `renderDefaultClause` — nothing else to fix).
- [x] 2.8 GREEN (scope addition): fix `packages/generator/src/client.ts:61` — emit `${member.name} = "${member.dbName}"` via `enumMembers`.
- [x] 2.9 (scope addition) Add `packages/generator/test/enum-mapping.mjs` (plain Node) + `"test": "node test/enum-mapping.mjs"` in `packages/generator/package.json`: parse+resolve an `@map`'d-enum fixture, run `generateClient`, assert the enum block. First test this package has.
- [x] 2.10 Gates: `pnpm test` (migrator + generator), `pnpm build`, `pnpm lint`, `cd crates && cargo test` — all green.

## Phase 3: Diff Completeness + Safety Guards (PR3)

- [ ] 3.1 RED: add fixtures `enum-value-removed`, `map-rename-only`, `map-rename-ambiguous`, `pk-change`, `not-null-no-default`.
- [ ] 3.2 GREEN: `diffTable` (`:141-206`) matches columns by logical `name` first, physical `dbName` second; residuals matched by neither key feed Rule R.
- [ ] 3.3 GREEN: Rule R — both residual sets non-empty AND at least one member each carries an explicit `@map` → `ambiguous-column-remap` diagnostic (table + every field/@map pair both sides), zero DDL for those columns; otherwise today's DROP+ADD stands.
- [ ] 3.4 GREEN: unambiguous `@map`-only rename emits `RENAME COLUMN` (no DROP/ADD); rewrite prev's physical PK/index/FK column references old→new `dbName` before diffing.
- [ ] 3.5 GREEN: after rename, realign only auto-derived names (`ALTER INDEX ... RENAME TO`, `ALTER TABLE ... RENAME CONSTRAINT`) where `index.name`/`fk.name` is absent. Document limitation: PK drop-recreate assumes PostgreSQL's default `<table>_pkey` name.
- [ ] 3.6 GREEN: PK change emits `DROP CONSTRAINT <table>_pkey` then `ADD PRIMARY KEY (...)`.
- [ ] 3.7 GREEN: enum value removal emits `enum-value-removed` diagnostic (enum + value(s) + manual-migration note), zero DDL for the removal.
- [ ] 3.8 GREEN: NOT NULL guard refuses (`required-column-without-default`, zero DDL) ONLY for a NOT NULL column with no default and not autoincrement added to a table already in `prev`; `createTable` (new tables) unguarded; `@default(...)`/optional columns stay unguarded (regression).
- [ ] 3.9 Diagnostic messages follow compiler parity phrasing (`<what is wrong>. <remedy>.`, double-quoted identifiers).
- [ ] 3.10 Update release note: newly-noisy migrations after upgrade; `migrate dev` refuses to write on any diagnostic; pre-existing `migrations/` files carry no marker, stay fully transactional (`migrate deploy` compatible).
- [ ] 3.11 Gates: `pnpm test`, `pnpm build`, `pnpm lint`, `cd crates && cargo test` — all green.
