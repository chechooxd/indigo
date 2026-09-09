# Apply Progress: migration-history-forensics

## Scope of this batch

**Work Units A–E** — the whole change, PR 1 (A–D) and PR 2 (E).

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

Nothing. All five work units are complete. After this batch no code path writes a `success = false` row and
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


---

# Work Unit E — the failure row becomes reachable

The columns, the readers and the gate from PR 1 now have something to read. A failed
`migrate deploy` writes a durable `success = false` row, and `migrate status` gained a fourth
state.

## The write, and where it sits

`attempt` tracks the mid-flight migration, declared outside the `try` because the `catch` is
what reads it. Set only **after** the file read — a missing file is a broken migrations
directory, not a migration that was attempted — and cleared **after** `COMMIT`.

The row is written after `ROLLBACK`, as its own autocommit statement on the same connection: a
rollback ends the transaction, not the connection. Inside the transaction it would be discarded
along with the migration, which is precisely why a failed deploy used to leave nothing behind.

## X3: bookkeeping must never speak over what it is bookkeeping about

Its RED is the clearest one in this change. Without the inner guard, `migrateDeploy` **rejected
with `connection terminated`** — the bookkeeping error escaped and replaced the migration error
the operator actually needed. The guard warns, never rethrows, never touches
`process.exitCode`, and prints its warning *before* the `❌ Deploy failed` line so the last
thing on screen is still the real cause.

## X4 — found by mutation, not by the plan

Removing `attempt = null` after `COMMIT` left **every** test green. The task list had explained
why the line exists; nothing proved it.

Without it, a failure raised after one migration commits but before the next is assigned would
record the **already-applied** migration as failed. That is not a cosmetic slip: the deploy gate
from Work Unit D would then refuse that id forever, so a successful deploy would become a
permanent block requiring `migrate resolve` to clear.

X4 forces that window deterministically — it deletes the second migration's file on the first
`COMMIT`, so the next iteration's read throws between the two states — and fails under the
mutation.

## I11 — deliberately not a test, and not dressed as one

The mid-crash gap (process dies between `ROLLBACK` and the failure write) has **no functional
test**. The only mechanical option, making the write throw, re-asserts X3 while appearing to
cover process death — coverage theatre, which is worse than an admitted gap because it stops
anyone looking again.

What I11 does check is that the limitation stays written where a reader of the code meets it,
and that the same sentence survives in the spec. Delete the comment and the gap goes silent;
a silent gap is the thing this whole change exists to remove.

## TDD Cycle Evidence

| Task | RED — as actually observed | GREEN | Mutation proof |
|------|----------------------------|-------|----------------|
| E1/I4+I9 | `FAIL I4/I9 … expected exactly one row, got: []` — the gap itself | attempt tracking + autocommit write | remove the failure write → **I4 and X3 fail** |
| E3/X3 | `FAIL X3 … a failed bookkeeping write must not reject the command`, actual `Error: connection terminated` | inner try/catch, warn-before-fail ordering | rethrow from the guard → **X3 fails, I4 and I10 pass** |
| E5/I10 | `FAIL I10 … failed:   · pending  20250101000001_bad` — the failed row read as pending | fourth state above `pending` | drop the `✗ failed` branch → **I10 fails only** |
| E6/X4 | Written after the fact, from a mutation that nothing caught | `attempt = null` (already present; the test is what proves it load-bearing) | remove `attempt = null` → **X4 fails only** |
| E4/I11 | No RED and no mutation, by design decision — see above | — | none scheduled, on purpose |

**A methodology note.** Three of the four mutations in the first pass appeared not to bite,
and that was wrong: `sd`'s line-oriented matching had silently failed to apply them. Re-run with
the change confirmed before each test run, M14 and M16 both bit exactly their own test — and
M15 turned out to be a genuine gap rather than a tooling artefact. A mutation that was never
applied looks identical to a mutation that did not matter, so applying it must be verified,
not assumed.

## Gates

- `pnpm build --force` — 11/11, exit 0
- `pnpm lint` — 21/21, exit 0
- `pnpm test` — exit 0, `cli migrate-runner: all green`
- `git diff --numstat -- packages/cli` for Work Unit E — +342 / −5 = 347 changed lines, inside
  the 400 budget

## The change is complete

`success` is no longer a column that cannot be false. A failed deploy leaves a durable,
attributable record; no reader mistakes it for applied; deploy refuses to build on it; and
`migrate resolve` is the documented, tested way out. The standing commitment recorded at the
top of `tasks.md` — that Work Unit E must land or PR 1 be reverted — is discharged.


---

# F1/F2 — final verification and the row-for-row coverage check

## F1 — gates on the complete change

`pnpm build --force` 11/11 exit 0, `pnpm lint` 21/21 exit 0 (studio on `tsc -b`), `pnpm test`
exit 0 with `cli migrate-runner: all green`.

## F2 — every Testing Strategy row mapped to the test that covers it

This is the check that catches a scenario quietly dropped between design and apply, and it
earned its place: **two rows were never scheduled as tasks at all.**

| Design row | Covered by | Note |
|------------|-----------|------|
| I1 | `I1 fresh install…` | |
| I2 | `I2 a legacy table is left as-is…` | |
| I3 | `I3 success = true after…` | dev + deploy; resolve's third sub-case is R1/R3 |
| I4 | `I4/I9 a failed deploy records…` | |
| I5 | `I5 a failed id is not counted as applied…` | rewritten to assert through `status`, see Work Unit D |
| I6 | `I6 deploy refuses when ANY pending id…` | |
| **I7a** | **`R3 resolve --applied flips a matching failure row…`** | **never scheduled as a task — covered anyway** |
| **I7b** | **`R5/R6 …identically`, extended after verify** | **never scheduled as a task; my first "covered anyway" claim was too generous — see below** |
| I8 | `I8 installed_by is recorded from current_user…` | |
| I9 | `I4/I9…` (failure half) and `I9 execution_time_ms…` (success half) | |
| I10 | `I10 status distinguishes failed…` | |
| I11 | `I11 the mid-crash limitation is documented…` | artifact check, NOT a functional test — by design |
| R1 | `resolve --applied records the row without executing migration SQL` | extended in place rather than renamed |
| R2 | `R2 after resolve --applied the id reads as applied…` | |
| R3 | `R3 resolve --applied flips…` | |
| R4 | `R4 resolve --applied refuses a DRIFTED failure row…` | |
| R5 | `R5/R6 …identically` | |
| R6 | `R5/R6 …identically` | named jointly; the message-equality assertion is R6's half |
| R7 | `R7 --rolled-back on an unrecorded id…` | |
| X1 | `X1 a failed migration is not replayed…` | rewritten; the design's premise was wrong, see Work Unit D |
| X2a | `X2a/X2b migrateDev never writes a failure row…` | |
| X2b | `X2a/X2b …` | named jointly |
| X3 | `X3 a failing failure-write warns…` | |
| — | **`X4 a mid-loop failure is not blamed…`** | **not in the design's table; found by mutation** |

## The I7a/I7b finding, and why it matters more than it looks

Neither `I7a` nor `I7b` appears anywhere in `tasks.md`. The design's table listed them; the task
breakdown dropped them. That is the exact failure this project has recorded before, running the
other way: a gap between the design's Testing Strategy table and what apply actually schedules.

It matters here specifically because **I7a was the only planned coverage for the
`ON CONFLICT (name) DO UPDATE` clause**, which Work Unit B's own notes flagged as shipping
unproven — removing the clause left the suite green at the time.

Re-run now, that mutation **fails `R3`**. The clause is covered, by a test that arrived in Work
Unit C for a different stated reason. So this is a traceability gap rather than a coverage gap:
the property is proven, it was simply never proven under the name the design gave it.

Recorded rather than quietly ticked off, because "covered by accident" and "covered on purpose"
look identical in a green suite, and only one of them survives the next refactor.

## What the mutation log says about the whole change

Every mutation run in this change, and what it broke:

| Mutation | Broke |
|----------|-------|
| Drop `installed_by`/`execution_time_ms` from the DDL | I1 |
| Re-introduce `ALTER TABLE … ADD COLUMN` | I2 |
| `installed_by` from a client constant instead of `current_user` | I8 |
| Stopwatch started after `applyMigrationSql` | I9 |
| Remove `ON CONFLICT` | R3 (nothing, at the time it was introduced) |
| Success test above the drift check | R4 |
| Carry the failed attempt's duration onto the flipped row | R3 |
| Special-case the failure row in `--rolled-back` | R5/R6 |
| `appliedMigrations()` unfiltered | I5, I6 |
| `recordedMigrations()` unfiltered | X1 |
| Gate checks only `pending[0]` | I6 |
| Wire `HISTORY_UPSERT` into `migrateDev`'s catch | X2b |
| Remove the failure-row write | I4, X3 |
| Rethrow from the inner guard | X3 |
| Remove `attempt = null` after COMMIT | X4 |
| Drop status's `✗ failed` branch | I10 |

## A measurement error of mine, recorded

I sized every work unit's budget by `git diff --numstat -- packages/cli`, and the ledger counts
the whole candidate — `openspec/` artifacts included. So my numbers ran consistently low: 295
vs 371 for C, 255 vs 341 for D, 347 vs 452 for E. Work Unit A's budget breach earlier in this
change had the same root cause and was blamed on deletions alone; that explanation was
incomplete.


---

# Post-verify corrections

Final verification came back PASS WITH WARNINGS, 0 CRITICAL, with six of the sixteen mutations
independently re-applied and all six reproducing. Two things it raised are worth recording
precisely, because one of them was my claim and the other is a real omission.

## I7b was not as covered as I said

F2's table above claimed I7b — "retry after `--rolled-back` re-inserts cleanly" — was "covered
anyway" by R5/R6. That was too generous.

The verify's stated evidence was wrong: it reported that no test calls `migrateDeploy` after a
`--rolled-back`, and R5/R6 did. But its conclusion was right. The assertion there was
`deployLines.some(l => /applied/.test(l))` — which proves the ids became pending again, and
says **nothing about what the re-insert wrote**. That is the half of I7b that matters, since a
failed id has to survive the Work Unit D refusal gate to reach a re-deploy at all.

R5/R6 now asserts the resulting rows: two of them, both `success = true`, both carrying
identity and a duration, and both tables actually created. Proven by mutation — making
`--rolled-back` select instead of delete fails R5/R6 and nothing else.

The general lesson is the one this whole change keeps producing: **"covered anyway" is a claim
about a test, and it has to be read against what the test asserts, not against what its name
suggests.** I made exactly the error I had warned about two sections earlier.

## `execution_time_ms` overflow now has a stated position

The column is `integer`, so it caps at 2^31−1 ms ≈ 24.8 days. Neither spec nor design said what
happens past that. The position is now written into the DDL: a single migration running longer
than that is a pathology the history table is not the right place to survive, and an overflow
makes the write fail — surfacing through the failure path rather than silently recording a
wrong number. Named rather than left to be discovered.

## Two edges confirmed as already-documented, not new

`--rolled-back` on a failure row whose file is also missing is refused by the file-existence
guard, leaving an unclearable orphan (`design.md:423`, known Low risk). Two same-second
`migrate dev` runs now upsert rather than raising a unique violation (`design.md:359-364`,
accepted behaviour change). Both were independently reconfirmed by the verify rather than taken
on trust.
