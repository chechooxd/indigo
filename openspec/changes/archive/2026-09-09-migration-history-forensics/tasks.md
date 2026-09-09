# Tasks: migration-history-forensics

Strict TDD is enabled: every implementation task lists its RED step (new/extended
assertions, run and confirmed failing for the right reason) before its GREEN step
(the code change that turns it green). All work is contained to
`packages/cli/src/migrate-runner.ts` and `packages/cli/test/migrate-runner.mjs`
(+ `migrate-harness.mjs` for any new fixture helpers), so the sequencing below is
mostly linear — the file has one write path shared by three call sites, and later
tasks depend on helpers earlier tasks introduce.

Coverage map: every row of design.md's Testing Strategy table (I1–I11, R1–R7,
X1–X3 = 22 rows) has a task below. I11 is explicitly a documentation/artifact
check, not a functional test — carried as its own line, not silently dropped.

---

## Delivery decision (maintainer, 2026-09-08)

**Split at the A–D | E seam. Two chained PRs, each green and each under the 400-line budget.**
The honest forecast was 600–700 lines against 400; it was reported as an overrun rather than
shaded down to fit, and the seam is real: Work Units A–D land the schema, the filtered readers
and the refusal gate; Work Unit E lands the failure-row write and `migrate status`'s fourth
state.

**The risk this split carries, named on purpose.** After PR 1 the refusal gate and the
`success = true` filters guard a state nothing can yet produce — no code path writes a failure
row until E. That is forward-compatible guarding, which is *the exact pattern that created the
defect this change exists to fix*: `success` shipped as a forward-compatible column with no
enforcement and stayed dead, its own spec pinning "a failed migration still leaves no row" as
expected behaviour.

The difference is that this deferral is not open-ended — E is the immediate next unit of the
same change, not a someday. That difference only holds if E actually lands. **If Work Unit E
is abandoned or deferred past this change, PR 1 must be reverted rather than left standing**;
a guard for an unreachable state is precisely the debt this change is paying off, and shipping
a second one to fix the first would be the worst available outcome.

## Work Unit A — Schema cleanup: single `CREATE TABLE`, no backfill

Spec: `migration-history-integrity` — "records checksum, success, installed_by,
and execution_time_ms, created once with no backfill".

- [x] **A1. Delete the three legacy backfill tests, with justification recorded in the commit.**
      Remove `migrate-runner.mjs:129` ("legacy 3-column table: ensureHistory adds
      checksum + success via ALTER"), `:152` ("legacy row with NULL checksum is
      silently backfilled"), `:184` ("backfill is idempotent"). These assert
      behavior design.md deliberately removes (the `ALTER TABLE ... ADD COLUMN`
      path and the backfill loop) — adapting them would leave assertions whose
      names no longer describe what they check. Also rewrite the file header
      comment (`:7-8`) and `ensureHistory`'s doc comment (`migrate-runner.ts:134-143`),
      which currently document a backfill loop that will not exist.
      This is a visible deletion step, not a side effect of A3.
      Sequential — must land before/with A3 so the suite never runs against a
      stale doc comment describing removed behavior.

- [x] **A2. RED — extend I1, add I2.**
      Extend the test at `:113` ("fresh install creates checksum + success
      columns") to assert `historyColumns()` contains all seven names:
      `id, name, applied_at, checksum, success, installed_by, execution_time_ms`.
      Run it — it fails today (only 5 columns exist). This is I1.
      Add I2: hand-create the pre-change 5-column table, run `ensureHistory`,
      then `INSERT ... (installed_by)` and assert it **rejects** with an
      undefined-column error. Note: I2 proves an absence that already holds
      pre-change (today's code never adds `installed_by` either), so its "RED"
      state is largely definitional rather than a failing assertion — record
      this explicitly rather than claiming a false RED. Its value is regression
      protection against a *future* backfill re-introduction, which is exactly
      what A3/A1 exist to prevent.
      Depends on: A1 (comment/test file must already reflect the target shape).

- [x] **A3. GREEN — rewrite `ensureHistory`.**
      Replace the current `CREATE TABLE` (5 cols) + two `ALTER TABLE ... ADD
      COLUMN IF NOT EXISTS` + backfill loop (`migrate-runner.ts:144-172`) with
      the single statement from design.md:
      `CREATE TABLE IF NOT EXISTS "_indigo_migrations" (id serial PRIMARY KEY,
      name text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text, success boolean NOT NULL DEFAULT true, installed_by text,
      execution_time_ms integer)`. `installed_by`/`execution_time_ms` nullable,
      no `DEFAULT current_user` (per the design's honesty argument). Confirms
      I1 and I2 pass.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "column|backfill"`

---

## Work Unit B — The shared write statement, wired into the two success paths

Spec: `migration-history-integrity` — "success gates which migrations are
treated as applied"; `migration-history-resolve` — applied-resolve columns.

- [x] **B1. RED — add I8 and the success-path half of I9.**
      I8: after a successful `migrateDev` and a successful `migrateDeploy`,
      assert `row.installed_by === (SELECT current_user)` queried live from
      the database — not a hard-coded `'postgres'`.
      I9 (success half only — failure half lands with Work Unit D): a
      migration whose SQL is `SELECT pg_sleep(0.05);` followed by real DDL;
      assert `execution_time_ms` is `typeof "number"` and `>= 40`. (PGlite's
      `current_user` and `pg_sleep` are already verified working — no probe
      task needed.)
      Both fail today: `installed_by`/`execution_time_ms` are never written.

- [x] **B2. GREEN — introduce `HISTORY_UPSERT` and D1 timing, wire into `migrateDev` and `migrateDeploy` success paths.**
      Add the shared constant:
      ```sql
      INSERT INTO "_indigo_migrations"
        (name, checksum, success, installed_by, execution_time_ms)
      VALUES ($1, $2, $3, current_user, $4)
      ON CONFLICT (name) DO UPDATE SET
        checksum = EXCLUDED.checksum, success = EXCLUDED.success,
        installed_by = EXCLUDED.installed_by,
        execution_time_ms = EXCLUDED.execution_time_ms, applied_at = now()
      ```
      Replace the plain `INSERT INTO ... (name, checksum, success)` in
      `migrateDev` (`:404-407`) and `migrateDeploy` (`:479-482`) with this
      statement. Add D1 timing: `performance.now()` immediately before
      `applyMigrationSql`, `Math.round(performance.now() - start)` immediately
      after — excluding preflight, the history write, and `COMMIT`, per D1's
      "why not include preflight" reasoning. Confirms B1's I8 and I9-success.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "installed_by|execution_time"`

- [x] **B3. RED then GREEN — I3 (success = true on all three write paths).** *(dev + deploy sub-cases here; the `migrateResolve --applied` sub-case is sequenced into Work Unit C, the ordering tasks.md sanctions first — see apply-progress.)*
      Add I3 as its own named assertion (three sub-cases: `migrateDev`,
      `migrateDeploy`, `migrateResolve --applied`), even though B2/B5 already
      make two of the three pass — this row exists in the design's table and
      must have its own visible assertion, not ride silently on I8/I9.
      `migrateResolve --applied`'s sub-case depends on B5 (Work Unit C);
      sequence I3's third sub-case after C1/C2 land, or write all three
      assertions now and expect the third to stay red until Work Unit C closes
      it — the latter is acceptable strict-TDD practice (one red assertion
      carried openly across two work units) as long as it is never silently
      skipped.

---

## Work Unit C — `resolve --applied`: shared write path, drift-before-flip ordering (D7)

Spec: `migration-history-resolve`.

- [x] **C1. RED — R1, R2.**
      R1: migration on disk, no recorded row; `migrateResolve --applied`;
      assert `checksum` = sha256 of the file, `success === true`,
      `installed_by` non-null, `execution_time_ms === null`, and the
      migration's table was **not** created.
      R2: after R1, `migrateStatus` reports `✓ applied` and `migrateDeploy`
      reports `✅ No pending migrations.` (R2's `migrateStatus`/`migrateDeploy`
      assertions on the failure-row/fourth-state text depend on Work Unit E;
      write R2 now against the applied/pending states only, which already
      exist).
      Both fail today: the no-existing-row branch (`:578-584`) writes only
      `(name, checksum, success)`, no `installed_by`/`execution_time_ms`.

- [x] **C2. GREEN — wire `migrateResolve --applied`'s new-row branch to `HISTORY_UPSERT` with `execution_time_ms = null`.**
      Confirms R1, R2.

- [x] **C3. RED — R3, R4 (D7 branch ordering).** *(R3's deploy-no-longer-refuses half is sequenced into Work Unit D, where the refusal gate exists — same ordering as B3, see apply-progress.)*
      R3: seed a `success = false` row with the *true* on-disk checksum;
      `migrateResolve --applied`; assert `success === true`,
      `execution_time_ms === null`, refreshed `applied_at`; then
      `migrateDeploy` no longer refuses on that id (this half of R3's
      assertion depends on Work Unit D's refusal gate existing — write it now,
      expect it red until D lands, same open-red-assertion note as B3).
      R4: seed a `success = false` row, edit the on-disk file (drift);
      `migrateResolve --applied`; assert the refusal message,
      `process.exitCode === 1`, and `success` is still `false`.
      Both fail today: there is no failure-row branch at all in `:571-591`
      (a `success = false` row with a matching checksum currently hits the
      `stored === computed` no-op branch and stays `false` forever — the exact
      dead end the proposal's risk table names).

- [x] **C4. GREEN — implement D7's five-way branch, drift check first.**
      Rewrite the `--applied` branch per design.md's table: no row → upsert;
      `checksum IS NULL` → upsert; checksum drifted → refuse regardless of
      `success` (**checked before** the success/failure distinction — this
      ordering is the entire point of D7 and of R4); checksum matches +
      `success = true` → no-op; checksum matches + `success = false` → upsert
      to `true` with `execution_time_ms = null`. Confirms R3, R4, and closes
      B3's third I3 sub-case.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "resolve"`

- [x] **C5. RED then GREEN (no code change expected) — R5, R6, R7.**
      `--rolled-back` already deletes unconditionally on `name` regardless of
      `success`, so these are confirmatory regression tests, not
      code-changing ones — add them now while the behavior is provably
      correct, so a future change to the delete branch trips a named test
      instead of silence.
      R5: recorded success row → `--rolled-back` → zero rows, no SQL executed.
      R6: recorded **failure** row → `--rolled-back` → zero rows, id reverts to
      pending, and `captureLogs` shows the **same** `✅ Migration record
      removed:` message as R5 (message-equality assertion — this is what makes
      "identically" testable).
      R7: no row → `--rolled-back` → exit code untouched, zero rows, "nothing
      to do" message.

---

## Work Unit D — Filtered readers, `failedMigrations()`, and the deploy refusal gate (D6)

Spec: `migration-history-integrity` — filtered `appliedMigrations()`, deploy
refusal. Design's found-consequence: `recordedMigrations()` must filter too.

- [x] **D1. RED — I5, X1 (seed failure rows directly by SQL; no deploy-failure code needed yet).** *(I5's `✗ failed` status-marker half sequenced into Work Unit E; I5 rewritten to assert through `migrateStatus`, see apply-progress.)*
      I5: seed a `success = false` row for an on-disk id; run `migrateStatus`
      (id counted as pending — this half already holds; the `✗ failed` marker
      half depends on Work Unit E, write it expecting red until then) and run
      `migrateDeploy` twice: it must **not** report `✅ No pending
      migrations.` for that id.
      X1: migration A on disk creates table `t`; seed a `success = false` row
      for A; run `migrateDev({ createOnly: true })` against a schema
      containing `t`; assert the written `migration.sql` contains a `CREATE
      TABLE` for `t` (i.e. `t` was NOT considered already-applied by shadow
      replay).
      Both fail today: `appliedMigrations()` (`:174-177`) and
      `recordedMigrations()` (`:210-218`) have no `WHERE success = true`.

- [x] **D2. GREEN — filter `appliedMigrations()` and `recordedMigrations()` on `success = true`; add `failedMigrations()`.**
      `appliedMigrations()` → `SELECT name FROM ... WHERE success = true`.
      `recordedMigrations()` → same filter added to its query — this is the
      design's named "found beyond the brief" consequence: without it,
      `buildShadowSchema` replays a migration that never applied and
      `migrate dev` silently diffs against a schema the database does not
      have. It is not a side effect of D2 — it is the reason D2 exists as its
      own task, proven by its own test (X1), not folded into I5.
      Add `failedMigrations()`: `SELECT name FROM ... WHERE success = false`,
      for the refusal gate (D3) below. Confirms I5's non-status half and X1.

- [x] **D3. RED then GREEN — I6 (deploy refusal gate, D6's any-not-just-next semantics).**
      RED: seed a `success = false` row for an on-disk pending id; run
      `migrateDeploy`; assert stderr names the id, `process.exitCode === 1`,
      and the migration's table was **not** created. Fails today: no gate
      exists.
      GREEN: in `migrateDeploy`, after the checksum-preflight refusal and the
      `pending.length === 0` early return, before the destructive pre-scan,
      check `failedMigrations()` against **every** id in `pending` (not just
      `pending[0]`) — per D6, the destructive-pre-scan doctrine already in
      this function ("apply file 1 then refuse file 2" is the same
      half-migrated outcome). Print all offending ids, `process.exitCode = 1`,
      no throw. Confirms I6 and closes C3's R3 cross-reference.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "refus"`

- [x] **D4. RED then GREEN — X2a, X2b.** *(X2a's premise was wrong — `migrate dev` IS refused, by a pre-existing shadow-replay guard, not by the new gate. See apply-progress; the design note was incomplete, the behaviour is correct and safer.)*
      X2a: with D1's X1 fixture, assert `migrateDev` completes (no refusal)
      and `process.exitCode` is untouched. This should already pass once D3 is
      scoped to `migrateDeploy` only — write it explicitly so a future change
      that copies the gate into `migrateDev` trips a named test.
      X2b: force a `migrateDev` failure via the existing invalid-generated-SQL
      path (`:595` in the current suite); assert `historyRows` contains **no**
      row for the generated id and the migration directory was removed. This
      must stay true through every later Work Unit — it is the one place a
      naive refactor could wire the shared `HISTORY_UPSERT` into `migrateDev`'s
      catch by accident, producing an orphan row pointing at a deleted
      directory. No code change is expected for X2a/X2b if B2/D2 were scoped
      correctly; if either goes red, that is a real regression, not a test bug.

---

## Work Unit E — The failure-row write itself (D5) and `migrate status`'s fourth state (D3)

Spec: `migration-history-integrity` — failed deploy leaves a durable row;
`migrate status` distinguishes it.

- [x] **E1. RED — I4, and the failure-path half of I9.**
      I4: pending migration whose SQL fails at runtime (a genuine runtime
      error, not a syntax error — simple-query protocol parses the whole
      string up front); run `migrateDeploy`; assert exactly one row for that
      id with `success === false` and the on-disk checksum.
      I9 (failure half): `SELECT pg_sleep(0.05); DROP TABLE does_not_exist;`
      as the migration body; assert `execution_time_ms` is a number `>= 40` on
      the failure row (the sleep genuinely executes before the runtime
      failure — already verified against real PGlite by the orchestrator).
      Both fail today: a failed `migrateDeploy` writes no row at all — this is
      the exact gap the proposal exists to close.

- [x] **E2. GREEN — implement D5's attempt-tracking and autocommit failure write in `migrateDeploy`.**
      Track `attempt: { id, checksum, startedAt } | null` across the pending
      loop, set **after** the file read (a missing file is not a failed
      migration attempt) and cleared **after** `COMMIT`. In the `catch`, after
      `ROLLBACK`, if `attempt` is set: compute elapsed, run `HISTORY_UPSERT`
      with `success = false` as its own autocommit statement on the same
      connection, wrapped in its own inner `try/catch` (see E3 for why).
      Confirms I4 and I9's failure half.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "failed deploy|execution_time"`

- [x] **E3. RED then GREEN — X3 (the failure write must never mask the original error).**
      RED: `spyMigrationClient` with `onQuery` that throws
      `new Error("connection terminated")` when `params?.[2] === false` (only
      the failure write is affected). Run a failing `migrateDeploy` under
      `captureErrors`. Assert: `migrateDeploy` resolves rather than rejecting;
      stderr contains the original migration error; stderr contains the
      `⚠️  Could not record` warning; the `❌ Deploy failed` line is the
      **last** error line; `process.exitCode === 1`.
      GREEN: wrap the failure-row write in its own inner `try/catch` per
      design's D5 code (warn, never rethrow, never touch `process.exitCode`,
      print the `⚠️` line **before** the `❌` line so the operator's last
      output line is still the real cause). This is the single most
      consequential mutation named in the design — do not fold it into E2's
      GREEN; keep it a separately provable step.

- [x] **E4. Documentation/artifact check — I11 (no functional test, by design decision).**
      Add one lightweight assertion — read `migrate-runner.ts`'s source text
      and assert the failure-`catch` block carries the mid-crash-gap comment
      (the string documenting "if the process dies between ROLLBACK and this
      write..."). This is **not** a proxy for process death and must not be
      framed as one — the design explicitly refuses a "make the write throw"
      test here because that would silently re-assert X3 while appearing to
      cover crash recovery. Cross-check that the same limitation sentence
      exists in `specs/migration-history-integrity/spec.md`'s corresponding
      scenario (it already does, delivered with this change). No mutation
      test is scheduled for I11 — this line exists so a future reader does
      not mistake the omission for an oversight.

- [x] **E5. RED then GREEN — I10, D3's fourth status state.** *(also closes D1's deferred `✗ failed` marker half.)*
      RED: fixture with one applied, one failed (`success = false`), one
      on-disk-only pending migration; `captureLogs(migrateStatus)`; assert one
      `✗ failed` line naming the id, one `✓ applied`, one `· pending`, a
      `1 failed — run ...` footer clause, and `process.exitCode` untouched.
      Fails today: `migrateStatus` (`:518-519`) only distinguishes
      `⚠ modified` / `✓ applied` / `· pending` — no failed state exists, and a
      failure row currently reads as plain `· pending` (harmless today only
      because nothing else marks it either).
      GREEN: add `✗ failed` as `migrateStatus`'s highest-precedence marker
      (`failed > modified > applied > pending`, stated as defensive per D3
      since a filtered `recordedMigrations()` means a failed id can no longer
      reach the `modified`/`applied` branches); the failed count still
      contributes to the existing pending total (a failed migration IS
      pending); append the footer clause only when at least one failure row
      exists; `process.exitCode` stays untouched — `status` reports, `deploy`
      refuses. Confirms I10, and closes E1/D1's status-rendering
      cross-references in I5/R3.
      Test command: `node packages/cli/test/migrate-runner.mjs 2>&1 | rg "status|failed"`

---

## Full-suite verification

- [x] **F1. Run the complete package suite and the workspace build/lint.**
      `pnpm build --filter=@indigodb/cli && pnpm test --filter=@indigodb/cli`,
      then the full `pnpm build && pnpm lint && pnpm test` before landing, per
      this repo's pre-push hook. Confirm the three legacy tests are gone (not
      merely skipped) and the suite's total test count reflects
      `-3 legacy +22 new/extended` scenarios.

- [x] **F2. Re-read design.md's Testing Strategy table against the final test file and tick off all 22 rows (I1–I11, R1–R7, X1–X3) by name in the PR description**, so a reviewer can check row-for-row coverage without re-deriving it.

---

## Review Workload Forecast

Counting **test lines**, not implementation-only (this repo's forecasts have a
documented history of landing at roughly double when they didn't):

| Category | Estimate |
|---|---|
| `migrate-runner.ts` — `ensureHistory` rewrite, shared `HISTORY_UPSERT`, `failedMigrations()`, deploy attempt-tracking + failure write, resolve D7 branch, status fourth state, doc-comment rewrites | ~190–230 changed lines |
| `migrate-runner.mjs` — 3 deleted legacy tests (~20 lines each ≈ 60 lines removed) | −60 lines |
| `migrate-runner.mjs` — 19 new/extended test bodies (I1 ext., I2–I11, R1–R7, X1–X3; X3 and I9 are the largest at ~25–30 lines each, most others 15–25) | ~380–430 added lines |
| `migrate-harness.mjs` — any new fixture helpers (e.g. a `currentUser()` query helper, a `pg_sleep` migration-body builder) | ~15–25 lines |

**Honest total: roughly 600–700 changed lines** (implementation + test
additions + deletions), against a **400-line review budget**. This exceeds
budget by 50–75%, and the gap is almost entirely test volume: 19 new/extended
scenario bodies plus the deleted legacy tests, exactly the category this
repo's forecasts have previously undercounted.

**This does not fit `single-pr` at the stated 400-line budget without either
a split or an explicit exception.** Two options, both real:

1. **Split at the seam between Work Units A–D and Work Unit E.** A–D (schema
   cleanup, shared upsert, filtered readers, deploy refusal gate — no failure
   row is ever written yet) is roughly 300–350 changed lines and is coherent
   on its own: it changes what counts as "applied" without yet changing what
   gets written on failure. E (the failure-row write itself, its
   masking-safety wrapper, and status's fourth state) is roughly 250–300
   lines and is the change the proposal is actually about. This is a real
   functional seam, not an arbitrary line-count cut.
2. **Request `size:exception`** if the single-PR review is preferred as-is —
   this is a one-file, one-purpose change with no cross-package surface, and
   the design document already carries the full row-by-row justification a
   reviewer would otherwise have to reconstruct.

Recommendation: option 1, since it also gives the deploy-refusal behavior
(A–D) a clean bisection point independent of the failure-write mechanics (E)
if either half needs to be reverted.

## Suggested Work Units (with focused test commands)

Each unit's "focused" command re-runs the whole file (the suite has no
per-test filter flag) piped through `rg` on the relevant test names, since
`migrate-runner.mjs` is a plain sequential script, not a framework with
test-selection support.

| Unit | Scope | Focused command |
|---|---|---|
| A — Schema cleanup | I1, I2 | `node packages/cli/test/migrate-runner.mjs 2>&1 \| rg "column set\|backfill\|full column"` |
| B — Shared write + timing (success paths) | I3 (partial), I8, I9 (success half) | `node packages/cli/test/migrate-runner.mjs 2>&1 \| rg "installed_by\|execution_time"` |
| C — Resolve D7 ordering | I3 (closes), R1–R7 | `node packages/cli/test/migrate-runner.mjs 2>&1 \| rg "resolve"` |
| D — Filtered readers + refusal gate | I5, I6, X1, X2a, X2b | `node packages/cli/test/migrate-runner.mjs 2>&1 \| rg "refus\|shadow\|pending"` |
| E — Failure write + status | I4, I9 (failure half), I10, I11, X3 | `node packages/cli/test/migrate-runner.mjs 2>&1 \| rg "failed\|status"` |

Full run before any PR: `pnpm build --filter=@indigodb/cli && pnpm test --filter=@indigodb/cli`.


- [x] **E6. Found by mutation, not planned — X4.** Removing `attempt = null` after `COMMIT`
      left every other test green. Without it, a failure raised after one migration commits
      but before the next is assigned would record the **already-applied** migration as
      failed, which the deploy gate then refuses forever. X4 forces that exact window by
      deleting the next migration's file on the first `COMMIT`, and fails under the mutation.

- [x] **F3. Coverage finding from F2**: `I7a` and `I7b` were in design.md's Testing Strategy
      table but never scheduled as tasks. Both turn out to be covered — I7a by `R3`, I7b by
      `R5/R6` — and the `ON CONFLICT` mutation that left the suite green in Work Unit B now
      fails `R3`. Traceability gap, not a coverage gap; mapped explicitly in apply-progress so
      the coverage is deliberate from here rather than accidental.
