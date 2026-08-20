# Design: Advisory Lock Around `migrate deploy`

Mirrors: Engram `sdd/migrate-deploy-advisory-lock/design`. Built on the tree
`packages/cli/src/migrate-runner.ts` has on `feature/migration-checksum-staleness`
(verified live: `migrateDeploy` at line 341, `checksumPreflight` at 174,
`MigrationClient` at 51, `defaultCreateClient` at 110).

## Technical Approach

Two extra `client.query(...)` calls on the connection `migrateDeploy` already
opens — no seam, interface or SQL-application change. A session-level
`pg_try_advisory_lock($1)` is acquired as the FIRST statement inside
`migrateDeploy`'s `try`, before `ensureHistory`; `pg_advisory_unlock($1)` is
released in the existing `finally`, before `client.end()`, guarded by a
`locked` boolean so it is never issued when acquisition failed. Contention is a
refusal, not an exception: the boolean result is checked and the run returns
under the `checksumPreflight` convention.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Lock key | `MIGRATION_LOCK_KEY = 80_600_501_929_807` — module constant next to `HISTORY_TABLE`, documented as `0x494E4449474F` = ASCII `"INDIGO"` | runtime hash of `"indigodb_migrate"`; bare inline number | Hand-verifiable, stable forever, no hash function to maintain, and < `2^53` so it stays an exact JS number over `$1` (a runtime hash would need `BigInt`/string plumbing for no gain) |
| Key scope | one constant, per-database (advisory locks never cross databases), not configurable | key per database name (golang-migrate) | Connection string already scopes to one DB with one `_indigo_migrations` |
| Lock mode | `pg_try_advisory_lock` (session) | `pg_advisory_lock` (blocks forever); `pg_advisory_xact_lock` | Deploy holds ONE connection across many per-migration `BEGIN`/`COMMIT`; a xact lock would drop at the first `COMMIT`. Fail-fast beats hanging a CI job |
| Order vs `checksumPreflight` | lock FIRST, before `ensureHistory` and the preflight | lock after the preflight | Unlocked, two racing deploys both read history, both pass the preflight, and both proceed — the preflight itself must be serialized. It also serializes `ensureHistory`'s DDL/backfill |
| Contention response | check the returned boolean → `❌ migrate deploy refused: …`, `process.exitCode = 1`, `return` | throw | A throw hits the `catch` at 375 and gets mislabeled `Deploy failed, rolled back` — the exact trap `checksumPreflight` already avoids |
| Unlock failure | ignore the returned boolean | warn | `client.end()` releases session locks anyway; a warning would be noise |
| Scope | deploy only | dev/status too | Same dev/deploy asymmetry `migration-checksum-staleness` established |

## Data Flow

    migrateDeploy
      └ try
         ├ SELECT pg_try_advisory_lock($1) ──false──→ refuse (exitCode 1, return, nothing applied)
         │        │ true → locked = true
         │        ├ ensureHistory → checksumPreflight ──drift──→ refuse
         │        └ for each pending: applyMigrationSql → INSERT → COMMIT
         ├ catch → ROLLBACK + "Deploy failed, rolled back"
         └ finally → if (locked) pg_advisory_unlock($1); client.end()

The `finally` covers success, contention-return, drift-return and mid-loop
throw identically — this is the whole crash-safety story at app level; a killed
process relies on Postgres releasing session locks at disconnect.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modify | `MIGRATION_LOCK_KEY` constant + doc; `locked` flag, acquire/refuse block, `finally` unlock in `migrateDeploy`; header comment gains one deploy-lock sentence (~25 lines) |
| `packages/cli/test/migrate-harness.mjs` | Modify | `spyMigrationClient(inner, { onQuery })` — records every `sql`/`params` pair and can override the `pg_try_advisory_lock` result (~25 lines) |
| `packages/cli/test/migrate-runner.mjs` | Modify | 4 new cases (below) (~120 lines) |

## Interfaces / Contracts

```ts
/** Session-level advisory-lock key for `migrate deploy`. 0x494E4449474F = ASCII "INDIGO". */
const MIGRATION_LOCK_KEY = 80_600_501_929_807;
```

`MigrationClient` and `RunnerSeams` are unchanged.

## Testing Strategy

PGlite cannot prove contention (upstream #704: `pg_advisory_lock` does not block
on re-acquisition; it is also one in-process instance). Accepted gap, recorded
as a comment in `migrate-runner.mjs`'s new section. Tests assert SQL text, key
and ORDER through `spyMigrationClient`, wrapping the real PGlite client so
migrations still really apply.

| Case | Assertion |
|---|---|
| lock ordering (happy path) | `pg_try_advisory_lock` is the first recorded query with `params[0] === MIGRATION_LOCK_KEY`, appears before any `_indigo_migrations` statement, and `pg_advisory_unlock` is the last, with the same key |
| contention | spy returns `[{ pg_try_advisory_lock: false }]` → `exitCode === 1`, message names the lock, zero history rows added, NO `pg_advisory_unlock` recorded, no `rolled back` line |
| failure path | a pending file with invalid SQL throws mid-loop → `pg_advisory_unlock` still recorded exactly once after the failure |
| deploy-only | `migrateDev` and `migrateStatus` record zero `advisory` queries |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The key is a compile-time
numeric constant passed as `$1`, never interpolated.

## Migration / Rollout

No migration. No schema, file-format or CLI-surface change; locks vanish with
the session. Rollback = delete the constant and the two `query` calls.

## Slice Plan (delivery_strategy = auto-chain, budget 800)

ONE slice, ~170 changed lines (25 src + ~145 test). No slicing needed:
`400-line budget risk: Low`, `Chained PRs recommended: No`,
`Decision needed before apply: No`.

## Open Questions

None. Proposal Q1 → literal constant with documented ASCII derivation; Q2 →
test-file comment; Q3 → ignore unlock's return value.
