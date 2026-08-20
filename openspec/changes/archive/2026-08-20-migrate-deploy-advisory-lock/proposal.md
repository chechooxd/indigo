# Proposal: Advisory Lock Around `migrate deploy`

Change: `migrate-deploy-advisory-lock` (Road to 1.0, Phase 3, epic "Introspection — `indigodb db pull`", task 4/8). One focused slice, not the epic.

## Context

Working tree is on `feature/migration-checksum-staleness` (task 3/8), which is complete in SDD terms but **not merged to `main`** (3 unmerged commits). `checksumPreflight` and the checksum columns exist in this tree, not on `main`. Whether apply branches from this feature branch or waits for a merge to `main` is an open delivery question for the user — this proposal does not resolve it.

## Intent

`migrateDeploy` (`packages/cli/src/migrate-runner.ts:341`) has zero concurrency protection. Two racing runs (two CI jobs, or CI racing a manual deploy) both read the same `pending` set and both apply. `_indigo_migrations.name UNIQUE` accidentally blocks a literal duplicate insert, but not interleaved application of *different* migrations or partial DDL races. Every comparable tool (Flyway, golang-migrate) takes a session-level advisory lock; the epic names the mechanism explicitly.

## Scope

### In Scope
- Session-level `pg_try_advisory_lock($1)` acquired in `migrateDeploy` right after connect, before `ensureHistory`/`checksumPreflight`.
- `pg_advisory_unlock($1)` released in the existing `finally`, alongside `client.end()`.
- A single well-known constant int64 lock key, documented, not user-configurable.
- Fail-fast refusal on contention: `process.exitCode = 1`, clear `❌` message naming the lock conflict, no partial apply — same shape as the `checksumPreflight` refusal (line 348-354).
- Tests asserting lock SQL, key, and call ordering via a spy `MigrationClient`.

### Out of Scope
- `migrateDev` and `migrateStatus` — deploy-only, matching the dev/deploy asymmetry precedent from `migration-checksum-staleness`.
- Blocking waits, timeouts, retries, or any new CLI flag.
- Stale/dead-lock-holder detection or diagnostics.
- Task 5/8 destructive-statement classification; `db pull`.
- Changing which SQL gets applied, or the `MigrationClient` interface shape.

## Capabilities

### New Capabilities
- `migrate-deploy-concurrency`: lock acquisition/release lifecycle, key definition, contention refusal semantics, deploy-only boundary.

### Modified Capabilities
- None.

## Approach

Exploration approach 1. Session-level (not `pg_advisory_xact_lock`) because `migrateDeploy` holds one connection across many per-migration `BEGIN`/`COMMIT` transactions — a transaction lock would release after the first migration. Both calls ride the existing `MigrationClient.query(sql, params?)` seam; no interface change. Crash-safety relies on Postgres auto-releasing session locks on disconnect — the same guarantee Flyway and golang-migrate accept.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modified | lock constant + acquire/release in `migrateDeploy`; header doc |
| `packages/cli/test/migrate-runner.mjs` | Modified | spy-based lock ordering/refusal tests |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **PGlite cannot test true contention** — open upstream issue #704: `pg_advisory_lock` does not block on re-acquisition; PGlite is also single in-process, so racing connections aren't simulable | High | Stated openly as an accepted coverage gap. Test the SQL invocations/order/key via a spy `MigrationClient`, not real blocking. Real-Postgres verification stays manual/out of harness |
| Unreleased lock after a crashed process | Low | Postgres releases session locks on disconnect; no app-level reaper |
| Single constant key over-serializes if one DB ever hosts multiple migration sets | Low | Not the current architecture (one `_indigo_migrations` per DB); revisit if that changes |
| Scope creep into task 5/8 | Medium | Lock acquire/release only; no change to applied SQL |

## Rollback Plan

1. Remove the two `client.query` lock calls and the constant — `migrateDeploy` returns to today's behavior exactly.
2. No schema change, no on-disk file change, no persisted state; advisory locks vanish with the session.

## Dependencies

- Builds on `migration-history-integrity` (`checksumPreflight`) for refusal-message and exit-code convention. Merge state of that branch is unresolved (see Context).

## Success Criteria

- [ ] A second `migrate deploy` against a locked database refuses immediately with a message naming the lock conflict, applying nothing
- [ ] The lock is acquired before `ensureHistory` and released before/with `client.end()`, including on the error path
- [ ] `migrate dev` and `migrate status` behavior is unchanged
- [ ] Lock SQL, key, and ordering are covered by tests; the PGlite contention gap is documented in-repo, not silent
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` stay green

## Open questions for sdd-design (auto mode: no interactive round held)

1. Exact key derivation: a hardcoded literal int64 vs. a documented deterministic hash of `"indigodb_migrate"` computed at build/author time?
2. Where the accepted PGlite test gap is recorded — test-file comment, `migrate-runner.ts` header, or the new spec's Purpose?
3. Should release failure (unlock returning false) be surfaced as a warning, or ignored since `client.end()` releases anyway?
