# Design: Migration Checksum + Staleness Detection

## Technical Approach

`_indigo_migrations` becomes an integrity ledger: `checksum` (sha256 hex of `migration.sql`'s
exact bytes) + `success` (inert, always `true` today). Hashing lives ONLY in
`packages/cli` (`node:crypto`); `@indigodb/migrator` never hashes — it only compares strings
handed to it through the existing `MigrationSource` seam, so `shadow.ts` keeps its
"no `node:fs`/`pg`/`crypto`" boundary. Enforcement is symmetric and override-free:
`migrate dev` refuses via a 4th shadow-replay desync rule, `migrate deploy` refuses via a
preflight that runs before any pending migration is applied, `migrate status` reports
drift non-fatally (exit 0).

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Where hashing lives | `migrationChecksum(sql)` in `packages/cli/src/migrate-runner.ts` (`node:crypto`) | hash inside `shadow.ts` | migrator stays I/O-free and bundler-safe; the seam already exists |
| Seam shape | `MigrationSource` gains **required** `checksum(id): string` and `recordedChecksums: Record<string, string \| null>` | optional fields | optional fields fail open — a caller that forgets silently loses enforcement |
| `null` stored checksum | Skip comparison, no refusal | refuse | only reachable if the file vanished mid-backfill; the missing-on-disk rule already covers that |
| Dev-path error | Reuse `ShadowReplayError` (ids = drifted ids) | new sibling error | spec requires identical refusal shape; `ids` already carries the payload |
| Deploy-path error | No throw: preflight prints `❌ migrate deploy refused: …` + `process.exitCode = 1` and returns | throw `ShadowReplayError` | no shadow DB is involved; a throw would be mislabeled by the existing `catch` as "Deploy failed, rolled back" |
| Test seam | New `MigrationClient` port + optional `cwd` on all three entry points | `process.chdir` + real Postgres | mirrors `startStudio`'s injected `StudioDb`; keeps global state untouched |
| CRLF | Hash raw bytes, no normalization | normalize newlines | files are 100% generator-authored (proposal decision) |

## DDL and Legacy Upgrade

`ensureHistory` (currently `migrate-runner.ts:70-78`) becomes three idempotent steps plus a
silent backfill:

```sql
CREATE TABLE IF NOT EXISTS "_indigo_migrations" (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text,
  success boolean NOT NULL DEFAULT true
);
ALTER TABLE "_indigo_migrations" ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE "_indigo_migrations" ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true;
```

`checksum` is nullable — a legacy row is unhashed until backfilled. Backfill:
`SELECT name FROM "_indigo_migrations" WHERE checksum IS NULL ORDER BY id`; for each id whose
`migrations/<id>/migration.sql` exists, `UPDATE … SET checksum = $1 WHERE name = $2 AND checksum IS NULL`.
Missing file → left `NULL` (existing desync rules own that case). No prompt, no flag, no output.
Idempotent: the second run selects zero rows.

## Data Flow

    ensureHistory (DDL + ALTER + silent backfill)
        │
        ├─ migrate dev ──→ recordedMigrations(+checksums) ──→ fsMigrationSource
        │                        └→ buildShadowSchema ──(mismatch)──→ ShadowReplayError
        ├─ migrate deploy ─→ checksumPreflight ──(mismatch)──→ refuse, apply nothing
        └─ migrate status ─→ per-row applied | modified | pending  (always exit 0)

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modify | `migrationChecksum`, new DDL + backfill in `ensureHistory`, `recordedMigrations` returns `{name, checksum}`, record checksum/success on INSERT (dev + deploy), `checksumPreflight` in `migrateDeploy`, drift row state in `migrateStatus`, `MigrationClient`/`cwd` seams; header comment (lines 1-10) updated |
| `packages/migrator/src/shadow.ts` | Modify | `MigrationSource` +2 fields (jsdoc 33-45); 4th desync rule; **header lines 14-17** ("records NAMES, not checksums … no stronger signal") rewritten; `buildShadowSchema` jsdoc **lines 126-127** ("Desync rules (no checksums exist; …)") reworded + 4th bullet |
| `packages/cli/test/migrate-harness.mjs` | Create | PGlite → `MigrationClient` adapter + tmpdir migrations root |
| `packages/cli/test/migrate-runner.mjs` | Create | First direct `migrate-runner.ts` suite |
| `packages/cli/package.json` | Modify | append `&& node test/migrate-runner.mjs` |
| `packages/migrator/test/shadow.mjs` | Modify | C.12/C.13 checksum cases; existing doubles gain the 2 new fields |

## Interfaces / Contracts

```ts
// @indigodb/migrator — shadow.ts
export interface MigrationSource {
  recorded: string[];
  onDisk: string[];
  read(id: string): string;
  /** sha256 hex of migrations/<id>/migration.sql's exact on-disk bytes. */
  checksum(id: string): string;
  /** Stored checksum per recorded id; `null` = legacy row, comparison skipped. */
  recordedChecksums: Record<string, string | null>;
}

// @indigodb/cli — migrate-runner.ts (test seam; defaults wrap pg.Client)
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<unknown>; // multi-statement, no params
  end(): Promise<void>;
}
export interface RunnerSeams { createClient?: () => Promise<MigrationClient>; cwd?: string }
```

`migrateDeploy(connectionString, seams?)` and `migrateStatus(connectionString, seams?)` take an
optional second argument; `DevOptions` gains the same optional fields. `index.ts` is unchanged.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (migrator) | 4th desync rule | `shadow.mjs` C.12 drift refuses naming the id; C.13 matching checksums replay clean — injected `createShadow` double, no WASM |
| Integration (cli, NEW) | history table + enforcement | `migrate-harness.mjs`: `withDatabase` (fresh `PGlite` per test, mirroring `studio-harness.mjs`) adapted to `MigrationClient` (`query`→`db.query` with `$n` params, `exec`→`db.exec` for multi-statement bodies and BEGIN/COMMIT, `end`→no-op since `withDatabase` owns the lifecycle) + `mkdtempSync` migrations root passed as `cwd` |
| Integration cases | | fresh DDL shape; legacy 3-column table backfills silently + is idempotent; deploy records checksum & `success=true`; deploy refuses on an edited applied file and applies **zero** pending; status prints `⚠ modified` with `process.exitCode` untouched; no env var/flag bypasses drift |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. SQL is parameterized; the only new DDL is fixed-literal.

## Migration / Rollout

Automatic and silent on first run of new code against an existing database (see DDL above).
Rollback: revert the enforcement call sites — the columns become inert data; optionally
`ALTER TABLE … DROP COLUMN IF EXISTS`. No on-disk file format changes.

## Slice Plan (delivery_strategy = auto-chain, budget 800)

| Slice | Scope | Est. |
|---|---|---|
| **1 — seam + schema + harness** | `MigrationClient`/`cwd` seams, new DDL + ALTER + silent backfill, checksum & `success` recorded on apply (dev + deploy), `migrate-harness.mjs` + schema/backfill/record tests. **No enforcement.** | ~400 lines |
| **2 — enforcement + reporting** (targets slice 1's branch) | `MigrationSource` fields + 4th desync rule + both `shadow.ts` doc-comment rewrites, deploy preflight refusal, `migrate status` drift rows, `shadow.mjs` C.12/C.13, CLI enforcement tests. | ~350 lines |

Slice 1 is independently shippable and green (columns recorded, nothing enforced); slice 2
turns enforcement on. `sdd-tasks` should forecast against this split, not a single PR.

## Open Questions

- None. Proposal open questions 1-3 are resolved by the confirmed product decisions
  (silent backfill; hard refusal, zero override; `success` inert) and by the error-type
  decision above (`ShadowReplayError` for dev, CLI-local refusal for deploy).
