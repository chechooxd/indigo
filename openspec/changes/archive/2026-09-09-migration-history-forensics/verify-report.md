```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:73fc4c03f332ada19bc3b4e2880e6799479fdfe52504c215a5300084a74ae9ce
verdict: pass
blockers: 0
critical_findings: 0
requirements: 5/5
scenarios: 18/18
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:dcf13e46763426f5eb5be2e42a47a16442ed58a21862e01f4d97afd2d06542c2
build_command: pnpm clean && pnpm build --force
build_exit_code: 0
build_output_hash: sha256:c3d4305ada2befda5662a7b72c19d5b6532de8813c4ba1faabd9d92237625a35
```

## Verification Report

**Change**: migration-history-forensics
**Version**: N/A (pre-publish, v0.0.1)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 24 |
| Tasks complete | 24 |
| Tasks incomplete | 0 |

### Build & Tests Execution
**Build**: PASS
```text
pnpm clean && pnpm build --force → 11/11, exit 0
```

**Lint**: PASS
```text
pnpm lint → 21/21, exit 0 (apps/studio uses `tsc -b --noEmit`, confirmed in log)
```

**Tests**: PASS
```text
pnpm test → 20/20 turbo tasks, exit 0
@indigodb/cli:test → "cli migrate-runner: all green" (392 `ok` lines), "cli resolveAllowedOrigins: all green"
DB-gated realtime/studio-query-timeout-pg suites SKIP as documented (INDIGODB_TEST_DATABASE_URL unset)
```

**Coverage**: not available (no coverage tool configured in this repo)

### Mutation Re-Verification (6 of 16 logged mutations, spanning all 5 work units A–E)

Every mutation below was independently re-applied to the real source tree, confirmed present
via `git diff`, rebuilt (`pnpm build --filter=@indigodb/cli`), run against
`node packages/cli/test/migrate-runner.mjs`, then reverted (`git checkout`) with a clean
`git diff --stat -- packages/cli` afterward.

| # | Work Unit | Mutation | Expected break | Observed | Match |
|---|-----------|----------|-----------------|----------|-------|
| 1 | A | Renamed `installed_by`/`execution_time_ms` columns in the DDL | I1 fails, I2 unaffected | `FAIL I1 fresh install: ensureHistory creates the full seven-column shape` (real assertion, named columns) — I2 `ok` | ✅ |
| 2 | B | `installed_by` from a client literal `'indigodb'` instead of `current_user` | I8 fails, I3/I9 unaffected | `FAIL I8 installed_by is recorded from current_user...` (real assertion) — I3/I9 `ok` | ✅ |
| 3 | C | Removed the `ON CONFLICT (name) DO UPDATE` clause entirely | R3 fails | `FAIL R3 resolve --applied flips a matching failure row to success` | ✅ |
| 4 | D | Deploy refusal gate checks only `pending[0]` instead of every pending id | I6 fails | `FAIL I6 deploy refuses when ANY pending id carries a failure row` | ✅ |
| 5 | E | Disabled the failure-row write (`if (false && attempt)`) | I4/I9 and X3 both fail | `FAIL I4/I9 a failed deploy records success = false...`, `FAIL X3 a failing failure-write warns...` | ✅ |
| 6 | E | Rethrow from the inner failure-write `catch` (X3's masking-safety guard) | X3 fails alone; I4/I9, I10 stay green | `FAIL X3 ...`; `I4/I9 ok`, `I10 ok` | ✅ |

All six mutations reproduced exactly as `apply-progress.md`'s TDD Cycle Evidence tables claim,
broke a real `expect`/assertion (not a crash), and did not bite anything outside their named
test. Tree confirmed clean (`git diff --stat -- packages/cli` empty) and full suite re-verified
green after every revert.

One procedural note from this re-verification: a first attempt to apply mutation 1 via `sd`
with a multi-line pattern silently matched nothing (0 changes, file unchanged) — caught only
because the mutation-application step is verified via `git diff` before running tests, per this
change's own recorded methodology note in Work Unit E ("a mutation that was never applied looks
identical to one that did not matter"). Switched to single-line `sd` invocations / a Python
literal replace for the remaining mutations, each confirmed via `git diff` before build+test.

### X3 — the single most consequential behaviour (source inspection)

Read `packages/cli/src/migrate-runner.ts:566-581` directly:
- The failure-row write sits in its own inner `try { HISTORY_UPSERT } catch (recordError) { ... }`
  (`:568-580`), separate from the outer `catch (error)` that already holds the real migration
  error.
- The `catch (recordError)` block **never rethrows** — confirmed by reading every statement in
  the block (two `console.error` calls only).
- It **never touches `process.exitCode`** — grep for `process.exitCode` inside the block returns
  nothing; `process.exitCode = 1` is set once, at `:584`, from the outer catch, driven by the
  original migration `error`, not `recordError`.
- The `⚠️  Could not record the failure of ...` warning (`:576-579`) prints **before** the
  `❌ Deploy failed, rolled back: ...` line (`:583`) — confirmed by reading the statement order:
  the inner try/catch completes, THEN the outer catch continues to the `console.error("❌ Deploy
  failed...")` line. The operator's last line is always the real cause.
- Mutation 6 above independently confirms this at runtime: forcing a rethrow from the inner
  guard breaks X3 alone, proving the guard is load-bearing for exactly this property.

**Confirmed as specified. No CRITICAL finding here.**

### Spec Compliance Matrix

18/18 scenarios across both delta specs map to a test that exercises the branch it names.
Full row-for-row mapping is `apply-progress.md`'s F2 table (independently spot-checked below);
summarized:

| Requirement | Scenarios | Status |
|-------------|-----------|--------|
| `_indigo_migrations` full column set, no backfill (integrity) | 2/2 | ✅ COMPLIANT (I1, I2 — mutation-verified above) |
| `success` gates applied-state, enforced on failure path (integrity) | 9/9 | ✅ COMPLIANT (I3–I11; I4/I6/I8/X3 mutation-verified above; I11 is a documented non-test, correctly so — see below) |
| `--applied <id>` records without executing SQL (resolve) | 2/2 | ✅ COMPLIANT (R1, R2) |
| `--applied <id>` on a failure row explicitly resolves it (resolve) | 2/2 | ✅ COMPLIANT (R3 mutation-verified above; R4) |
| `--rolled-back <id>` deletes and is idempotent (resolve) | 3/3 | ✅ COMPLIANT (R5, R6, R7 — spec scenario "deletes a failure row the same way as a success row" IS satisfied by R5/R6; see WARNING below re: a *design-level* traceability claim that goes further than this spec scenario requires) |

**Compliance summary**: 18/18 scenarios compliant.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| Single `CREATE TABLE IF NOT EXISTS`, no `ALTER TABLE` | ✅ Implemented | `migrate-runner.ts:175-187`; no `ALTER TABLE` anywhere in the file (`rg` confirms) |
| Branch order in `resolve --applied` (drift checked above success split) | ✅ Implemented | `migrate-runner.ts:694-720`, comment explicitly states the ordering is load-bearing (D7); confirmed by mutation log's R4 mutation (moving the test would flip R3/R4) |
| Deploy refusal checks every pending id, not just the next | ✅ Implemented | `migrate-runner.ts:506-518`; mutation 4 above independently confirms |
| `installed_by` from server-side `current_user`, never client-supplied | ✅ Implemented | `HISTORY_UPSERT` (`:65-73`) hardcodes `current_user` in the VALUES clause; no parameter accepts an override |
| I11 mid-crash gap documented, not tested as a guarantee | ✅ Implemented | Code comment `migrate-runner.ts:561-565`; spec.md lines 32 and 87; test at `migrate-runner.mjs:1500` asserts only that the comment string exists in both files, explicitly disclaiming any process-death coverage in its own header comment |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 — timing brackets `applyMigrationSql` only | ✅ Yes | `migrate-runner.ts:441-443` (dev), `:542-546` (deploy) |
| D5 — attempt tracked outside `try`, set after file read, cleared after COMMIT | ✅ Yes | `:473`, `:543`, `:548`; X4 (found by mutation, not planned) independently proves `attempt = null` is load-bearing |
| D6 — refusal gate checks ALL pending ids | ✅ Yes | `:506-518`, mutation-verified |
| D7 — drift check above success/failure split in resolve | ✅ Yes | `:699-720`, mutation-verified via R4 in the historical log |
| X2a's design premise (deploy-only gate) | ⚠️ Corrected during apply | Design assumed `migrate dev` would NOT refuse; apply found a pre-existing shadow-replay guard (`shadow.ts:199`) that DOES refuse it once `recordedMigrations()` filters on success. Documented in apply-progress and X1 rewritten to assert the true property. This is a design-note correction in the safer direction, not a defect. |
| One accepted behaviour change (design.md:359-364) — same-second `migrate dev` collisions now upsert instead of raising a unique violation | ✅ Documented, not tested as a scenario (by design) | Consistent with the design's own "accepted and documented; not fixed here" framing |

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. **`apply-progress.md`'s F3 claims I7b ("retry after `--rolled-back` re-inserts cleanly") is "covered anyway" by R5/R6 — it is not.** Design.md (`:388`) specifies I7b as: seed a failure row → `migrateResolve --rolled-back` → `migrateDeploy` succeeds → assert exactly one fresh row with `success === true`. `R5/R6` (`migrate-runner.mjs:1942-1990`) only exercises the delete half (`--rolled-back` on a success row and a failure row, asserting deletion and message-identity) — no test in the suite calls `migrateDeploy` (or re-inserts via any path) after a `--rolled-back` call (confirmed by `rg -n "rolledBack"` — every call site is followed only by more `migrateResolve`/assertion code, never `migrateDeploy`). This is a traceability inaccuracy in F2/F3, not a spec gap: the actual spec scenario at `specs/migration-history-resolve/spec.md:50` ("Rolled-back resolve deletes a failure row the same way as a success row") only requires deletion-parity, which R5/R6 does prove. But design.md's own Testing Strategy row I7b is broader than that spec scenario and is, in fact, unproven — the mutation it names ("the re-insert collides") cannot even occur in the current code, since `--rolled-back` deletes the row first and a subsequent plain `INSERT` (or the existing upsert) would never hit `ON CONFLICT` regardless. Recommend either writing the actual I7b scenario as a real test, or correcting design.md/apply-progress to state plainly that I7b is structurally unreachable-to-collide rather than "covered anyway" by an unrelated test. This is the "third" scenario-coverage gap referenced in the verification brief — apply-progress caught two (I5, X2b) but not this one.
2. **`execution_time_ms integer` can overflow on a pathologically long-running migration.** Postgres `integer` is 32-bit signed, capping the column at ~24.8 days of elapsed milliseconds. Neither `design.md` nor either spec addresses this. In practice a single migration statement running that long is implausible, but it is an unaddressed edge (raised in the verification brief's item 7) with no documented stance either way — worth a one-line note in the design or a `bigint` column if the maintainer wants to formally close it. Not blocking; no test claims coverage here either way.

**SUGGESTION**:
1. `resolve --rolled-back <id>` on a failure row whose on-disk `migrations/<id>/migration.sql` file is also missing is refused with `"unknown migration id"` (the file-existence guard at `migrate-runner.ts:674` runs before the applied/rolled-back branch), leaving an orphan row that no command can clear. This is **already explicitly documented** as a known, accepted, low-risk edge in `design.md:423` ("An orphan failure row whose directory was deleted cannot be cleared | Low | Named as a benign edge in D6..."), so this is recorded here only as independent confirmation per the verification brief's item 7, not a new finding.
2. Two `migrate dev` runs in the same second with the same name now upsert instead of raising a unique-constraint violation. Also already documented as an accepted, deliberate behaviour change (`design.md:359-364`) — confirmed present and consistent with that note, not a new finding.

### Verdict
**PASS WITH WARNINGS**
All 24 tasks complete, all 18 spec scenarios have a mutation-provably-covering test, X3's masking-safety guarantee is confirmed by both source inspection and independent runtime mutation, and the full build/lint/test gate is green (exit 0 across all three). The two WARNINGs — a traceability inaccuracy in the I7b coverage claim (spec-level behavior is still correct and provably deletion-parity-tested; only the broader design-level test-strategy claim is unproven) and an undocumented `integer` overflow edge on `execution_time_ms` — do not block archive but should be corrected or explicitly accepted before this report is treated as final.
