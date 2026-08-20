# Verify Report: migration-checksum-staleness

Branch: `feature/migration-checksum-staleness` (not on `main`, not pushed). Commits: 224ec78 (sdd artifacts), 8c25f0e (Slice 1), 28f87d9 (Slice 2).

## Verdict: PASS

CRITICAL: 0 · WARNING: 0 · SUGGESTION: 1

## Completeness

All tasks (1.1–1.14, 2.1–2.18, 3.1 = 33 items) are checked in `openspec/changes/migration-checksum-staleness/tasks.md` and match the actual code state — verified by reading source directly, not by trusting the checkmarks.

## Diff scope

```
packages/cli/package.json             |   2 +-
packages/cli/src/migrate-runner.ts    | 261 ++++++++++++++-----
packages/cli/test/migrate-harness.mjs |  68 +++++
packages/cli/test/migrate-runner.mjs  | 454 ++++++++++++++++++++++++++++++++++
packages/migrator/src/shadow.ts       |  34 ++-
packages/migrator/test/shadow.mjs     |  84 ++++++-
6 files changed, 835 insertions(+), 68 deletions(-)
```
Matches the design's File Changes table exactly — no scope creep, no Rust/compiler files touched.

## Test evidence (run fresh, this session)

| Command | Result |
|---|---|
| `node packages/cli/test/migrate-runner.mjs` | PASS — 11/11 cases green (schema/backfill, dev/deploy record checksum+success, dev refuses on drift, deploy preflight refuses before applying pending, deploy applies clean pending normally, status ⚠ modified / ✓ applied, exit 0 for status) |
| `node packages/migrator/test/shadow.mjs` | PASS — all cases green including new C.12 (drift refusal, names id) and C.13 (matching checksums replay clean; null stored checksum skips comparison) plus pre-existing C.8–C.11 unchanged |
| `pnpm --filter @indigodb/migrator build/lint/test` | PASS (exit 0) |
| `pnpm --filter @indigodb/cli build/lint/test` | PASS (exit 0) |
| `pnpm build` (root) | PASS |
| `pnpm lint` (root, tsc --noEmit per package) | PASS |
| `pnpm test` (root) | 1 pre-existing failure: `@indigodb/compiler#test` — fixture `13-ambiguous-relations.indigo` `ValidationError[]` ordering mismatch. **Confirmed also fails identically on `main`** (reproduced by checking out `main` and running `node packages/compiler/test/parity.mjs` directly — same diff, same fixture). Unrelated to this change: no compiler/Rust/WASM files are touched by this diff. |
| `cd crates && cargo test` | PASS (exit 0) — expected, since no `crates/` files are touched |

## Spec compliance — `migration-history-integrity` (NEW)

| Requirement | Scenario | Evidence | Status |
|---|---|---|---|
| Records checksum + success columns | Fresh install creates full column set | `ensureHistory` CREATE TABLE 5-column shape; test "fresh install: ensureHistory creates checksum + success columns" | PASS |
| | Existing table upgraded in place | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` x2; test "legacy 3-column table: ensureHistory adds checksum + success via ALTER" | PASS |
| Checksum is sha256 hex of exact bytes | Applying a migration records its content checksum | `migrationChecksum()` via `node:crypto` `createHash("sha256")`; tests "migrateDev records checksum..." / "migrateDeploy records checksum..." | PASS |
| Legacy table silently backfills | No prompting | `ensureHistory`'s backfill loop, no `console.log`/prompt call in that path; test "legacy row with NULL checksum is silently backfilled..." | PASS |
| | Backfill trusts current content once, idempotent | test "backfill is idempotent: a second ensureHistory call touches zero rows" | PASS |
| deploy refuses on drift before applying any pending | Deploy refuses on edited applied migration | `checksumPreflight` runs before `appliedMigrations`/pending loop in `migrateDeploy`; test "migrateDeploy preflight refuses... before applying any pending migration" | PASS |
| | Deploy proceeds with no drift | test "migrateDeploy with no drift applies pending migrations normally" | PASS |
| Checksum drift is hard refusal, no override | No bypass flag/env/config | grepped `packages/cli/src`, `packages/migrator/src` for bypass/force/skip-checksum/override patterns — zero hits related to drift enforcement; `checksumPreflight`/4th desync rule have no conditional escape path in source; test 2.10 explicitly asserts no override changes behavior | PASS |
| status reports drift non-fatally | Status reports drifted row, exit 0 | `migrateStatus` never touches `process.exitCode`; test "migrateStatus prints ⚠ modified... exit 0" | PASS |
| | Status reports clean history | Same test covers ✓ applied rows | PASS |
| success recorded, forward-compatible, no enforcement | Successful migrations record success=true | Both INSERT statements in `migrateDev`/`migrateDeploy` pass literal `true` | PASS |
| | Failed migration still leaves no row | `migrateDev` catch block still `rmSync`s the dir on failure (unchanged); `migrateDeploy` catch still ROLLBACKs (unchanged) — no new success=false write path introduced anywhere | PASS |

## Spec compliance — `shadow-database-replay` (DELTA)

| Requirement | Scenario | Evidence | Status |
|---|---|---|---|
| MODIFIED: order divergence doc | header/jsdoc rewritten, "no stronger signal" claim removed | `shadow.ts` lines 14-19 rewritten to state order divergence and checksum drift are independent signals; `buildShadowSchema` jsdoc lines 133-149 updated with 4th bullet | PASS |
| ADDED: checksum mismatch on recorded migration → hard refusal | Editing an applied migration's SQL blocks next `migrate dev` | 4th desync rule in `buildShadowSchema` (lines 178–187), `ShadowReplayError` naming drifted ids; shadow.mjs C.12; cli migrate-runner.mjs "migrateDev refuses when an applied migration's on-disk file has drifted" | PASS |
| | Unmodified recorded migrations replay without diagnostic | shadow.mjs C.13; `null` stored checksum skips comparison, verified explicitly in C.13's assertion | PASS |

## Product decisions verification (source-level, not narrative)

1. **Legacy DB silent backfill** — `ensureHistory`'s backfill loop (migrate-runner.ts:145-157) contains no prompt/confirmation call; runs unconditionally against `WHERE checksum IS NULL` rows. Confirmed by test.
2. **Drift = hard refusal, zero override surface** — grepped both `packages/cli/src` and `packages/migrator/src` for bypass/force/env-var patterns (`BYPASS|SKIP_CHECKSUM|IGNORE_DRIFT|--force|FORCE_|NO_CHECKSUM|override`); zero hits tied to checksum/drift enforcement (the few `override` hits are unrelated `@db.X` native-type-override and `--url` connection-string override, pre-existing features). `checksumPreflight` and the 4th desync rule have unconditional refusal paths with no env/flag read anywhere.
3. **`success` column added and populated `true` on every insert** — confirmed both `migrateDev` and `migrateDeploy` INSERT statements pass `true` literally; DDL default is also `true`.
4. **Failure-mode asymmetry** — `migrateDev` and `migrateDeploy` both call `process.exitCode = 1` (dev via the `ShadowReplayError` catch, deploy via the `checksumPreflight` refusal branch) and `return` before any mutation; `migrateStatus` never assigns `process.exitCode` anywhere in its function body — confirmed by direct source read of all three functions and by tests exercising each path (exitCode assertions present in the migrate-runner.mjs drift-refusal and status tests).

## Design coherence

- Hashing lives only in `packages/cli` (`node:crypto`); `packages/migrator/src/shadow.ts` never imports `node:crypto`/`node:fs`/`pg` — confirmed, only comparison of caller-supplied strings. Seam boundary intact.
- `MigrationSource` gained `checksum(id)` and `recordedChecksums` as REQUIRED (non-optional) fields, matching design's "optional fails open" rejection — confirmed in the interface declaration and in task 2.1 forcing every existing test double to update.
- Deploy-path error handling matches design exactly: no throw, `process.exitCode = 1`, `return` — avoids being mislabeled by the existing `catch` block's "Deploy failed, rolled back" message, exactly as the design's rejected-alternatives table calls out.
- CRLF: no newline normalization introduced; raw bytes hashed, per design decision.
- Slice split matches the design's Slice Plan and the tasks' Suggested Work Units exactly (commit 8c25f0e = Slice 1 seam+schema+harness, no enforcement; commit 28f87d9 = Slice 2 enforcement+reporting).

## Issues

**SUGGESTION (1)**:
- The two slices are committed directly to `feature/migration-checksum-staleness` rather than as separate reviewable PRs against a chain (`PR 1` → `PR 2` as the tasks/design's chain-strategy describes). Functionally equivalent and both slices are independently green, but the review-workload chaining intent (two smaller diffs, ~400 and ~350 lines) was not realized as actual GitHub PRs — this branch has not been pushed or opened as a PR at all yet. Recommend opening the PR(s) before merge per the `auto-chain` delivery strategy, splitting at the Slice 1/Slice 2 commit boundary if reviewer load is a concern (835 lines total, of which ~522 are new test file lines).

No CRITICAL or WARNING issues found.

## Root `pnpm test` compiler flake — confirmed pre-existing and unrelated

Reproduced independently on `main` (clean checkout, no working-tree changes) via `node packages/compiler/test/parity.mjs`: identical failure, same fixture (`13-ambiguous-relations.indigo`), same ordering diff. This diff touches zero files under `packages/compiler` or `crates/`, so it cannot be the cause. Does not block this verdict.
