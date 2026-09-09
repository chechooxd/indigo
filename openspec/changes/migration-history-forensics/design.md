# Technical Design: migration-history-forensics

## Context

Exploration approach 1 is settled: full column set plus blocking failure semantics.
This document decides the five genuinely open questions, the code placement of every
change in `packages/cli/src/migrate-runner.ts`, and the Testing Strategy that maps every
spec scenario to a named proving mechanism.

Settled upstream and not reopened here: `installed_by` from `current_user` only; the
mid-crash gap as a documented best-effort limitation; no backfill ceremony;
`resolve --applied` flipping a checksum-matching failure row to `true` and refusing on
drift; `resolve --rolled-back` deleting a failure row identically to a success row.

## Architecture

No new module, no new export surface, no new dependency. The change is contained to one
file plus its test file. The shape is: **one table definition, one write statement, one
definition of "applied"**.

### The single write statement

All four write sites (`migrateDev` success, `migrateDeploy` success, `migrateDeploy`
failure, `migrateResolve --applied`) share one constant:

```sql
INSERT INTO "_indigo_migrations"
  (name, checksum, success, installed_by, execution_time_ms)
VALUES ($1, $2, $3, current_user, $4)
ON CONFLICT (name) DO UPDATE SET
  checksum          = EXCLUDED.checksum,
  success           = EXCLUDED.success,
  installed_by      = EXCLUDED.installed_by,
  execution_time_ms = EXCLUDED.execution_time_ms,
  applied_at        = now()
```

Three consequences, each deliberate:

- `current_user` is evaluated **server-side inside the same statement**, not fetched with
  a prior `SELECT current_user` round trip. There is no window in which the value read
  and the value written could disagree, and no JavaScript variable that could be
  substituted with a self-reported string. `EXCLUDED.installed_by` resolves to that same
  server-side value on the update branch.
- Every site upserts, including the two that can practically never conflict. One SQL
  string is one thing to reason about, and no write path can raise a unique violation.
- `applied_at` is refreshed on the update branch. The table holds one row per `name`
  (`UNIQUE`), so a row's meaning is always "the latest attempt for this id". Preserving a
  superseded failure timestamp would require a second table — exploration approach 3,
  explicitly out of scope.

### The single table definition

`ensureHistory` becomes one statement. The three `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` calls and the entire backfill loop (`migrate-runner.ts:154-171`) are deleted.

```sql
CREATE TABLE IF NOT EXISTS "_indigo_migrations" (
  id                serial PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  checksum          text,
  success           boolean NOT NULL DEFAULT true,
  installed_by      text,
  execution_time_ms integer
);
```

`installed_by` is nullable **with no `DEFAULT current_user`**. Postgres would accept that
default, and it would be convenient — which is exactly the problem. A default makes a
write path that forgot to set the column indistinguishable from one that set it, and no
test could tell them apart. For a change whose whole subject is honest provenance, the
column must be silent unless the code fills it.

`execution_time_ms` is `integer` (not `bigint`): it returns a JavaScript number from both
`pg` and PGlite with no string coercion, and its 24.8-day ceiling is not a real bound on a
single migration. It is nullable — see D4.

### The single definition of "applied"

Three readers currently share one unfiltered query. They split:

| Helper | Filter | Consumers |
|---|---|---|
| `appliedMigrations()` | `WHERE success = true` | `migrateDeploy` pending detection, `migrateStatus` |
| `recordedMigrations()` | `WHERE success = true` | `checksumPreflight`, `resolvePrevSchema` → `buildShadowSchema` |
| `failedMigrations()` *(new)* | `WHERE success = false` | `migrateDeploy` refusal gate, `migrateStatus` rendering |

`recordedMigrations()` filtering is **not optional and is not in the spec text** — it is a
consequence the spec's `appliedMigrations` requirement drags in. `recordedMigrations` feeds
shadow replay. If a failure row stayed in `recorded`, `buildShadowSchema` would replay a
migration that did not apply, and `migrate dev` would diff against a `prev` schema the
target database does not have — silently generating a wrong migration. That is a worse bug
than the one being fixed. It gets its own test (X1).

The corollary: `checksumPreflight` no longer drift-checks failure rows. Correct. A failure
row is not "already applied", so its drift is not deploy's preflight concern; the
checksum comparison that matters for it lives in `resolve --applied` (D4), which the
operator must pass through anyway.

## Decisions

### D1 — `execution_time_ms` measures `applyMigrationSql` only

**Decision.** The clock starts immediately before `applyMigrationSql(client, sql)` and
stops immediately after it returns or throws. It excludes every preflight (advisory lock,
`ensureHistory`, `checksumPreflight`, shadow replay, destructive pre-scan, file reads) and
excludes the history write and `COMMIT`.

**Why not include preflight.** The number would stop meaning one thing. `migrateDev`'s
preflight is dominated by shadow replay, which connects a shadow database and replays the
entire recorded history — so the same migration would be timed differently depending on how
many migrations preceded it, and would be timed differently again under `migrate deploy`,
whose preflight is a checksum sweep plus a destructive scan. Worse, deploy's preflight runs
**once for a batch of N pending migrations**; attributing it to a row would require dividing
it arbitrarily among N. A column that means "SQL execution" in one row and "SQL execution
plus a share of a batch preflight" in another is exactly the ambiguous number the brief
warns is worse than no number.

**Why exclude `COMMIT`.** The failure path never reaches `COMMIT`. Including it on the
success path would make the two outcomes measure different spans under one column name.
The cost this loses — deferred constraint validation and fsync at commit time — is named in
the code comment rather than silently dropped.

**Clock source.** `performance.now()`, rounded with `Math.round`, not `Date.now()`.
Migrations run for minutes; an NTP step mid-migration can make a `Date.now()` delta
negative. `performance.now()` is monotonic.

**Attribution boundary.** The elapsed value written on the failure path is measured from
the same start point, so if the history INSERT or `COMMIT` (rather than the migration SQL)
is what threw, the recorded duration includes them. This is stated in the code comment; it
is a strictly rarer case and still describes one attempt at one id.

### D2 — A failure row blocks `migrate deploy` only, never `migrate dev`

**Decision.** `migrate dev` is not blocked by a failure row, and `migrate dev` never
writes one. `migrate deploy` refuses.

**Why `dev` writes no failure row.** `migrateDev`'s existing failure path `rmSync`s the
migration directory it just created (`migrate-runner.ts:414`) — the migration ceases to
exist on disk. A `success = false` row keyed on that name would point at nothing: it would
be absent from `listMigrationDirs`, so `migrate status` (which iterates directories) would
never print it, `checksumPreflight` would skip it (missing file → `continue`), and
`resolve --rolled-back` would refuse it as an unknown id — leaving an unremovable orphan
that no command can show or clear. Recording that is worse than recording nothing.

**Why `dev` is not blocked.** The refusal exists to stop `deploy` from silently mishandling
a **committed chain someone else wrote**. `dev` regenerates the migration from the current
schema on every run; there is no committed chain to protect, and "retry" is unambiguous —
the developer fixes the schema and runs `dev` again. Blocking it would strand a developer
in their own database with no forward move that `dev` itself offers.

**Where a failure row does reach `dev`, correctly.** Through `recordedMigrations()`'s
filter: a migration that failed under `deploy` is excluded from shadow replay, so `dev`
diffs against the schema the database actually has. That is the whole of `dev`'s
relationship to failure rows.

**Rejected: blocking `dev` too.** Symmetry for its own sake. It would convert a recoverable
developer-database state into one that requires a `resolve` incantation to escape, for no
protection gained.

### D3 — `migrate status` renders a fourth state and keeps exiting zero

**Decision.** A failure row renders as `✗ failed` in the existing state column, plus a
footer clause. `migrateStatus` continues to leave `process.exitCode` untouched.

```
  ✓ applied  20260101120000_init
  ✗ failed   20260102090000_add_orders
  · pending  20260103150000_add_index

3 migration(s), 2 pending.
1 failed — run `indigodb migrate resolve --applied <id>` or `--rolled-back <id>` before deploying.
```

The failure line uses the same `  ${state}  ${id}` template as the other three. No column
padding is introduced: the existing markers are already ragged (`⚠ modified` is longer than
`✓ applied`), and quietly re-aligning them would be an unrelated diff inside a change that
touches this function.

State precedence: `failed` > `modified` > `applied` > `pending`. With
`recordedMigrations()` filtered, a failed id can no longer be reported `modified` and can
never be `applied`, so this precedence is defensive rather than load-bearing — stated so it
does not read as accidental.

The footer's `pending` count **still includes the failed id**. It is pending: it has not
been applied and deploy has not run it. The extra clause qualifies that count rather than
contradicting it, and only prints when at least one failure row exists.

**Exit code: follows the precedent, does not break it.** `migrateStatus`'s documented
contract (`migrate-runner.ts:12-13`, `499-505`) is "reporting rather than refusing" — drift
prints `⚠ modified` and still exits zero. A failure row keeps that. The justification is
not consistency-for-its-own-sake: `status` is the command an operator runs **to find out
what a failed deploy did**, and a non-zero exit would make it fail in precisely the
situation it exists to explain — including in any CI step that runs it for visibility,
which would go red on a state that is already being handled elsewhere. Refusal belongs
where an action is taken, and that is `deploy`, which does exit 1. The spec scenario's own
wording ("and exits successfully") agrees.

### D4 — `execution_time_ms` is `null` on `resolve --applied`; column is nullable

**Confirmed, not corrected.** `resolve --applied` executes no migration SQL, so there is no
elapsed time. `0` would be a lie indistinguishable from an instantaneous migration.

The column is therefore declared without `NOT NULL`. This is not a new pattern in this
table: `checksum` is already nullable for the same class of reason.

A free forensic signal falls out and is worth naming: because both apply paths always write
a non-null value, `execution_time_ms IS NULL` uniquely identifies a row an operator
asserted by hand rather than one the runner executed. Nothing in this change consumes that,
but the column is defined so it stays true.

**Flipping a failure row to applied sets `execution_time_ms` back to `NULL`.** The
row's claim changes to "considered applied, no SQL run under this command"; carrying the
failed attempt's duration forward on a row now marked `success = true` would attribute a
failure's elapsed time to a success. `applied_at` and `installed_by` refresh at the same
moment, matching the upsert rule the integrity spec already states for retries.

### D5 — The failure-row write, and what happens when it also fails

**Placement.** Inside `migrateDeploy`'s existing `catch`, after
`await client.query("ROLLBACK").catch(() => {})`, as an autocommit statement on the same
connection. The per-migration loop tracks the in-flight attempt so the `catch` knows which
id, which checksum, and when the clock started:

```ts
let attempt: { id: string; checksum: string; startedAt: number } | null = null;

for (const id of pending) {
  const sql = readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8");
  const checksum = migrationChecksum(sql);
  attempt = { id, checksum, startedAt: performance.now() };
  await applyMigrationSql(client, sql);
  const elapsed = Math.round(performance.now() - attempt.startedAt);
  await client.query(HISTORY_UPSERT, [id, checksum, true, elapsed]);
  await client.query("COMMIT");
  attempt = null;
  console.log(`  ✓ applied ${id}`);
}
```

`attempt` is set **after** the file read (a missing file is not a failed migration) and
cleared **after** `COMMIT` (a failure in the history INSERT or in `COMMIT` is still a failed
attempt at that id, and its transaction did roll back). Errors thrown before the loop —
advisory lock, `ensureHistory`, preflight, the destructive pre-scan — leave `attempt` null
and write no row, which is correct: nothing was applied.

**Rejected: writing the row before `ROLLBACK`.** Impossible. The transaction is already
aborted; any statement raises `25P02`, and even if it did not, the write would be rolled
back with everything else.

**Rejected: opening a second connection for the write.** It adds a connect that can itself
fail or hang in exactly the situation where the write is failing — a database that has gone
away — doubling the failure surface for nothing. `ROLLBACK` ends the transaction, not the
connection; autocommit on the same connection is the shortest path that can work.

**When the failure-row write itself fails.** It is wrapped in its own `try/catch` and can
never propagate. The rule is: **the original migration error is printed last, is never
replaced, and is the only thing that determines the exit code.**

```ts
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});

  if (attempt) {
    const elapsed = Math.round(performance.now() - attempt.startedAt);
    try {
      await client.query(HISTORY_UPSERT, [attempt.id, attempt.checksum, false, elapsed]);
    } catch (writeError) {
      // Best-effort bookkeeping. It must never mask `error`, which is the thing
      // the operator actually needs, so this warns and falls through.
      console.error(`⚠️  Could not record the failed attempt for ${attempt.id}: ${(writeError as Error).message}`);
      console.error(`   ${attempt.id} will be reported as plain pending on the next run.`);
    }
  }

  console.error("❌ Deploy failed, rolled back:", (error as Error).message);
  process.exitCode = 1;
}
```

The bookkeeping warning is subordinate by construction: it prints before the `❌` line, so
the operator's last line of output is still the migration error; it does not rethrow; and
it does not touch `process.exitCode`, which is set to 1 by the original failure either way.
Without the inner `try`, a throw here would escape `migrateDeploy` entirely, skipping the
`❌` line and surfacing "connection terminated" in place of the real cause. That is the
exact failure mode D5 exists to prevent, and it is what test X3 mutates against.

**The mid-crash gap.** If the process dies between `ROLLBACK` and this write, no row is
recorded and the id reverts to plain pending on the next run. This is a documented
best-effort limitation, not a guarantee — stated in the integrity spec, and repeated as a
comment on this `catch` block. The suite runs against PGlite in-process, which cannot model
process death; see the Testing Strategy note on I11.

### D6 — Deploy refuses on *any* pending id carrying a failure row

The spec requires refusing when "the next pending id" carries a failure row. The
implementation refuses when **any** id in `pending` does, naming all of them. This is a
superset, so the requirement holds.

The reason is the doctrine already written into this function at
`migrate-runner.ts:456-457`: "Pre-scan ALL pending files before applying any: a per-file
gate would apply file 1 then refuse file 2, leaving a half-migrated database." A gate that
only inspected `pending[0]` would apply two migrations and then refuse on the third — the
same half-migrated outcome the destructive pre-scan already refuses to produce.

Placement: after the checksum preflight refusal and the `pending.length === 0` early
return, before the destructive pre-scan (it is the cheaper and more specific gate).

```
❌ migrate deploy refused: 1 pending migration(s) carry a recorded failed attempt: 20260102090000_add_orders
   Resolve each one with `indigodb migrate resolve --applied <id>` (it really did apply)
   or `indigodb migrate resolve --rolled-back <id>` (it did not), then re-run deploy.
```

`process.exitCode = 1`, no throw — matching every other refusal in this file.

**Known benign edge.** A failure row whose migration directory has since been deleted is not
in `dirs`, therefore not in `pending`, therefore does not trigger the refusal — and
`resolve --rolled-back` refuses it as an unknown id. The row is inert: filtered out of both
`appliedMigrations` and `recordedMigrations`, and never rendered by `status`. This mirrors
the existing orphan behaviour for success rows whose directory is gone, which
`checksumPreflight` already skips. Not fixed here; named so it is not rediscovered as a bug.

### D7 — `resolve --applied` branch order

The drift check must run **before** the success branch, or a drifted failure row would be
flipped to `true` without the checksum ever being compared. Reading `checksum, success`:

| Row state | Action |
|---|---|
| no row | upsert (`success = true`, `execution_time_ms = null`) → "recorded as applied" |
| row, `checksum IS NULL` | upsert, same as above (the pre-change "never really recorded" case) |
| row, checksum drifted | **refuse**, row untouched, `exitCode = 1` — regardless of `success` |
| row, checksum matches, `success = true` | no write — "Already recorded as applied — nothing to do." |
| row, checksum matches, `success = false` | upsert to `success = true`, `execution_time_ms = null` → "Failed migration marked as applied" |

## Behaviour changes to existing, currently-green tests

Three tests assert behaviour this change deliberately removes. They are **deleted**, not
adapted — adapting them would leave assertions whose names no longer describe what they
check:

- `packages/cli/test/migrate-runner.mjs:129` — "legacy 3-column table: ensureHistory adds
  checksum + success via ALTER"
- `:152` — "legacy row with NULL checksum is silently backfilled from on-disk SQL"
- `:184` — "backfill is idempotent: a second ensureHistory call touches zero rows"

The file header comment (`:7-8`) describing the ALTER/backfill shape is rewritten, as is
`migrate-runner.ts`'s `ensureHistory` doc comment (`:134-143`), which currently documents a
backfill loop that will not exist. The test at `:113` ("fresh install creates checksum +
success columns") is extended to the full seven-column set rather than deleted — it is
scenario I1.

Every other new test is **appended**, per the proposal's risk-table commitment that the
filtered-read change gets dedicated new regression coverage rather than edits to existing
assertions.

**One accepted behaviour change.** `timestamp()` has one-second resolution, so two
`migrate dev` runs in the same second with the same name produce the same id. Today the
second run raises a unique violation and rolls back; with the shared upsert it overwrites
the row instead. The on-disk `migration.sql` was already being overwritten before the
INSERT ever ran, so the upsert makes the database agree with the disk rather than diverge
from it. Accepted and documented; not fixed here.

## Testing Strategy

All tests live in `packages/cli/test/migrate-runner.mjs`, driving the real runner functions
against `@electric-sql/pglite` through `migrate-harness.mjs`. That suite is **not** gated on
`INDIGODB_TEST_DATABASE_URL`, so every row below runs on a bare `pnpm test`. No new mocking
of `node:fs` or `pg` is introduced.

`appliedMigrations` is not exported and no export is added for testing. Rows that concern it
are proven through observable command behaviour (`migrateStatus` output, `migrateDeploy`
refusal), which is the stronger assertion anyway.

### Integrity spec

| # | Scenario | Proving mechanism | Fails if the code |
|---|---|---|---|
| I1 | Fresh install creates the full column set | `ensureHistory` on an empty PGlite db; `historyColumns()` must contain all seven names | omits any column from the `CREATE TABLE`, or misspells one |
| I2 | Existing table left as-is, no backfill | Hand-create the pre-change 5-column table, run `ensureHistory`, then `INSERT ... (installed_by)` and assert it **rejects** with an undefined-column error | reintroduces any `ALTER TABLE ... ADD COLUMN`. This is the rare test that proves an absence, so it is written as a rejection rather than a column-list assertion |
| I3 | `success = true` on all three write paths | Three sub-cases in one check: `migrateDev`, `migrateDeploy`, `migrateResolve --applied`; each asserts its row's `success === true` | any path writes `false`, or the upsert's `EXCLUDED.success` is wired to a literal |
| I4 | Failed deploy leaves a durable failure row after rollback | Pending migration whose SQL fails at runtime; run `migrateDeploy`; assert exactly one row for that id with `success === false` and the on-disk checksum | the write is inside the `try` (rolled back), omitted, or issued before `ROLLBACK` (raises `25P02`) |
| I5 | A failure row does not make its migration look applied | After I4's failed deploy, run `migrateStatus`: the id must be counted in `pending` and marked `✗ failed`. Then run `migrateDeploy` again: it must print the refusal naming the id, **not** `✅ No pending migrations.` | `appliedMigrations()` loses its `success = true` filter — the second deploy would then report nothing pending, which is the exact silent-skip bug this change exists to prevent |
| I6 | Deploy refuses when a pending id carries a failure row | Seed a `success = false` row for an on-disk pending id; run `migrateDeploy`; assert stderr names the id, `process.exitCode === 1`, and the migration's table was **not** created | the gate is missing or placed after the apply loop |
| I7a | Retry upserts rather than violating `UNIQUE` (resolve route) | Failure row → `migrateResolve --applied` → assert exactly one row for that id, `success === true`, `installed_by` non-null, `applied_at` strictly greater than the failure row's | the statement is a plain `INSERT` (unique violation) or the branch is missing |
| I7b | Retry after `--rolled-back` re-inserts cleanly | Failure row → `migrateResolve --rolled-back` → `migrateDeploy` succeeds → assert one row, `success === true` | the delete leaves the row, or the re-insert collides. **Both routes are named** because the blocking rule (D6) means `deploy` alone can never reach a pre-existing row — a single test claiming to cover "applied again and succeeds" would be covering only one of two real paths |
| I8 | `installed_by` from `current_user` | After a successful deploy and after a failed deploy, assert `row.installed_by === (SELECT current_user)` queried from the same database — not a hard-coded `'postgres'` | the column is left null, or filled from a JavaScript constant. Comparing against the live `current_user` keeps the test honest on PGlite and on real Postgres alike |
| I9 | `execution_time_ms` on both outcomes | Success case: a migration containing `SELECT pg_sleep(0.05);` before its DDL. Failure case: `SELECT pg_sleep(0.05); DROP TABLE does_not_exist;` — a **runtime** error, not a syntax error, so the sleep really executes before the failure (simple-query protocol parses the whole string up front, so a syntax error would prevent it). Assert `typeof === "number"` and `>= 40` on both | the clock starts after `applyMigrationSql` or stops before it — either yields ~0 and fails the `>= 40` bound. A bare `>= 0` assertion would pass under both mutations and is explicitly rejected as non-biting. **Apply must confirm PGlite supports `pg_sleep` first**; if it does not, the fallback is a `spyMigrationClient` assertion that the elapsed parameter is computed across the apply call, and that substitution must be recorded, not silently made |
| I10 | Status distinguishes failed from applied and pending | Fixture with all three states; `captureLogs(migrateStatus)`; assert one `✗ failed` line naming the failed id, one `✓ applied`, one `· pending`, the `1 failed — run ...` footer clause, and `process.exitCode` untouched (existing idiom at `:456`) | a marker is reused or missing, the footer clause is absent, or `status` starts setting an exit code — the last of which is D3's precedent decision and would otherwise drift silently |
| I11 | Crash between rollback and failure write | **No test. Documented non-guarantee.** PGlite runs in-process and cannot model process death; there is no way to kill the runner between two statements on a live connection without also killing the test. Proven instead by assertion on the artifacts: a check that `migrate-runner.ts`'s failure-`catch` carries the limitation comment, and the statement in the integrity spec. Building a proxy test — e.g. making the write throw — would assert D5's masking rule (which is X3) while *appearing* to cover process death, and is refused for that reason | — (no mutation; the row exists to record that the gap is deliberate) |

### Resolve spec

| # | Scenario | Proving mechanism | Fails if the code |
|---|---|---|---|
| R1 | Applied resolve records the row without running SQL | Migration on disk creating table `t`, no recorded row; `migrateResolve --applied`; assert `checksum` equals the sha256 of the file bytes, `success === true`, `installed_by` non-null, `execution_time_ms === null`, **and** that table `t` does not exist | `execution_time_ms` is written as `0` or as an elapsed value, or any statement from the file executes |
| R2 | Applied resolve makes deploy skip that migration | After R1, run `migrateStatus` (asserts `✓ applied`) and `migrateDeploy` (asserts `✅ No pending migrations.`) | the row is written with `success = false`, or `appliedMigrations`'s filter is inverted |
| R3 | Applied resolve clears a matching failure row | Seed a `success = false` row with the true on-disk checksum; `migrateResolve --applied`; assert `success === true`, `execution_time_ms === null`, refreshed `applied_at`; then `migrateDeploy` no longer refuses on that id | the failure branch is missing (the row would hit the "already recorded — nothing to do" no-op and stay `false`, leaving deploy permanently stuck — the precise dead-end the proposal's risk table names) |
| R4 | Applied resolve refuses a drifted failure row | Seed a `success = false` row, then edit the on-disk file; `migrateResolve --applied`; assert the refusal message, `process.exitCode === 1`, and that `success` is still `false` | the drift check runs after the success branch (D7's ordering) — the row would be flipped to `true` with no checksum comparison |
| R5 | Rolled-back resolve deletes an existing row | Recorded success row → `--rolled-back` → assert zero rows for that id and no SQL executed | the delete is filtered on `success` |
| R6 | Rolled-back resolve deletes a failure row identically | Recorded failure row → `--rolled-back` → assert zero rows, the id reports pending, and `captureLogs` shows the **same** `✅ Migration record removed:` message as R5 with no extra failure-specific diagnostic | a `success`-dependent branch or message is introduced. The message-equality assertion is what makes "identically" testable rather than aspirational |
| R7 | Rolled-back resolve on an absent row is a clean no-op | No row → `--rolled-back` → assert exit code untouched, zero rows, and the "nothing to do" message | the delete path starts erroring on a missing row |

### Design-decision coverage (no spec scenario, but required by D2 and D5)

| # | Claim | Proving mechanism | Fails if the code |
|---|---|---|---|
| X1 | `recordedMigrations()` filters failure rows out of shadow replay | Migration A on disk creates table `t`; seed a `success = false` row for A; run `migrateDev({ createOnly: true })` with a schema containing `t`. Assert the written `migration.sql` contains a `CREATE TABLE` for `t` | the filter is missing: `prev` would already contain `t`, the plan would be empty, and dev would print `✅ No schema changes` — generating nothing where a migration is required |
| X2a | A failure row does not block `migrate dev` | With X1's fixture, assert `migrateDev` completes and `process.exitCode` is untouched | a deploy-style refusal gate is added to `migrateDev` |
| X2b | `migrate dev` writes no failure row of its own | Force a `migrateDev` failure (invalid generated SQL path, as the existing suite at `:595` already does); assert `historyRows` contains no row for the generated id **and** the migration directory was removed | the shared upsert is wired into `migrateDev`'s `catch`, producing an orphan row pointing at a deleted directory that no command can display or clear |
| X3 | A failing failure-row write does not mask the original error | `spyMigrationClient` with an `onQuery` that throws `new Error("connection terminated")` when `params?.[2] === false` (so only the failure write is affected). Run a failing `migrateDeploy` under `captureErrors`. Assert: `migrateDeploy` resolves rather than rejecting; stderr contains the original migration error; stderr contains the `⚠️  Could not record` warning; the `❌ Deploy failed` line is the **last** error line; `process.exitCode === 1` | the failure write lacks its own inner `try/catch` — the throw escapes `migrateDeploy`, the `❌` line never prints, and "connection terminated" replaces the real cause. This is the single most consequential mutation in the change and the reason D5 exists |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| PGlite does not evaluate `current_user`, or does not ship `pg_sleep` | Low | Both are verified in apply **before** tests are written on them. I8 compares against a live `SELECT current_user` rather than a literal, so it survives either engine. I9 carries a named fallback that must be recorded if used, not silently substituted |
| Filtering `recordedMigrations()` changes shadow replay and `checksumPreflight` beyond what the spec text names | Med | X1 is a dedicated biting test; the existing drift and shadow-replay suites are left untouched as the regression net |
| Deleting three green backfill tests hides an unrelated regression | Low | They assert behaviour this change removes by design; I1 and I2 replace them, and I2 proves the removal positively rather than by omission |
| Same-second duplicate `migrate dev` ids now upsert instead of erroring | Low | Accepted and documented above; the file was already being overwritten, so the upsert reduces divergence rather than creating it |
| An orphan failure row whose directory was deleted cannot be cleared | Low | Named as a benign edge in D6; inert in every read path, and mirrors existing orphan behaviour for success rows |
| The mid-crash gap is a stated non-guarantee | Accepted | Named in the spec, in the code comment, and in I11 — never presented as tested |

## Open questions for apply

None blocking. Two items require verification before the corresponding tests are written,
both listed in the risk table: PGlite's `current_user` and PGlite's `pg_sleep`.
