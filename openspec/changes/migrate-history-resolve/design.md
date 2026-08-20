# Design: `migrate resolve` (History Recovery Verb)

Verified live against `main`, `packages/cli/src/migrate-runner.ts`: `MIGRATION_LOCK_KEY` 53,
`MigrationClient` 62–67, `RunnerSeams` 77–80, `listMigrationDirs` 107–114, exported
`migrationChecksum(sql)` 117–119, `ensureHistory` 141–169, `checksumPreflight` 185–197,
`DeployOptions` 260–263, the shared INSERT shape 386–389 / 461–464, `migrateStatus` 488–509
(end of file). `packages/cli/src/index.ts:143–184` holds the `migrate` group.
No DELETE against `_indigo_migrations` exists anywhere today — `resolve` introduces the first one.

## Technical Approach

One new exported function appended after `migrateStatus`, following the existing
connect → `ensureHistory` → decide → report shape. It executes exactly one mutating
statement (one INSERT or one DELETE), never opens a transaction, never calls
`applyMigrationSql`, never touches `loadSnapshot`/`saveSnapshot`, and reuses the already
exported `migrationChecksum` — nothing is reimplemented.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Signature | `migrateResolve(options: ResolveOptions)`, bag with `connectionString` inside | positional `(connectionString, seams)` like deploy/status | Two direction flags + an id read better as a bag; `DevOptions` is the precedent |
| Flag validation | inside `migrateResolve`, **before** `createClient` | Commander `.conflicts()` / `program.error` | Keeps both spec scenarios (both flags, neither flag) coverable by the runner suite and refuses without opening a connection |
| Id resolution | exact match against `listMigrationDirs(cwd)` **and** `existsSync(migrations/<id>/migration.sql)` | `existsSync` alone; prefix/fuzzy matching | Directory-membership match kills `../` traversal outright; fuzzy matching would guess at an operator's destructive intent |
| Drift check | only when a row already exists; compare stored checksum vs freshly computed | recompute-and-overwrite; skip entirely | See "Drift mechanics" — this is the only place the check is non-vacuous, and it is what makes `resolve` not a side door around `migration-history-integrity` |
| Transaction | none — single autocommit statement | `BEGIN`/`COMMIT` like deploy | One statement is already atomic; deploy's tx exists to wrap multi-statement DDL |
| Advisory lock | **no** lock | reuse `MIGRATION_LOCK_KEY` | See "Locking" |
| Rolled-back detection | `DELETE … WHERE name = $1 RETURNING name`, branch on `rows.length` | `SELECT` then `DELETE` | `MigrationClient` exposes no `rowCount`; `RETURNING` gives the same answer in one round trip on both `pg` and PGlite |
| Refusal style | `console.error` + `process.exitCode = 1` + `return` | `throw` | Byte-consistent with `migrateDeploy`'s refusals |

## Drift mechanics (why the check is not vacuous)

For `--applied <id>` the row may legitimately not exist yet, so there is nothing to compare
against — the freshly computed checksum *is* the record of on-disk truth and is inserted
as-is. The comparison therefore runs **only on the already-recorded branch**, and that branch
is exactly the scenario the spec guards:

1. `deploy` applies `X`, recording checksum `A`.
2. Someone edits `migrations/X/migration.sql`; on-disk bytes now hash to `B`.
3. `deploy`/`dev` now hard-refuse via `checksumPreflight` / shadow replay.
4. Operator runs `resolve --applied X` hoping to clear the block.
5. Row exists, `A ≠ B` → refuse, row untouched. No re-baseline side door.

If instead `A === B` (nothing drifted, operator just re-ran the command) it is a clean no-op.
So the recorded branch is a strict three-way split: `no row` → insert, `row + match` → no-op,
`row + mismatch` → refuse. A `NULL` stored checksum is unreachable here: `ensureHistory` runs
first and backfills any NULL row whose file exists, and the unknown-id guard already proved
the file exists. Defensively, `NULL` is treated as the no-op branch, never as a refusal.

## Locking

`MIGRATION_LOCK_KEY` is deploy-only by explicit, tested design (test at
`migrate-runner.mjs:618` asserts `dev`/`status` take no lock). Deploy's lock protects a long,
multi-statement, non-idempotent DDL sequence where two concurrent runs could apply the same
migration twice. `resolve` shares none of those properties: no DDL, one atomic statement, and
`name text NOT NULL UNIQUE` makes a genuinely concurrent duplicate INSERT fail loudly rather
than corrupt. Taking the lock would also *add* a failure mode — an operator repairing history
while a stuck deploy still holds the session lock would be refused precisely when the tool is
most needed. Accepted residual risk: a `resolve --applied X` racing an in-flight deploy of `X`
makes that deploy's INSERT hit the unique constraint and roll back with an error. Loud, not silent.

## Data Flow

    migrateResolve(options)
      ├ both flags?    → refuse (exitCode 1, no connection opened)
      ├ neither flag?  → refuse (exitCode 1, no connection opened)
      ├ id ∉ listMigrationDirs(cwd) || no migration.sql → refuse (exitCode 1, no connection)
      └ createClient → try
           ├ ensureHistory(client, cwd)
           ├ --applied:      SELECT checksum WHERE name=$1
           │     ├ no row              → INSERT (name, checksum, success=true)  ✅
           │     ├ stored === computed → no-op                                  ✅
           │     └ stored !== computed → refuse (exitCode 1, row untouched)     ❌
           └ --rolled-back:  DELETE WHERE name=$1 RETURNING name
                 ├ rows.length === 1 → removed                                  ✅
                 └ rows.length === 0 → no-op                                    ✅
         finally → client.end()

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modify | `ResolveOptions` next to `DeployOptions`; `migrateResolve` appended after `migrateStatus`; one header-comment sentence (~55 lines) |
| `packages/cli/src/index.ts` | Modify | `migrate resolve` subcommand + import (~14 lines) |
| `packages/cli/test/migrate-runner.mjs` | Modify | 10 new cases (~220 lines) |
| `openspec/specs/migration-history-integrity/spec.md` | Modify | remedy-clause delta (spec phase artifact) |

## Interfaces / Contracts

```ts
export interface ResolveOptions extends RunnerSeams {
  connectionString: string;
  /** Migration id (the `migrations/<id>` directory name) to record as applied. */
  applied?: string;
  /** Migration id whose recorded row should be removed. Mutually exclusive with `applied`. */
  rolledBack?: string;
}

export async function migrateResolve(options: ResolveOptions): Promise<void>;
```

The applied INSERT reuses the existing shape verbatim:
`INSERT INTO "_indigo_migrations" (name, checksum, success) VALUES ($1, $2, $3)` with
`[id, migrationChecksum(readFileSync(file, "utf-8")), true]`. The id is only ever a bound
parameter — never interpolated into SQL.

CLI wiring in `index.ts`, matching the `dev`/`deploy`/`status` block:

```ts
migrate
  .command("resolve")
  .description("Reconcile migration history without running SQL.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("--applied <id>", "Record <id> as applied without executing its SQL")
  .option("--rolled-back <id>", "Remove <id>'s recorded row from history")
  .action(async (options: { schema: string; applied?: string; rolledBack?: string }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    await migrateResolve({
      connectionString: resolveConnectionString(resolved),
      applied: options.applied,
      rolledBack: options.rolledBack,
    });
  });
```

`<id>` is the full timestamp-prefixed directory name (e.g. `20240101120000_init`) — the same
string stored in `_indigo_migrations.name`. Commander camelCases `--rolled-back` to `rolledBack`.

## Output Messages

| Path | Output | Exit |
|---|---|---|
| applied, inserted | `✅ Migration recorded as applied: <id>` + `   No SQL was executed — _indigo_migrations only.` | 0 |
| applied, already recorded | `✅ Already recorded as applied: <id> — nothing to do.` | 0 |
| rolled back, removed | `✅ Migration record removed: <id>` + `   No SQL was executed — _indigo_migrations only.` | 0 |
| rolled back, absent | `✅ Not recorded as applied: <id> — nothing to do.` | 0 |
| unknown id | `❌ migrate resolve refused: unknown migration id "<id>" — no migrations/<id>/migration.sql on disk.` | 1 |
| drift | `❌ migrate resolve refused: <id> no longer matches its recorded checksum.` + `   Revert migrations/<id>/migration.sql to its recorded content, or use --rolled-back <id> first.` | 1 |
| both flags | `❌ migrate resolve refused: --applied and --rolled-back are mutually exclusive.` | 1 |
| neither flag | `❌ migrate resolve refused: one of --applied <id> or --rolled-back <id> is required.` | 1 |

## Testing Strategy

House style unchanged: plain Node `check(name, fn)`, real PGlite via
`withDatabase`/`createMigrationClient`/`createMigrationsRoot`, `historyRows`,
`captureLogs`/`captureErrors`, `spyMigrationClient` for query-shape assertions.

| Case name | Assertion |
|---|---|
| `resolve --applied records the row without executing migration SQL` | one row, `checksum === migrationChecksum(bytes)`, `success === true`; the migration's own table does **not** exist in the DB |
| `resolve --applied is an idempotent no-op on an already-recorded, non-drifted id` | still exactly one row, unchanged; `exitCode` unset; log matches `Already recorded` |
| `resolve --applied refuses on checksum drift and leaves the row unchanged` | edit file after recording → `exitCode === 1`, stored checksum still the original |
| `resolve --applied makes status report applied and deploy skip it` | `migrateStatus` logs `✓ applied <id>`; `migrateDeploy` logs `No pending migrations.` and executes no DDL |
| `resolve --rolled-back deletes the recorded row` | `historyRows(db)` empty; log matches `record removed` |
| `resolve --rolled-back on an absent row is a clean no-op` | `exitCode` unset, zero rows, no error line |
| `resolve refuses an unknown migration id (--applied)` | `exitCode === 1`, message names the id, zero rows |
| `resolve refuses an unknown migration id (--rolled-back)` | `exitCode === 1`, pre-existing rows unchanged |
| `resolve refuses both flags and refuses neither flag` | both `exitCode === 1`; `createClient` seam never invoked |
| `resolve opens no transaction, takes no lock, and leaves .snapshot.json byte-identical` | `spyMigrationClient` records zero `BEGIN`/`COMMIT`/`pg_try_advisory_lock`; snapshot file bytes equal before/after |

## Threat Matrix

No routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary — the reference matrix rows are `N/A`. Two input-handling rows
are applicable and are design requirements:

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Path traversal via operator-supplied `<id>` | Yes | id must be an exact member of `listMigrationDirs(cwd)`; `../…` is refused as unknown before any fs read or ledger write | unknown-id cases (extend one with a `../`-shaped id) |
| SQL injection via `<id>` | Yes | id bound as `$1` in every statement; never string-interpolated | covered by parameterized INSERT/DELETE assertions in the spy case |

## Migration / Rollout

No migration. Purely additive CLI surface; no schema, column, or file-format change.
`dev`/`deploy`/`status` code paths are untouched. Rollback = delete the subcommand,
`ResolveOptions` and `migrateResolve`.

## Slice Plan (delivery_strategy = auto-chain, budget 800)

ONE slice, ~290 changed lines (~69 src + ~220 test). Confirmed single-slice: one function,
one subcommand, one file neighborhood. `400-line budget risk: Low`,
`Chained PRs recommended: No`, `Decision needed before apply: No`.

## Open Questions

None. Proposal Q1 → snapshot untouched (spec-fixed); Q2 → idempotent no-op; Q3 → refuse on
drift, never re-baseline.
