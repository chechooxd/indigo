# Apply Progress: migration-history-forensics

## Scope of this batch

**Work Units A, B, C and D** — the whole of PR 1. Work Unit E (PR 2) is not started.

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

Work Unit E (PR 2). After this batch no code path writes a `success = false` row and
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


---

# Work Unit C — `resolve --applied`, and the dead end it removes

## The dead end, shown rather than described

Before this unit, `migrateResolve --applied` selected only `checksum` and branched on it. A
`success = false` row whose checksum still matched the file therefore hit the
`stored === computed` arm and printed:

```
✅ Already recorded as applied: 20250101000000_r3 — nothing to do.
```

That is the console output of R3's RED run. A failed migration was told it was fine and left
`false` forever, with no operator command able to move it — the exact dead end the proposal's
risk table named.

## What landed

`--applied` now runs D7's five-way branch: no row, or a row with no checksum, records it;
**drift refuses, checked above the success/failure split**; matching + already-success is a
no-op; matching + failure flips to success. The new-row and flip arms both go through
`HISTORY_UPSERT` with `execution_time_ms = null`.

The branch order is the whole point. Putting the success test above the drift check would make
`--applied` a way to launder a drifted migration into the history without any checksum ever
being compared. R4 is what pins that ordering.

`execution_time_ms` stays `null` on both arms rather than 0: no SQL ran, and a zero reads as
"applied instantly" instead of "never executed here". On the flip arm it also means the failed
attempt's duration is not carried onto the row that now stands.

## TDD Cycle Evidence

| Task | RED — as actually observed | GREEN | Mutation proof |
|------|----------------------------|-------|----------------|
| C1/R1 | `FAIL … expected installed_by to be recorded, got: null` | resolve's new-row arm on `HISTORY_UPSERT` | covered by M7 below and by B's I8 |
| C1/R2 | Passed on first run — it asserts applied/pending states that already worked. Recorded as confirmatory, not claimed as a RED. | — | — |
| C3/R3 | `FAIL R3 … a matching failure row must flip to success`, with the console showing the dead-end message above | D7's fifth arm | carry the failed attempt's duration onto the flipped row (`999` instead of `null`) → **R3 fails, R4 passes** |
| C3/R4 | Passed on first run: the pre-D7 chain happened to reach its drift arm last. Not a RED — it is the guard for the ordering C4 introduces, which is why it was written before C4 rather than after. | drift arm above the success split | move the success test above the drift check → **R4 fails, R3 passes** |
| C5/R5–R7 | No RED and none expected: `--rolled-back` already deleted on `name` regardless of `success`. Added while the behaviour is provably correct so a future edit trips a named test. | no code change | genuinely special-case the failure row's message (`RETURNING name, success` + a branch) → **R5/R6 fails, R7 passes** |

## A boundary of R5/R6 worth recording

R5/R6 asserts the two removal paths produce *identical* output. A first mutation attempt —
changing the removal message for both paths at once — **did not fail it**, because the two
outputs stayed equal to each other. That is correct: the assertion guards against
special-casing failure rows, not against the message text changing. The mutation that actually
targets it is M8b, which branches on `success` and does fail it.

Both are recorded because the first one marks the edge of what this assertion covers. An
equality assertion proves the two sides match; it says nothing about what they match to.

## Gates

- `pnpm build --force` — 11/11, exit 0
- `pnpm lint` — 21/21, exit 0
- `pnpm test` — exit 0, `cli migrate-runner: all green`
- `git diff --numstat -- packages/cli` — +285 / −10 = 295 changed lines, inside the 400 budget


---

# Work Unit D — filtered readers and the refusal gate

`appliedMigrations()` and `recordedMigrations()` now filter `success = true`, `failedMigrations()`
is added, and `migrateDeploy` refuses when **any** pending id carries a failure row — checking
every id, not just the next one, on the same reasoning the destructive pre-scan already uses:
applying file 1 and then refusing file 2 leaves the half-migrated database this function exists
to avoid.

## Two findings that changed what got written

### 1. The design's X2a was wrong, and the real behaviour is better

X2a expected `migrate dev` to complete without refusal, on the reasoning that the new gate is
scoped to `deploy`. It is — but `migrate dev` refuses anyway, through a **pre-existing**
shadow-replay desync guard in `@indigodb/migrator` (`shadow.ts:199`): once
`recordedMigrations()` filters on success, a failed migration becomes "on disk but not recorded
as applied", which that guard already refuses.

That is the safe outcome and the right one. Planning a new migration on top of one whose real
effect on the database is unknown is exactly what must not happen quietly. The design note was
incomplete — it reasoned about the new gate and missed the old guard — so X1 was rewritten to
assert the true property (a failed migration is not replayed as applied, and nothing is
planned) rather than the assumed one.

**A follow-up this creates, named rather than absorbed:** that guard's message says
`Run \`indigodb migrate deploy\``, and deploy now refuses for this id and points at
`migrate resolve`. The operator path terminates — dev → deploy → resolve → dev — but the first
hop's advice is wrong for this case. Fixing it means threading failure state into a second
package, which is its own change, not a smuggled extra in this one.

### 2. I5 passed for the wrong reason, and a mutation caught it

I5 was first written against `migrateDeploy`, asserting it does not report "No pending
migrations" for a failed id. **Removing the `success = true` filter from `appliedMigrations()`
left that test green** — because D3's refusal gate returns before deploy ever reaches that
message. The test was proving the gate, not the reader it was named for.

Rewritten to assert through `migrateStatus`, which has no gate and reads straight through
`appliedMigrations()`. It now fails under that mutation, as it always should have.

This is the same failure class this change exists to remove, and the same one found in the ERD
work earlier: something that appears covered because a different mechanism happens to produce
the observable outcome.

## TDD Cycle Evidence

| Task | RED — as actually observed | GREEN | Mutation proof |
|------|----------------------------|-------|----------------|
| D1/I5 | `FAIL I5 … a failed id must not read as applied` | `WHERE success = true` on `appliedMigrations()` | remove that filter → **I5 fails, X1/X2a pass** (only after the rewrite above; before it, this mutation left I5 green) |
| D1/X1 | `FAIL X1 …` — the failed migration was replayed as applied | `WHERE success = true` on `recordedMigrations()` | remove that filter → **X1 fails** |
| D3/I6 | `FAIL I6 … a failed pending id must refuse with exit code 1` | the refusal gate | check only `pending[0]` → **I6 fails, all others pass** |
| D4/X2b | `FAIL X2a/X2b … migrateDev must leave NO history row on failure` | no change — scoping was already correct | wire `HISTORY_UPSERT` into `migrateDev`'s catch → **X2b fails, all others pass** |

X2b's fixture needed a second attempt worth recording: the first version injected a broken
table name, which PGlite accepted as a legal quoted identifier, so `migrateDev` **succeeded**
and the test was asserting against a row from a run that never failed. Replaced with a genuine
apply failure — the table pre-created so the migration's exact `CREATE TABLE` collides.

## Gates

- `pnpm build --force` — 11/11, exit 0
- `pnpm lint` — 21/21, exit 0
- `pnpm test` — exit 0, `cli migrate-runner: all green`
- `git diff --numstat -- packages/cli` for Work Unit D — +253 / −2 = 255 changed lines

## PR 1 is complete

Work Units A–D are done. After this, a `success = false` row is impossible to produce through
any code path — nothing writes one. Every reader and the gate that consume them are in place
and tested against rows seeded directly by SQL. Work Unit E makes them reachable.
