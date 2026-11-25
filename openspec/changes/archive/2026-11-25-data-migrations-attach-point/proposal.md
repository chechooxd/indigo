# Proposal: Data Migrations Attach Point

## Intent

IndigoDB's migration engine (`@indigodb/migrator` + `@indigodb/cli`) handles DDL diffs,
shadow-replay verification, checksum integrity, advisory locking, destructive gating, and
plan/apply separation (`--create-only`). However, it has no first-class attach point for
DML/data migrations (backfills, row transformations, reference seeds):

1. `migrate dev --create-only` refuses to create a migration when there are no schema changes.
2. Putting DML directly inside `migration.sql` couples real-data backfills to `buildShadowSchema`
   (which replays `migration.sql` into an empty PGlite database).
3. Dropping a separate file inside `migrations/<id>/` is ignored by `migrate deploy` and
   unprotected by `_indigo_migrations.checksum`.

This change introduces `migrations/<id>/data.sql` as the official, transactional, checksum-covered
data migration attach point, plus `indigodb migrate dev --create-only --empty` to scaffold
data-only migrations.

## Scope

### In Scope
- Optional sibling file `migrations/<id>/data.sql` inside any migration directory.
- `migrateDeploy` executes `data.sql` (when present and non-empty) right after `migration.sql`
  inside the SAME `BEGIN ... COMMIT` transaction; failure rolls back both DDL and DML and
  records `success = false` in `_indigo_migrations`.
- `migrateDeploy` pre-scans `data.sql` (alongside `migration.sql`) with `scanRequiresForce` so
  annotated destructive DML (`-- indigo:requires-force <impact>`) obeys the `--force` gate.
- `migrationChecksum(sql, dataSql?)`: unchanged `sha256(sql)` when `data.sql` is absent
  (100% backward-compatible), domain-separated `sha256` covering both `migration.sql` and
  `data.sql` when present. Enforced across `migrateDeploy`, `migrateDev` shadow replay,
  `migrateStatus`, and `migrateResolve`.
- Shadow replay (`buildShadowSchema`) continues reading only `migration.sql` (never executing
  `data.sql`) via the existing `MigrationSource` seam — no widening of `MigrationSource`.
- `indigodb migrate dev --create-only --empty -n <name>` scaffolds a data-only migration
  (`migration.sql` comment header + `data.sql` template stub) after shadow-history preflight;
  `--empty` without `--create-only` is refused.

### Out of Scope
- JavaScript/TypeScript procedural data migration runners (`.mjs`/`.ts`).
- Non-transactional / batched data migration executors (`-- indigo:begin no-transaction` inside
  `data.sql`).
- Any `crates/` or IR changes (no `build:wasm` rerun needed).

## Capabilities

### New Capabilities
- `data-migrations-attach-point`: transactional `data.sql` sibling attach point, combined
  directory checksum, shadow-replay isolation, destructive-marker scanning, and `--empty`
  scaffolding.

### Modified Capabilities
- `migration-plan-apply-separation`: adds `--empty` (requiring `--create-only`) to scaffold
  data-only migrations.

## Rollback Plan

Revert the branch commits. No `_indigo_migrations` schema change, no `MigrationSource` signature
change, and `migrationChecksum(sql)` without `data.sql` is byte-identical to before.
