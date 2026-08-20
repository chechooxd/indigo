# Verification Report: migrate-dev-create-only

Branch: `feature/migrate-dev-create-only` @ `e60407c`, branched from `main` @ `9d6ea6d` (verified via `git log`/`git branch -a`; not merged, not pushed). Diff vs main: 706 lines total (openspec docs 372 + authored code/test 337: index.ts +11/-3 minus context, migrate-runner.ts +20, migrate-runner.mjs +306). Well under 800-line budget; matches design's ~170-line src+test estimate closely (306 realized vs ~150 estimated test lines — larger but still low risk, single slice, no chaining needed per tasks.md forecast).

## Task Completeness

All 16 tasks (`openspec/changes/migrate-dev-create-only/tasks.md`) checked `[x]`: 1.1-1.6 RED, 1.7-1.10 GREEN, 1.11 rerun, 1.12 regression case, 1.13-1.14 VERIFY, 1.15 COMMIT, 2.1 post-slice confirmation. TDD RED→GREEN order followed per apply-progress narrative and matches the checklist shape.

## Spec Compliance Matrix (7 requirements, 12 scenarios — capability `migration-plan-apply-separation`)

| Requirement | Scenario | Evidence | Status |
|---|---|---|---|
| Accepts `--create-only` flag | Flag is recognized | `index.ts:153` `.option("--create-only", ...)`; every create-only test case runs without "unknown option" error | PASS |
| Full pre-flight unchanged | Diagnostics still refuse before file written | test "diagnostics still refuse before any file is written" (line 1065) — PASS at runtime | PASS |
| Full pre-flight unchanged | requires-force refuses without --force | test "a requires-force statement still refuses without --force" (line 1119) — PASS | PASS |
| Full pre-flight unchanged | `--create-only --force` writes plan with requires-force statements | test line 1164 — PASS, asserts file written + zero history rows | PASS |
| Writes file, skips commit-phase | File written, DB untouched | test line 976 — PASS, asserts file exists, `historyRows` empty, no `.snapshot.json` | PASS |
| Writes file, skips commit-phase | Distinct success message | test line 1004 — PASS, regex `/created \(not applied\)/` present, `/created and applied/` absent | PASS |
| (implicit) no commit SQL | n/a (design-mandated, extra coverage) | test line 1032 via `spyMigrationClient` — PASS, zero BEGIN/COMMIT/INSERT | PASS (extra) |
| File later applicable unchanged | `migrate status` reports pending | test line 1204 (hand-off) — PASS | PASS |
| File later applicable unchanged | `migrate deploy` applies the pending file | same hand-off test — PASS, asserts 1 history row, checksum matches on-disk bytes via shared `renderMigrationSql`/`migrationChecksum` | PASS |
| Default unchanged | Plain `migrate dev` remains atomic | test line 1245 "regression guard" — PASS | PASS |
| Still requires live DB connection | Connection failure refuses identically | No dedicated test exists (either mode) simulating a raw connect() rejection. Structurally trivial: `client = await (options.createClient ?? ...)()` runs unconditionally before ANY createOnly branching (which only exists after `writeFileSync`, line 376) — the two modes cannot behave differently here by construction. | WARNING (untested, structurally low-risk, pre-existing gap) |

## Design Coherence

- Seam location: confirmed live — `if (options.createOnly) { ...; return; }` at migrate-runner.ts:376-381, exactly between `writeFileSync` (374) and the commit-phase `try` (383).
- `ensureHistory` still runs unconditionally for both modes (line 327, before any branching).
- Skipped set is exactly `applyMigrationSql`, history INSERT, COMMIT, `saveSnapshot` — all inside the untouched inner `try` at 383, never reached under createOnly.
- No `rmSync`/`ROLLBACK` on the createOnly path — matches design ("failure cleanup: none").
- Reused `renderMigrationSql(plan)` — byte-identity guaranteed structurally.
- `finally { client.end() }` (400-402) unconditionally covers both exits.
- Destructive/`--force` gate (357-368) confirmed to run BEFORE `mkdirSync`/`writeFileSync` (370-374), which run BEFORE the createOnly branch (376).
- Output message: exact 3-line format matches design's specified block verbatim (377-379).
- Advisory lock: `MIGRATION_LOCK_KEY` (migrate-runner.ts:53) used ONLY inside `migrateDeploy` (acquire 412, release 475) — confirmed via grep, zero references in `migrateDev`.
- CLI wiring: `index.ts:154` widened action type, threaded as `createOnly: options.createOnly` (163).

## Test/Build Evidence (run fresh, this session)

| Command | Result |
|---|---|
| `pnpm --filter @indigodb/cli build` | exit 0, clean |
| `pnpm --filter @indigodb/cli lint` (`tsc --noEmit`) | exit 0, clean |
| `pnpm --filter @indigodb/cli test` | exit 0 — "cli migrate-runner: all green", all 8 create-only-related cases pass individually |
| `pnpm build` (full workspace) | exit 0, 10/10 tasks successful |
| `pnpm lint` (full workspace) | exit 0, 18/18 tasks successful |
| `pnpm --filter @indigodb/migrator test` | exit 0, all green |
| `pnpm --filter @indigodb/generator test` | exit 0, all green |
| `pnpm --filter @indigodb/client test` | exit 0, all green (incl. adapters/adapters-pg) |
| `pnpm test` (turbo aggregate) | `@indigodb/compiler#test` FAILS at fixture `13-ambiguous-relations.indigo` — array-order mismatch in `ValidationError[]`; turbo cascades ELIFECYCLE noise into siblings, but each package independently confirmed green above. Same pre-existing, order-dependent, non-deterministic flake noted in apply-progress (#678); unrelated to this change. |
| `cd crates && cargo test` | exit 0 — 36 (fixture corpus) + 1 (parser_panic) + 0 doc-tests = 38 tests pass, 0 failed. Reinforces the compiler flake is TS-harness-only. |

## Issues

**CRITICAL**: none.

**WARNING** (1):
1. Spec Requirement "`--create-only` still requires a live database connection," scenario "Connection failure refuses the command," has no dedicated covering test in either mode. Structurally near-zero risk (shared unconditional code path), but flagged per the untested-scenario rule. Pre-existing gap, not introduced by this change.

**SUGGESTION** (1):
1. The pre-existing `@indigodb/compiler` regression-harness flake (`13-ambiguous-relations.indigo` diagnostic array ordering) continues to make `pnpm test` (full aggregate) exit non-zero even though nothing in this change touches the compiler. Consider order-independent comparison for `ValidationError[]` or fixing non-deterministic diagnostic ordering — out of scope here, tracked as debt.

## Verdict

**PASS WITH WARNINGS** — CRITICAL: 0, WARNING: 1, SUGGESTION: 1.

All 16 tasks complete, all spec requirements implemented and matched against live code, all design decisions confirmed against the actual file bytes, default (`migrate dev` without the flag) behavior spot-checked unchanged, destructive-gate-before-write ordering confirmed correct, advisory-lock non-interaction confirmed via grep, hand-off scenario confirmed to genuinely exercise `migrate status` + `migrate deploy`. Fresh test/build/lint runs are green across every touched and adjacent package; the one aggregate-level failure is the same pre-existing, unrelated `@indigodb/compiler` flake, now additionally confirmed clean on the Rust side (`cargo test`: 38/38 pass). Not merged/pushed — awaiting archive.
