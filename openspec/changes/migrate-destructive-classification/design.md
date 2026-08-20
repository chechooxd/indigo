# Design: Destructive-Statement Classification and `--force` Gating

Verified live on `feature/migration-checksum-staleness`: `MigrationStatement` = `{ sql, phase }`
(`plan.ts:23-26`); the diff entry point is `planMigration` (`migrate.ts:858`) — **not** `diffResolved`,
which CLAUDE.md still names (stale doc, out of scope). `migrateDev` at `migrate-runner.ts:288`,
`migrateDeploy` at `351`, advisory lock `357-363`, `checksumPreflight` call `367`, pending loop `382`.
`RunnerSeams` at `76`, `DevOptions` at `237`.

## Technical Approach

Tag at emit, gate at apply. The load-bearing discovery: **`migrateDeploy` never calls
`planMigration`** — it reads on-disk `migration.sql` (line 383) and executes it. So deploy-side
gating cannot read an in-memory tag, and the spec forbids re-parsing SQL. Therefore the `.sql`
annotation is **not cosmetic — it is the only carrier that reaches deploy**, and it answers Q2
by necessity, not taste. One marker string serves three jobs: file annotation, deploy's gate
input, and the refusal message's payload — so dev and deploy print byte-identical impact lines.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| Q1 | Field shape | Discriminated union on `risk`, with `impact` present **iff** `requires-force` | `risk?:` optional; `kind` enum; flat `impact?` | The union makes "forced without a human-readable impact" unrepresentable. Optional-with-default is exactly the hole the proposal's top risk names |
| Q1b | Emit-site enforcement | Internal helpers return `MigrationStatement[]`, built via `safe()`/`forced()` | keep `string[]`, tag in `push()` | `diffTable` returns a **mixed-risk** array (renames + adds + drops + PK drop), so no per-array uniform risk exists. Returning statements makes `stmts.push("…")` a type error — a future emit site cannot default to safe |
| Q2 | `.sql` annotation | **Yes** — `-- indigo:requires-force <impact>` line directly above the statement | in-memory only | Deploy has no plan. Also mirrors the existing `-- indigo:begin no-transaction` precedent, and unmarked legacy files scan to `[]` — same load-bearing backward-compat property `splitMigrationSql` documents |
| Q3 | Refusal message | **Rendered summary** (`DROP COLUMN users.email`), not raw SQL | raw SQL text | The marker payload already sits one line above the DDL in the file; repeating the SQL doubles the comment. A summary is also what deploy can reconstruct from disk without a parser |
| — | Deploy gate granularity | Pre-scan **all** pending files; refuse the whole run before applying any | per-file gate inside the loop | A per-file gate applies file 1, then exits 1 on file 2 — a half-migrated database. Whole-run refusal keeps "applies nothing" true |
| — | Gate ordering (deploy) | lock → `ensureHistory` → `checksumPreflight` → **force gate** → apply loop | before the preflight | Integrity before intent: refusing for drift is more actionable than refusing for force on a file that is already untrustworthy. `return` inside `try` still hits `finally`'s unlock |
| — | Gate placement (dev) | Refuse **before** `mkdirSync`/`writeFileSync` (between `320` and `322`) | write then refuse | An unapplied file left on disk becomes "pending" on the next run. Matches the existing `rmSync(dir)` cleanup philosophy |
| — | Deploy options param | New `DeployOptions extends RunnerSeams { force?: boolean }` | add `force` to `RunnerSeams` | `RunnerSeams` is documented as *test injection* and is shared with `migrateStatus`, which has no force. Existing call sites/tests keep compiling |

## Classification Taxonomy → Exact Call Sites

| Risk | Site (`migrate.ts`) | Impact template |
|---|---|---|
| requires-force | `dropForeignKey` (362) via `diffTableFks` drops (526) | `DROP CONSTRAINT <table>.<constraint>` |
| requires-force | `diffTable` DROP COLUMN (591) | `DROP COLUMN <table>.<column>` |
| requires-force | `diffTable` PK drop (620) | `DROP PRIMARY KEY <table> (<table>_pkey)` |
| requires-force | `alterColumn` TYPE…USING (394-398) | `ALTER COLUMN TYPE <table>.<column> (<prev> → <next>)` |
| requires-force | `alterColumn` nullability (399-401) — **`SET NOT NULL` branch only**; the ternary must split | `SET NOT NULL <table>.<column>` |
| requires-force | dropped tables (841) | `DROP TABLE <table>` |
| safe | `createEnum`, `ADD VALUE`, `RENAME VALUE`, `renderNotifyFunction`, `createTable`/`tableConstraintsNoFk`/`createIndex`/`createUniqueColIndex`, `addForeignKey`, RENAME COLUMN/CONSTRAINT/INDEX, `ADD PRIMARY KEY`, `SET`/`DROP DEFAULT`, `DROP NOT NULL`, `renderCreateTrigger`/`renderDropTrigger` | — |
| safe (edge) | every `DROP INDEX` (604, 643, 683, 694) | Drops no row data; a unique-index drop only relaxes a constraint |
| safe (edge) | `DROP TYPE` (846) | PostgreSQL refuses it while anything references the type, so it is fail-safe; any real loss already happened via a co-emitted `DROP TABLE`/`DROP COLUMN`/type-change ALTER |

**Spec scenario "ADD COLUMN NOT NULL without default" is already unreachable**: `diffTable:582-585`
pushes a `required-column-without-default` diagnostic and `continue`s — no statement is emitted.
The only case that passes that guard is `autoincrement` (serial), which backfills. That scenario is
therefore satisfied by a *stronger* existing guarantee (generation refusal); verify must assert the
diagnostic path, **not** a `requires-force` tag. Do not add a tag site for it.

## Interfaces / Contracts

```ts
// plan.ts
export type MigrationRisk = "safe" | "requires-force";

export type MigrationStatement =
  | { sql: string; phase: MigrationPhase; risk: "safe" }
  | { sql: string; phase: MigrationPhase; risk: "requires-force"; impact: string };

/** Prefix of the line `renderMigrationSql` writes above each requires-force statement. */
export const REQUIRES_FORCE_MARKER = "-- indigo:requires-force ";

/**
 * Impacts, in file order, of every requires-force statement in a rendered
 * migration file. A file with no marker returns `[]` — LOAD-BEARING: migrations
 * written before this existed are ungated, exactly as they were.
 */
export function scanRequiresForce(sql: string): string[];
```

```ts
// migrate.ts — internal builders; `stmts.push("…")` stops compiling
const safe   = (sql: string, phase: MigrationPhase = "transaction"): MigrationStatement => ({ sql, phase, risk: "safe" });
const forced = (sql: string, impact: string): MigrationStatement => ({ sql, phase: "transaction", risk: "requires-force", impact });
```

`impact` MUST have newlines/CR stripped before entering the marker line (a `@map("…")` value is a
string literal and is otherwise trusted, but a comment line must not be breakable).

`createTable`, `tableConstraintsNoFk`, `alterColumn`, `diffTable`, `diffTableFks` change return type
`string[]` → `MigrationStatement[]`; `push(stmts, sqls, phase)` collapses to `stmts.push(...list)`.
`splitMigrationSql` is **unchanged**: requires-force statements are never pre-transaction (only
`ADD VALUE` is), so a marker line never lands inside a `no-transaction` block.

## Data Flow

    planMigration ──→ statements[{sql, phase, risk, impact?}]
        ├─ migrateDev ── in-memory scan (risk === "requires-force")
        │                   └─ !force → refuse (exitCode 1, NO file written, nothing applied)
        └─ renderMigrationSql ── "-- indigo:requires-force <impact>" above each
                                        │
                                    migration.sql on disk
                                        │
                              migrateDeploy ── scanRequiresForce(file) over ALL pending
                                        └─ !force → refuse whole run before applying any

## Refusal Message (Q3, concrete)

```
❌ migrate dev refused: this migration contains 2 destructive statement(s).
   • DROP COLUMN users.email
   • ALTER COLUMN TYPE users.age (Int → String)
   Re-run with --force to apply them.
```

```
❌ migrate deploy refused: 20260820120000_drop_email contains 1 destructive statement(s).
   • DROP COLUMN users.email
   Re-run with --force to apply them.
```

Reuses the `❌ … refused:` + `   • ` bullet shape already at `migrate-runner.ts:311-312, 359, 369`.
`process.exitCode = 1`, `return` — never `throw` (a throw in deploy hits the catch at 394 and gets
mislabelled "Deploy failed, rolled back", the exact trap `checksumPreflight` avoids).

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/migrator/src/plan.ts` | Modify | `MigrationRisk`, union `MigrationStatement`, `REQUIRES_FORCE_MARKER`, `scanRequiresForce` (~45 ln) |
| `packages/migrator/src/migrate.ts` | Modify | `safe`/`forced` builders; helper return types; ~30 emit sites wrapped; nullability ternary split; impact strings; `renderMigrationSql` marker (~110 ln) |
| `packages/migrator/src/index.ts` | Modify | export `MigrationRisk`, `scanRequiresForce`, `REQUIRES_FORCE_MARKER` (~3 ln) |
| `packages/cli/src/migrate-runner.ts` | Modify | `DeployOptions`; `force` on `DevOptions`; both gates; header comment (~40 ln) |
| `packages/cli/src/index.ts` | Modify | `--force` on `migrate dev` (150-157) and `migrate deploy` (158-166) (~10 ln) |
| `packages/migrator/test/fixtures/{drop-table,drop-column,column-type-narrowed,set-not-null}/` | Create | 4 fixtures (`prev.indigo` + `next.indigo` + golden) |
| `packages/migrator/test/fixtures/*/expected.json` | Regen | All 32 existing goldens gain `risk`; destructive ones gain `impact` + marker in `migrationSql`. `node test/regen-goldens.mjs`; the diff is the review artifact |
| `packages/migrator/test/migrator.mjs` | Modify | explicit per-risk checks beyond the deep-equal (~40 ln) |
| `packages/cli/test/migrate-runner.mjs` | Modify | gating suite (~200 ln) |

## Testing Strategy

**`packages/migrator/test/migrator.mjs`** (golden deep-equal already covers `risk`/`impact`; add named checks):
1. `drop-table: DROP TABLE tagged requires-force with impact "DROP TABLE users"`
2. `drop-column: DROP COLUMN tagged requires-force`
3. `column-type-narrowed: ALTER COLUMN … TYPE tagged requires-force`
4. `set-not-null: SET NOT NULL tagged requires-force, DROP NOT NULL tagged safe`
5. `pk-change: DROP CONSTRAINT …_pkey requires-force, ADD PRIMARY KEY safe`
6. `fk-actions-changed: DROP CONSTRAINT requires-force, ADD CONSTRAINT safe`
7. `optional-column-added / enum-add-value / index-*: every statement safe`
8. `renderMigrationSql: marker line precedes each requires-force statement, and only those`
9. `scanRequiresForce: round-trips rendered impacts in order`
10. `scanRequiresForce: a legacy file with no marker returns []`
11. `not-null-no-default: still a diagnostic, still zero statements` (guards the unreachable-scenario claim)

**`packages/cli/test/migrate-runner.mjs`** (real PGlite via `migrate-harness.mjs`, `captureLogs`-style capture of `console.error`):
1. `migrateDev refuses a DROP COLUMN plan without --force` — exitCode 1, **no** `migrations/<id>/` directory created, zero history rows
2. `migrateDev --force applies the same plan` — column gone, history row written, exitCode unset
3. `migrateDev refusal message lists every offending statement` — two impacts, both bulleted
4. `migrateDeploy refuses a pending file carrying the marker without --force` — exitCode 1, zero rows applied
5. `migrateDeploy refuses the whole run when a LATER pending file is destructive` — the earlier safe file is **not** applied
6. `migrateDeploy --force applies marker-carrying files`
7. `migrateDeploy applies a legacy (unmarked) file without --force` — backward compat
8. `a safe-only plan applies under both commands without --force, with no gating output`
9. `migrateStatus never gates and never sets exitCode on a destructive pending file`

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. `--force` is a Commander boolean. One adjacent concern handled in
`Interfaces`: `impact` is interpolated into a `--` comment line, so newlines are stripped at the
builder; identifiers otherwise come from the resolved schema and never reach `query()` as data.

## Migration / Rollout

No database migration, no history-format change. New migration files gain comment lines (inert to
PostgreSQL, to shadow replay, and to `splitMigrationSql`); checksums stay self-consistent because
each file is hashed as written. Existing on-disk files are untouched → no drift, and they remain
ungated by design. Rollback: drop the two gates and the `--force` options, drop the marker from
`renderMigrationSql`, revert the union to `{ sql, phase }`, regen goldens.

## Slice Plan (delivery_strategy = auto-chain, budget 800)

≈450 authored changed lines (≈200 src, ≈250 test) plus a large **generated** golden diff (32 files,
excluded from authored risk count). Honest comparison: this is ~2.5× `migrate-deploy-advisory-lock`
(~170 lines, single slice) — `migrate.ts` has ~30 emit sites to tag versus that change's 2 query
calls. **Two chained slices, split on the package boundary:**

- **Slice A — migrator** (`plan.ts`, `migrate.ts`, `index.ts`, fixtures, golden regen; ≈250 authored).
  Lands classification + marker with **zero** CLI behavior change; verifiable alone; safe to ship.
- **Slice B — CLI** (`--force`, `DeployOptions`, both gates, runner suite; ≈200 authored).
  Depends on A's exported `scanRequiresForce`.

`Decision needed before apply: No`
`Chained PRs recommended: Yes`
`400-line budget risk: High`

## Open Questions

None. Q1 → discriminated union on `risk` with `impact` (builders make it emit-site-exhaustive);
Q2 → **yes**, annotate — it is deploy's only gate input, not a nicety; Q3 → rendered summary,
shared verbatim between the file marker and both refusal messages.
