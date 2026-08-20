# Design: `migrate dev --create-only` (Plan/Apply Separation)

Mirrors: Engram `sdd/migrate-dev-create-only/design`. Verified live against
`main` (`packages/cli/src/migrate-runner.ts`): `DevOptions` at 238–246,
`migrateDev` at 312–385, the destructive gate at 346–357, the write at 359–363,
the commit-phase inner `try` at 365–381, `finally { client.end() }` at 382–384.
CLI `migrate dev` at `packages/cli/src/index.ts:147–158`.

**Advisory-lock check (corrected)**: `MIGRATION_LOCK_KEY` is used ONLY inside
`migrateDeploy` (acquire 394–400, release in its `finally` 456–458). `migrateDev`
has no lock, so there is no lock/early-return interaction to design for.

## Technical Approach

`migrateDev` is already linearly split at the exact seam the spec needs: the
pre-flight (connect → `ensureHistory` → `resolvePrevSchema` → `planMigration` →
diagnostics gate → no-op gate → destructive/`--force` gate → `mkdirSync` +
`writeFileSync`) ends at line 363, and the commit phase is the self-contained
inner `try` at 365. The change is one `if (options.createOnly) { … return; }`
inserted between line 363 and 365 — the whole commit-phase `try/catch` is
skipped as a block, and the outer `finally` still closes the client.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Flag name | `--create-only` → `DevOptions.createOnly?: boolean` | `--plan-only`, `--no-apply`, `--dry-run` | Prisma parity; `--dry-run` would falsely imply nothing is written |
| Seam location | early `return` after `writeFileSync` (363), before the commit `try` (365) | a `finally`-level flag; extracting two functions | Skipping a contiguous block needs no restructuring; extraction would churn ~70 lines and risk behavioural drift on the default path |
| `ensureHistory` under the flag | still runs (unchanged, line 316) | skip it / read-only mode | Confirmed acceptable: idempotent tracking-table DDL, never touches user schema, and `resolvePrevSchema`'s shadow replay needs `_indigo_migrations` readable anyway |
| Skipped set | `applyMigrationSql`, history `INSERT`, `COMMIT`, `saveSnapshot` — all four, exactly | skipping only apply; committing an empty tx | Spec Requirement 3 lists all four as MUST NOT; a `COMMIT` with no `BEGIN` is meaningless since `BEGIN` only happens inside `applyMigrationSql` |
| Failure cleanup | none — no `rmSync`, no `ROLLBACK` | reuse the commit-phase `catch` | Those exist to discard a file whose apply failed; under create-only nothing was applied and the file is the deliverable |
| Rendered bytes | reuse the same `renderMigrationSql(plan)` result, same `id`/dir | a separate create-only renderer | Guarantees the byte-identity Requirement 4 demands |
| Output | distinct 3-line block (below) | reuse the applied message; also dump SQL to stdout | Greppable, and the file path is the actionable artifact — printing SQL duplicates it noisily (proposal Q2) |

## Data Flow

    migrateDev(options)
      └ try
         ├ ensureHistory ──────────────────── (runs in BOTH modes)
         ├ resolvePrevSchema ─ShadowReplayError→ refuse (exitCode 1)
         ├ planMigration
         ├ diagnostics? ────────────────────→ refuse (no file written)
         ├ 0 statements? ──────────────────→ "up to date"
         ├ requires-force && !force? ──────→ refuse (no file written)
         ├ mkdirSync + writeFileSync(migration.sql)   ← seam
         │
         ├ createOnly? ──yes──→ print "created (not applied)" → RETURN
         │
         └ no → applyMigrationSql → INSERT history → COMMIT → saveSnapshot
                  └ catch → ROLLBACK + rmSync(dir) + exitCode 1
      └ finally → client.end()          (covers both exits identically)

`--create-only` + `--force`: the destructive gate at 346–357 runs **before** the
write, so a refusal returns with no file on disk and `--force` simply lets
control reach the same single `writeFileSync`. There is no double-write and no
ordering issue — the two flags are orthogonal (gate first, then write, then the
create-only branch).

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modify | `DevOptions.createOnly?: boolean` + doc comment; the `if (options.createOnly)` block after 363; one header-comment sentence (~15 lines) |
| `packages/cli/src/index.ts` | Modify | `.option("--create-only", …)` on `migrate dev`, widened action type, threaded into `migrateDev({ … })` (~3 lines) |
| `packages/cli/test/migrate-runner.mjs` | Modify | 6 new cases (~150 lines) |

## Interfaces / Contracts

```ts
export interface DevOptions {
  // … existing fields unchanged …
  /** Bypasses the requires-force refusal gate — applies destructive statements. */
  force?: boolean;
  /**
   * Plan/apply separation: runs the full pre-flight (connect, ensureHistory,
   * prev resolution, plan, every refusal gate) and writes migration.sql, then
   * skips apply, the history INSERT, COMMIT and saveSnapshot. Still requires a
   * live connection — shadow replay reads `_indigo_migrations`.
   */
  createOnly?: boolean;
}
```

Output on success (replaces the two applied lines for this path):

```
✅ Migration created (not applied): <id>
   <n> statement(s) → migrations/<id>/migration.sql
   Apply it with `indigodb migrate dev` or `indigodb migrate deploy`.
```

CLI: `.option("--create-only", "Write the migration file without applying it")`;
action type gains `createOnly?: boolean`; passed as `createOnly: options.createOnly`.
`MigrationClient`, `RunnerSeams`, `DeployOptions` unchanged.

## Testing Strategy

House style unchanged: plain Node `check(name, fn)`, real PGlite via
`withDatabase`/`createMigrationClient`/`createMigrationsRoot`, `captureLogs`/
`captureErrors`, `spyMigrationClient` for query-shape assertions.

| Case | Assertion |
|---|---|
| create-only writes, DB untouched | `migrations/<id>/migration.sql` exists; `historyRows(db)` empty; no `.snapshot.json` in the migrations root (`readdirSync`); no `User` table in the DB |
| distinct message | `captureLogs` contains a line matching `created (not applied)` and none matching `created and applied` |
| no commit-phase SQL | `spyMigrationClient` records zero `BEGIN`/`COMMIT` and zero `INSERT INTO "_indigo_migrations"` queries |
| gates still refuse | destructive plan + `--create-only` without `--force` → `exitCode === 1`, force-refusal message, migrations root has no new dir; with `--force` → file written, still zero history rows |
| default unchanged | plain `migrateDev` (no flag) → file written, applied, one history row with checksum + `success`, `.snapshot.json` present, `created and applied` logged |
| hand-off | `--create-only` run, then `migrateStatus` reports the id `· pending`; then `migrateDeploy` on the same cwd/db applies it, one history row whose `checksum === migrationChecksum(fileBytes)` |

Byte-identity (Requirement 4) is covered transitively: `migrateDeploy` recomputes
the checksum from the same on-disk bytes and the file is produced by the single
shared `renderMigrationSql(plan)` call.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The flag is a boolean; no new
SQL, no interpolation, no new filesystem path shape.

## Migration / Rollout

No migration. Purely additive CLI surface; default behaviour byte-identical.
Rollback = delete the option, the `DevOptions` field and the early-return block.

## Slice Plan (delivery_strategy = auto-chain, budget 800)

ONE slice, ~170 changed lines (~18 src + ~150 test). Single function, no new
package, no schema or file-format change. `400-line budget risk: Low`,
`Chained PRs recommended: No`, `Decision needed before apply: No`.

## Open Questions

None. Proposal Q1 → `--create-only`; Q2 → path + statement count + hand-off
hint, no SQL dump; Q3 → `ensureHistory` still runs (user-confirmed).
