# Apply Progress: migration-history-forensics

## Scope of this batch

**Work Units A and B** (tasks A1–A3, B1–B3). Work Units C, D and E are not started.

**Mode**: Strict TDD.
**Delivery**: chained, split at the A–D | E seam (maintainer decision, recorded at the top of
`tasks.md`).
**Focused test command**: `node packages/cli/test/migrate-runner.mjs`

## Why this batch is Work Unit A alone, not A–D

The first executor launched for Work Units A–D was terminated by a model-provider rate limit
(HTTP 429, session limit) before writing any code — the ledger recorded `changed_lines: 0` and
`git status` showed no tracked modification, so there was nothing to clean up. That attempt was
settled `interrupted`. Because the objective on record was A–D and the candidate had not
drifted, the ledger correctly refused a narrower re-acquire as an elective budget reset and
required `gentle-ai sdd-attempt rescope` instead; the objective was rescoped to
`work-unit-a-schema` with the reason recorded, then re-acquired.

The rate limit is a model-provider condition, not a defect of the SDD tooling, the repository,
or this change.

## A finding: the task list named three legacy tests, and there were four

A1 listed `migrate-runner.mjs:129`, `:152` and `:184` for deletion. A fourth test —
`:218`, "legacy row with a missing on-disk file is left NULL, not guessed at" — depends on the
same removed machinery and was not named.

It is not a judgement call. That test hand-creates a legacy three-column table and then reads
through `historyRows()`, which is `SELECT name, checksum, success FROM "_indigo_migrations"`.
Once the `ALTER TABLE ... ADD COLUMN` statements are gone, `CREATE TABLE IF NOT EXISTS` is a
no-op against that table, so it stays three columns and the read fails with a SQL error —
the test breaks by throwing, not by asserting. It was deleted with the other three.

Its intent survives: "a legacy table is not silently repaired" is exactly what the new I2
asserts, and asserts more strictly, through a real rejected write rather than a NULL read.

## Completed Tasks (Work Unit A)

- [x] **A1** — four legacy tests deleted (three named, plus the fourth above). The test file
      header and `ensureHistory`'s doc comment both described a backfill loop that no longer
      exists; both rewritten. `ensureHistory`'s `cwd` parameter became unused once the backfill
      loop went, so it was dropped and all four call sites updated.
- [x] **A2 RED** — I1 extended from "has checksum + success" to the full seven-column set, and
      pinned with an exact column count so a future extra column is a visible decision rather
      than a silent pass. I2 added.
- [x] **A3 GREEN** — `ensureHistory` is now one `CREATE TABLE IF NOT EXISTS` with
      `installed_by text` and `execution_time_ms integer`, both nullable, no
      `DEFAULT current_user` (per the design's honesty argument: the value is written
      explicitly by the write path, not conjured by the schema).

## TDD Cycle Evidence

| Task | RED — as actually observed | GREEN | Mutation proof |
|------|----------------------------|-------|----------------|
| A2/I1 | `FAIL I1 … AssertionError: expected an installed_by column, got: id, name, applied_at, checksum, success` — its own assertion, naming the missing column, not a crash | seven-column `CREATE TABLE` | drop `installed_by`/`execution_time_ms` from the DDL → **I1 fails, I2 passes** |
| A2/I2 | **No RED, and this is recorded rather than claimed.** I2 asserts an absence that already held before the change: today's code never added `installed_by` either, so it passed on first run. `tasks.md` predicted exactly this and asked for it to be stated plainly instead of dressed up as a failing test. | — | re-introduce an `ALTER TABLE … ADD COLUMN IF NOT EXISTS installed_by` → **I2 fails, I1 passes** |

Both mutations were applied to the real tree, rebuilt (`@indigodb/cli` compiles to `dist/`,
which the suite imports — an un-rebuilt mutation proves nothing here), observed, and reverted.
Each fails exactly one test and only its own.

I2's value is entirely in that second mutation: it is regression protection against a future
re-introduction of the backfill path, which is the one way this change could be quietly undone.

## Gates

- `pnpm build --force` — 11/11, exit 0
- `pnpm lint` — 21/21, exit 0
- `pnpm test` — exit 0
- `git diff --numstat -- packages/cli` — **+76 / −134 = 210 changed lines, net −58**. Under the
  400-line review budget; the deletions outweigh the additions because four whole test blocks
  went.

## Not started

Work Units C, D, E. After this batch no code path writes a `success = false` row and
nothing reads `success` as a filter — the new columns exist and are never populated. That is
the intended intermediate state for this seam, and `tasks.md` records the standing commitment
that it must not be where the change stops.


---

# Work Unit B — the shared write statement

Implemented inline in the orchestrator session, same reason as A: the delegated executor model
is rate-limited until 01:00.

## What landed

`HISTORY_UPSERT` is now the single statement every history write goes through, and both
success paths (`migrateDev`, `migrateDeploy`) use it. `installed_by` is `current_user`
evaluated **server-side**, so the recorded identity is the role Postgres authenticated rather
than a value this process chose; nothing accepts a caller-supplied name, because an override
would be a self-reported claim wearing the same column as a database-enforced fact.

`execution_time_ms` brackets `applyMigrationSql` only — `performance.now()` immediately before,
`Math.round(performance.now() - start)` immediately after — excluding preflight, the history
write and `COMMIT`, per the design's D1 reasoning.

## TDD Cycle Evidence

| Task | RED — as actually observed | GREEN | Mutation proof |
|------|----------------------------|-------|----------------|
| B1/I8 | `FAIL I8 … Expected values to be strictly equal` — `installed_by` was never written | `current_user` in `HISTORY_UPSERT` | write a client-side constant (`'indigodb'`) instead of `current_user` → **I8 fails, I3 and I9 pass** |
| B1/I9 | `FAIL I9 … Expected values to be strictly equal` — `execution_time_ms` was never written | `performance.now()` around `applyMigrationSql` | start the stopwatch AFTER `applyMigrationSql` so it measures nothing → **I9 fails, I3 and I8 pass** |
| B3/I3 | Passed on first run for dev and deploy (both already wrote `success = true` before this change) — recorded as such, not claimed as a RED | — | covered by the design's own later units; see the gap below |

I8 is compared against `SELECT current_user` read live from the same database, never a
hard-coded `'postgres'` — a literal would still pass if the code wrote a constant of its own,
which is exactly what its mutation does.

I9's threshold is `>= 40` against a real `pg_sleep(0.05)`. `>= 0` would pass under both
clock-placement mutations and prove nothing.

## An honest gap: `ON CONFLICT` is introduced here and is not yet covered

A third mutation was run: **removing the entire `ON CONFLICT (name) DO UPDATE` clause leaves
the suite green.** No test in this work unit exercises it.

That is consistent with the plan rather than a miss in it — the design schedules the retry
coverage as I7a (resolve route) and I7b (delete-then-reinsert route) in later units, and no
path reachable in Work Unit B can collide on `name`: `migrateDev` ids are timestamped and
`migrateDeploy` only ever applies ids that `appliedMigrations()` reported as pending. The
clause is dormant until failure rows exist.

It is recorded here rather than left out because a mutation-proof table that silently omits the
mutation that did not bite is worth less than no table. The clause ships unproven in this
commit; I7a/I7b are where it earns its keep, and if those are dropped this clause has no
justification left.

## Gates

- `pnpm build --force` — 11/11, exit 0
- `pnpm lint` — 21/21, exit 0
- `pnpm test` — exit 0, `cli migrate-runner: all green`
- `git diff --numstat -- packages/cli` — +155 / −9 = 164 changed lines
