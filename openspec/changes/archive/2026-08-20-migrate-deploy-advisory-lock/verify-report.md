# Verify Report: migrate-deploy-advisory-lock

**Change**: `migrate-deploy-advisory-lock`
**Branch**: `feature/migration-checksum-staleness`
**Verified commit**: `a940ce2` — "feat(cli): serialize migrate deploy with a session advisory lock"
(Later commit `2bf1650` closes out unrelated `migration-checksum-staleness` openspec archive bookkeeping — not part of this change's diff.)
**Mode**: Full artifacts (proposal #657, exploration #656, spec #658, design #659, tasks #660, apply-progress #661)
**Verdict**: **PASS**

## Completeness

| Item | Status |
|---|---|
| Proposal | Present, in scope, consistent with implementation |
| Exploration | Present, technical findings used as-is in design |
| Spec (`migrate-deploy-concurrency`) | Present, 5 requirements / 8 scenarios |
| Design | Present, all technical decisions match code |
| Tasks | 15/15 checkboxes complete (14 slice tasks + 1 post-slice cleanup) |

## Build / Test Evidence (run fresh in this session)

| Command | Result |
|---|---|
| `pnpm --filter @indigodb/cli build` | PASS |
| `pnpm --filter @indigodb/cli lint` (`tsc --noEmit`) | PASS |
| `pnpm --filter @indigodb/cli test` | PASS — all cases green, including 4 new advisory-lock cases |
| `pnpm build` (full workspace) | PASS |
| `pnpm lint` (full workspace) | PASS |
| `pnpm test --force` (full workspace) | 1 pre-existing failure: `@indigodb/compiler` regression harness, fixture `13-ambiguous-relations.indigo`, `ValidationError[]` array-ordering mismatch. Confirmed to be the same pre-existing flake already documented on `main` (unrelated to this change — compiler/Rust code untouched). No new failures. |
| `cd crates && cargo test` | PASS — 36 + 1 doc-tests passed, 0 failed |

## Spec Compliance Matrix (`migrate-deploy-concurrency`)

| # | Requirement | Evidence | Status |
|---|---|---|---|
| 1 | Session-level `pg_try_advisory_lock` acquired before `ensureHistory`/`checksumPreflight`/any pending apply, well-known non-configurable int64 key | `migrate-runner.ts:357` (`SELECT pg_try_advisory_lock($1)`) runs before `ensureHistory` at line 365; `MIGRATION_LOCK_KEY = 80_600_501_929_807` (`migrate-runner.ts:52`), no param/flag/env controls it. Test: "migrateDeploy acquires pg_try_advisory_lock first and releases pg_advisory_unlock last" — PASS | PASS |
| 2 | Fail-fast refusal on contention: `process.exitCode=1`, clear message, no throw, no block/wait/retry/timeout | `migrate-runner.ts:358-362` — checks boolean, logs `❌ migrate deploy refused: another deploy already holds the migration lock`, sets `exitCode=1`, `return` (no throw). Test: "migrateDeploy refuses when the advisory lock is already held (contention)" asserts exitCode, message content, no "rolled back" text, and that `ensureHistory` never ran (history table doesn't exist) — PASS | PASS |
| 3 | Lock released via `pg_advisory_unlock` on success and failure paths; not released if never acquired | `migrate-runner.ts:398-402` — `finally` block, `if (locked) { unlock }` before `client.end()`. Tests: happy-path ordering (unlock is last query) and "still releases the advisory lock when a pending migration fails mid-loop" (unlock called exactly once after invalid-SQL throw) both PASS. Contention test asserts zero unlock calls when never acquired — PASS | PASS |
| 4 | `migrate dev` / `migrate status` unaffected, no lock calls | Read `migrateDev` (`migrate-runner.ts:288-348`) and `migrateStatus` (`migrate-runner.ts:413+`) in full — zero advisory-lock SQL in either function body; `grep -n advisory` across `migrate-runner.ts` confirms only 2 call sites, both inside `migrateDeploy`. Test: "migrateDev and migrateStatus never touch the advisory lock (deploy-only scope)" — PASS | PASS |
| 5 | No flag/env/config bypass of the lock | `grep -in "MIGRATION_LOCK\|SKIP_LOCK\|NO_LOCK\|--no-lock\|LOCK_BYPASS\|bypass"` across `packages/cli/src` — no matches besides the constant itself; `grep process.env` in `migrate-runner.ts` shows only the pre-existing unrelated `INDIGODB_MIGRATE_PREV` var, nothing lock-related. Verified structurally (proving an absence); no dedicated runtime test exists for this negative claim, which is appropriate for a "no such surface exists" requirement | PASS |

## Design Coherence

All architecture decisions in design #659 verified against code as-implemented: lock key value and ASCII "INDIGO" derivation comment, `pg_try_advisory_lock` (not blocking/xact variant), lock acquired before `ensureHistory` (not after `checksumPreflight`), refusal via `return` not `throw`, unlock return value ignored, `spyMigrationClient(inner, { onQuery })` harness helper shape, and deploy-only scope. No deviations found.

## Task Completion

All 15 checkboxes in `openspec/changes/migrate-deploy-advisory-lock/tasks.md` marked `[x]`, matching the actual code and test state (RED tasks 1.1-1.5 correspond to harness helper + 4 new test cases now present and passing; GREEN tasks 1.6-1.9 correspond to constant/acquire/release/header doc now present in `migrate-runner.ts`; VERIFY/COMMIT tasks 1.10-1.14 and cleanup 2.1 all independently confirmed in this session).

## Issues

- **CRITICAL**: 0
- **WARNING**: 0
- **SUGGESTION**: 0

## Notes

- The PGlite advisory-lock test-coverage gap (upstream issue #704) is documented in-repo as a comment in `packages/cli/test/migrate-runner.mjs` (lines 461-468), matching the spec's Non-Normative Notes section and the proposal's stated risk.
- The one full-workspace test failure is a pre-existing, unrelated flake in `@indigodb/compiler`'s golden-snapshot regression harness (array-ordering in `ValidationError[]` for the ambiguous-relations fixture) — no Rust or compiler files are touched by this change, and `cargo test` itself is fully green.

## Final Verdict: PASS
