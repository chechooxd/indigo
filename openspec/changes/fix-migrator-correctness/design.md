# Design: Fix Migrator DDL Correctness

## Technical Approach

Every defect in this change is a symptom of one structural fact: **`diffResolved` returns
`string[]`**. A flat string array cannot say "this statement must not run inside the
transaction", cannot say "I refuse to emit DDL here, and here is why", and gives the
migration file no structure the runner can act on. So five of the six spec capabilities —
enum transaction phase, enum-value-removal refusal, ambiguous-remap refusal, the `NOT NULL`
guard, and the golden fixture contract — all wait on one decision: **replace the return
type with a `MigrationPlan` value object carrying phase-tagged statements and diagnostics.**

Everything else is contained: the FK-ordering fix is a pass reordering inside
`diffResolved`, not a graph algorithm; the referential-action and enum-`dbName` fixes are
line-level and must land in *both* renderers.

**Verified against source this phase** (findings A/B/G/H confirmed):
`renderPushSql` already emits FKs in a dedicated post-table pass (`postgres.ts:253-256`), so
ordering work is scoped to `migrate.ts` only. `fkSignature` (`migrate.ts:135`) omits both
actions. `addForeignKey` (`:88`) and `renderForeignKey` (`postgres.ts:136`) both handle
`onDelete` only; `createEnum` (`:51`), the `ADD VALUE` loop (`:228`) and `renderEnum`
(`postgres.ts:225`) all read `.values`. The top-level order at `:214-259` is sound.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| 1 | **`planMigration(prev, next): MigrationPlan`** replaces `diffResolved`; one ordered `MigrationStatement[]` where each carries `phase`, plus a `MigrationDiagnostic[]`. `renderMigrationSql(plan)` takes the plan. | (a) keep `string[]` + a parallel `diagnose()` function; (b) throw on refusal; (c) two arrays `{transactional, preTransaction}` | (a) is two traversals of the same diff — the exact duplication-drift failure this change exists to remove. (b) cannot report several refusals at once and cannot be captured by a golden alongside the DDL it suppressed. (c) destroys the single canonical statement order that the fixed-category-order requirement asserts *by statement index*. One tagged array preserves total order and still partitions. |
| 2 | Rename, do not reshape: `diffResolved` is **removed** from `index.ts`, not silently given a new return type. | Keep the name with a new type; keep a `string[]` back-compat wrapper | A same-named function with a different return type is the sneakier break. The wrapper would preserve an API that structurally cannot express refusals. Blast radius is one call site (`migrate-runner.ts:87`); packages are `0.0.1` and unpublished. |
| 3 | **Diagnostics are fatal to generation, not to a statement.** The plan still contains the DDL for unaffected objects; `migrateDev` refuses to write or apply any file when `plan.diagnostics.length > 0`. | Skip the offending object and apply the rest | The spec requires generation "does not silently succeed with partial DDL". Keeping the plan total (statements *and* diagnostics) is also what lets one golden fixture pin both. |
| 4 | **Deferred FK pass, not a topological sort.** Category 3 becomes 3a all `DROP CONSTRAINT`, 3b all per-table structure, 3c all `ADD CONSTRAINT`. | Topological sort of `next.tables` with cycle detection | The two-pass split satisfies every ordering scenario — declaration order, self-reference, genuine `A↔B` cycle, existing-table-references-new-table — **by construction, with zero special cases**. A sort must additionally decide what to do with a genuine cycle (fail, or break it arbitrarily): more code, a new failure mode, no benefit. It also makes `migrate.ts` structurally match `postgres.ts`'s already-correct pass order, which is the divergence-removal thesis. |
| 5 | Drops precede structure; adds follow it (3a/3b/3c). | Keep today's add-then-drop within one table loop | Load-bearing for decision 6: once actions enter FK comparison, an action change produces DROP+ADD of the **same constraint name**. Today's order would emit ADD (fails: duplicate) then DROP. The pass split makes the correct order fall out. Also lets a PK drop-recreate proceed when a referencing FK must go first. |
| 6 | FK identity stays `columns→refTable.refColumns`; a **separate `fkDefinition()`** adds `onDelete`/`onUpdate` and is compared only for FKs present on both sides. | Fold the actions into `fkSignature` itself | Folding works for DDL but misclassifies an action change as "one FK removed, a different FK added" — wrong for goldens, logging and any future diagnostic. Identity is the constraint; the definition is what changed. |
| 7 | **Rename map normalization**: after detecting `@map`-only renames, rewrite `prev`'s physical references (PK columns, index columns, FK columns) through `old dbName → new dbName` *before* diffing them. | Diff indexes/FKs/PK against raw `prev` | Without this, a single `@map` change makes every index, FK and PK on that column look dropped-and-recreated, and the emitted `DROP INDEX` would name a column that no longer exists. PostgreSQL follows `RENAME COLUMN` automatically for dependent objects, so the correct emission is *nothing*. |
| 8 | Realign **auto-derived** names after a column rename: `ALTER INDEX ... RENAME TO ...` and `ALTER TABLE ... RENAME CONSTRAINT ... TO ...`, only where `index.name`/`fk.name` is absent. | Accept derived-name drift | PostgreSQL does not rename indexes/constraints when a column is renamed, so `indexName()` would compute `T_creation_date_idx` while the database still holds `T_created_at_idx` — a later `DROP INDEX` fails. Explicitly-named objects never drift. |
| 9 | **`NOT NULL` guard fires only for a column added to a table that exists in `prev`** (and only when there is no default *and* no `autoincrement`). `createTable` is untouched. | Refuse always (the spec's stated assumption) | Corrects a spec-level judgment call: `NOT NULL` inside `CREATE TABLE` for a brand-new table is legitimate and must stay unaffected. The differ can distinguish the two. Matches Prisma. `autoincrement` must be exempt — `renderDefaultClause` returns `undefined` for it, but `GENERATED BY DEFAULT AS IDENTITY` backfills safely. |
| 10 | Column matching is **logical name first, physical name second**; only the residual sets can be ambiguous. | Logical name only (today) | Gives finding F a precise, non-heuristic rule (below) and makes a pure logical rename with a stable `@map` a correct zero-DDL result instead of today's broken DROP/ADD pair. |
| 11 | `enumMembers(e) = e.members ?? e.values.map(v => ({name: v, dbName: v}))`, used by both renderers. | Read `members` directly | `members` and `onUpdate` are **optional** in `ir.ts` precisely because `migrations/.snapshot.json` files written by earlier builds lack them. Reading `members` raw would make every value of an old snapshot look added. |
| 12 | Golden fixtures capture `plan`, `migrationSql` **and** `pushSql` for every fixture. | Separate push fixture set; capture push only where relevant | `renderPushSql` is a pure function of `next`, so capturing it is free and pins finding G ("both renderers") in the same artifact, with no second fixture tree to keep in sync. |

## The Statement/Diagnostic Contract

```ts
// packages/migrator/src/plan.ts (new)
export type MigrationPhase = "pre-transaction" | "transaction";

export interface MigrationStatement { sql: string; phase: MigrationPhase }

export type MigrationDiagnosticCode =
  | "ambiguous-column-remap"
  | "enum-value-removed"
  | "required-column-without-default";

export interface MigrationDiagnostic {
  code: MigrationDiagnosticCode;
  message: string;          // "<what is wrong>. <remedy>." — compiler's message contract
  table?: string; column?: string; enumName?: string; values?: string[];
}

export interface MigrationPlan {
  statements: MigrationStatement[];   // one canonical order; phase partitions it
  diagnostics: MigrationDiagnostic[];
}

/** Splits a migration FILE back into its phases. Absence of the marker ⇒ fully
 *  transactional, so pre-existing migrations/ files keep today's behavior. */
export function splitMigrationSql(sql: string): {
  preTransaction: string[];   // one entry per statement — see below
  transactional: string;
};
```

`pre-transaction` is currently reachable only by `ALTER TYPE ... ADD VALUE`. The phase is
named for the boundary, not the statement, so future non-transactional DDL needs no new
channel.

**File format.** Markers are emitted **only when a pre-transaction statement exists**, so
the common case stays byte-identical to today's output and legacy goldens/diffs stay clean:

```
-- Generated by IndigoDB migrate (PostgreSQL)

-- indigo:begin no-transaction
-- PostgreSQL cannot use an enum value added in the same transaction; these
-- statements are applied outside the migration transaction.
ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'pending';
-- indigo:end no-transaction

ALTER TABLE "Post" ADD COLUMN "slug" text;
```

**`preTransaction` is `string[]`, not one string — this is load-bearing.** `pg`'s simple
query protocol wraps a multi-statement string in an *implicit* transaction, so handing the
whole section to one `client.query()` would leave `ADD VALUE` inside a transaction after all
and defeat the change. The runner must issue one `query()` per statement. Splitting is exact,
not a general SQL parser: the section is split on blank lines, which is already the file's
statement separator (`stmts.join("\n\n")`), and `ADD VALUE` statements are single-line with no
dollar-quoting. Comment-only lines are dropped.

**Consumers of the shape change** — complete list:

| Consumer | Change |
|---|---|
| `migrate.ts` | `planMigration` returns the plan; `renderMigrationSql(plan)` (was `(prev, next)`) |
| `packages/migrator/src/index.ts` | Export `planMigration`, `renderMigrationSql`, `splitMigrationSql`, and the five types; **remove** `diffResolved` |
| `packages/cli/src/migrate-runner.ts` | `migrateDev`: one `planMigration` call (today it diffs twice, `:87` + `:96`); refuse on diagnostics before writing anything; apply pre-transaction statements one at a time, then `BEGIN` + transactional body + history `INSERT` + `COMMIT`. `migrateDeploy`: same split applied to the file read from disk |
| `packages/migrator/test/*` | Harness + regen script consume the plan |
| Everything else | Unchanged. `renderPushSql` is the only migrator export the CLI's `db push` uses (`cli/src/index.ts:90`); Studio, generator and client never touch the diff engine |

Atomicity: DDL and the `_indigo_migrations` history row stay in one transaction, as today.
Only `ADD VALUE` leaves it. The non-atomic window is bounded and self-healing — `IF NOT
EXISTS` makes a re-run a no-op, and an orphaned enum label is inert.

## Statement Ordering

```
1  enums:  CREATE TYPE  |  ADD VALUE (pre-transaction)  |  RENAME VALUE
2  realtime notify function            (only when realtime newly appears)
3a ALTER TABLE ... DROP CONSTRAINT     (all tables)
3b per table: CREATE TABLE | RENAME COLUMN → ADD/DROP/ALTER COLUMN → PK → indexes → trigger
3c ALTER TABLE ... ADD CONSTRAINT      (all tables)
4  DROP TABLE ... CASCADE
5  DROP TYPE
```

Categories 1–5 are today's order, preserved verbatim (finding H). 3a/3b/3c is the new
internal refinement. Within 3b, `RENAME COLUMN` must come first: every later `ALTER` in
`alterColumn` addresses the column by its **new** `dbName`.

## Column Matching and the Refusal Rule

Per table, match `prev`→`next` columns by logical `name`, then by physical `dbName`:

| Case | Emission |
|---|---|
| name matches, `dbName` differs | `RENAME COLUMN` + name realignment (decisions 7, 8) |
| name matches, `dbName` matches | today's `columnSignature`/`alterColumn` path |
| `dbName` matches, name differs | **nothing** — the physical column is unchanged (today: a broken DROP/ADD pair) |
| residual added, residual dropped | see Rule R |

**Rule R (`ambiguous-column-remap`).** Let `D` = `prev` columns matched by neither key and
`A` = `next` columns matched by neither. If `D ≠ ∅` and `A ≠ ∅` and at least one member of
`D` **and** at least one member of `A` carries an explicit `@map` (`dbName !== name`), emit
the diagnostic naming the table, every `D` field/`@map` pair and every `A` field/`@map` pair,
and emit **no** `RENAME`/`DROP`/`ADD` for any column in `D ∪ A`. Otherwise (no `@map`
involved) today's DROP+ADD stands — that is the bare field-rename ambiguity the proposal
explicitly defers. *Rejected:* gating on `@map` present on **either** side — safer against
data loss, but it converts "one field genuinely deleted, one genuinely added" into a false
refusal, and the spec's "AND its `@map` both change" wording requires a map on both sides.

Messages follow the compiler's parity contract (sentence case, terminal period, identifiers
double-quoted, `<what is wrong>. <remedy>.`):

```
Cannot add required column "email" to existing table "U" without a default. Declare @default(...) on "User.email", or make the field optional ("String?") and backfill it manually.
Cannot rename column on "User": field "createdAt" @map("created_at") became "creationDate" @map("creation_date") in one edit, so the target is ambiguous. Change the field name and the @map in separate migrations.
Cannot remove value "C" from enum "S". PostgreSQL cannot drop an enum value; recreate the type by hand after migrating every row that still holds "C".
```

## Enum Diff

Keyed by member **name** (logical identity, consistent with columns), rendering `dbName`:
added → `ADD VALUE IF NOT EXISTS '<dbName>'` (pre-transaction); removed → refusal
diagnostic; retained with a changed `dbName` → `ALTER TYPE ... RENAME VALUE` (transactional).
The rename arm is beyond the spec's letter but closes the same silent-no-op class the change
exists to eliminate; it needs PostgreSQL 10+, which must be stated in the release note.

## File Changes

| File | Action | What |
|---|---|---|
| `packages/migrator/src/plan.ts` | Create | Plan/statement/diagnostic types, `splitMigrationSql` |
| `packages/migrator/src/migrate.ts` | Modify | `planMigration`; 3a/3b/3c passes; rename map + normalization; Rule R; PK drop-recreate; `NOT NULL` guard; `fkDefinition`; `ON UPDATE`; enums via `enumMembers` |
| `packages/migrator/src/postgres.ts` | Modify | `renderForeignKey` `ON UPDATE` (`:136`); `renderEnum` from `enumMembers` (`:225`). **Ordering untouched — already correct** |
| `packages/migrator/src/index.ts` | Modify | New exports; drop `diffResolved` |
| `packages/migrator/package.json` | Modify | `"test": "node test/migrator.mjs"` |
| `packages/migrator/test/migrator.mjs` | Create | Golden harness |
| `packages/migrator/test/regen-goldens.mjs` | Create | Explicit regeneration |
| `packages/migrator/test/fixtures/<case>/{prev,next}.indigo` + `expected.json` | Create | ~18 fixtures |
| `packages/cli/src/migrate-runner.ts` | Modify | Plan consumption, refusal, phase-split execution |
| `packages/core/**`, `crates/**`, `apps/studio/**` | **Unchanged** | No IR change; no `build:wasm`; no compiler-snapshot regeneration |

`packages/migrator/tsconfig.json` needs no change — `include: ["src"]`, so `test/*.mjs` is
outside `tsc --noEmit`, exactly as in `@indigodb/compiler`.

## Golden Harness

Mirrors `packages/compiler/test/parity.mjs`: plain Node, no framework, `check(name, fn)` +
`deepStrictEqual`, non-zero exit with a readable diff, goldens as the review artifact. It
reads `prev.indigo`/`next.indigo` (absent `prev` ⇒ `prev = null`), runs `parse` + `resolve`
from `@indigodb/core` (already a `dependencies` entry; synchronous on Node), then asserts:

```json
{ "plan": { "statements": [{ "phase": "transaction", "sql": "CREATE TABLE ..." }],
            "diagnostics": [] },
  "migrationSql": "-- Generated by IndigoDB migrate (PostgreSQL)\n\n...",
  "pushSql": "-- Generated by IndigoDB — db push ...\n\n..." }
```

Capturing the structured plan *and* the rendered file lets one fixture pin ordering by
statement index, phase tagging, marker placement and exact SQL text at once. Turbo's `test`
task already `dependsOn: ["build"]`, so root `pnpm test` picks the suite up with no
`turbo.json` change.

Fixture set, 1:1 with spec scenarios: `fk-order-declaration`, `fk-self-reference`,
`fk-cycle`, `fk-to-new-table-from-existing`, `category-order-combined`, `enum-add-value`,
`enum-value-mapped`, `enum-value-removed`, `map-rename-only`, `map-rename-ambiguous`,
`pk-change`, `not-null-no-default`, `not-null-with-default`, `optional-column-added`,
`fk-actions-emitted`, `fk-actions-changed`, `fk-unchanged`, `no-changes`.

## Testing Strategy (Strict TDD)

`packages/migrator` has no harness at all, so slice 1 builds it against **today's** behavior
(characterization) — that is what makes RED possible for slices 2 and 3. Regeneration only
*records* what a failing-then-passing fixture already proved; it must never be the thing that
makes the suite pass.

| Behavior | RED | GREEN |
|---|---|---|
| Harness exists | `pnpm test` runs the migrator suite, 5 characterization fixtures green | `package.json` + `migrator.mjs` |
| Phase channel | `enum-add-value` golden expects `phase: "pre-transaction"` + markers | `plan.ts` + `renderMigrationSql` |
| FK ordering | fixtures 1–4 expect FK after every `CREATE TABLE` | 3a/3b/3c passes |
| `ON UPDATE`, enum `dbName` | `fk-actions-emitted`, `enum-value-mapped` — both `migrationSql` **and** `pushSql` | `migrate.ts` + `postgres.ts` |
| Action change | `fk-actions-changed` expects DROP then ADD; `fk-unchanged` expects zero DDL | `fkDefinition` |
| `@map` rename | `map-rename-only` expects one `RENAME COLUMN`, no index/PK churn | rename map + normalization |
| Refusals | `map-rename-ambiguous`, `enum-value-removed`, `not-null-no-default` expect exact diagnostics, zero DDL | Rule R, enum diff, guard |
| Regressions | `not-null-with-default`, `optional-column-added`, `no-changes`, `category-order-combined` | must not change |

Gates per slice: `pnpm test`, `pnpm build`, `pnpm lint`. `cd crates && cargo test` is
unaffected but must stay green.

**Honest verification limit.** Goldens pin generated **text**, not appliability. Nothing in
this suite or in CI runs PostgreSQL, so "the FK ordering is correct" means "the statement
order matches an expectation a human reviewed against PostgreSQL semantics". Two things are
therefore only structurally verified: that `ADD VALUE` actually executes outside a
transaction (pinned as marker structure and `splitMigrationSql` output, not as live
execution), and `migrate-runner.ts` itself, which has no harness — the split logic lives in
`@indigodb/migrator` **precisely so it is covered**, leaving the runner a thin wiring layer.
Integration testing against real PostgreSQL stays out of scope, as a named follow-up.

## Review Budget and Slicing

`review_budget_lines: 800`, `delivery_strategy: auto-chain`. Goldens are excluded from the
authored count; `.indigo` fixture sources are not. The predecessor underestimated a
comparable unit at ~300 and landed at 557, so these are deliberately generous.

| Slice | Scope | Files | ~Authored |
|---|---|---|---|
| 1 | Harness, plan contract, wiring — **no behavior change** | `plan.ts`, `migrate.ts` (wrapper), `index.ts`, `migrate-runner.ts`, `package.json`, harness, regen, 5 characterization fixtures | ~385 |
| 2 | Ordering, phase split, referential actions, enum `dbName` | `migrate.ts`, `postgres.ts`, 11 fixtures | ~275 |
| 3 | Diff completeness + safety guard | `migrate.ts`, 6 fixtures, release note | ~275 |

≈935 authored total — over a single 800-line PR, so three stacked PRs, each independently
verifiable and revertible. Slice 2 depends on slice 1's contract; slice 3 depends on slice
2's pass structure.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Adjacent, and load-bearing: identifiers and enum labels flow
verbatim into executed DDL. `quoteIdent()` and `esc()` are the only escaping, and every new
path (`RENAME COLUMN`, `RENAME VALUE`, `ALTER INDEX ... RENAME TO`, `RENAME CONSTRAINT`,
diagnostic interpolation) MUST keep using them. Diagnostic messages are printed, never
executed.

## Migration / Rollout

No data migration. Two behavior changes need a release note: (1) schemas that reported "No
schema changes" now produce migrations, or a refusal — the first `migrate dev` after upgrade
may be large; (2) `migrate dev` now **refuses** to write a migration when a diagnostic is
raised, where it previously succeeded silently. Pre-existing files under `migrations/` carry
no marker and stay fully transactional, so `migrate deploy` is backward compatible.

## Open Questions

- [ ] **Branch topology — verify before branching.** The tree at `main` already exposes
      `ForeignKey.onUpdate` and `ResolvedEnum.members` in `packages/core/src/ir.ts`, so
      `fix/compiler-schema-validation` may already be merged. Confirm with `git` at apply
      time; the stacking constraint may be satisfied trivially, but do not branch blind.
- [ ] **Cross-package divergence discovered, currently out of scope.**
      `packages/generator/src/client.ts:61` emits `V = "V"` from `e.values`, so the generated
      client sends **logical** names while the migrator will now create PostgreSQL labels
      from `dbName`. Enum `@map` then fails at runtime with `invalid input value for enum`.
      Needs a named follow-up plus a release-note warning. The same hazard exists *inside*
      the migrator at `postgres.ts:72` (`renderDefault` casts an enum default using the
      logical member name) — recommend pulling that one line into slice 2, otherwise this
      change ships a known-broken enum-default path.
- [ ] PK drop-recreate assumes PostgreSQL's default `<table>_pkey` constraint name, which is
      what an inline `PRIMARY KEY (...)` in `createTable` produces. A hand-named PK constraint
      would not be found. Documented limitation.
- [ ] Decision 10's third row (logical rename with a stable `@map` ⇒ zero DDL) and the enum
      `RENAME VALUE` arm are both beyond the spec's letter, adopted because they fall out of
      the chosen mechanism and are strictly safer than the status quo. Drop them if review
      prefers strict spec scope.
