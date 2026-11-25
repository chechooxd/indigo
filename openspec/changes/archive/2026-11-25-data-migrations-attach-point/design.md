# Design: Data Migrations Attach Point

## Technical Approach

Introduce `migrations/<id>/data.sql` as an optional sibling file inside any migration directory,
owned by `@indigodb/cli`'s `migrate-runner.ts`, without widening `@indigodb/migrator`'s
`MigrationSource` seam.

## Architecture Decisions

### Decision 1: SQL sibling file (`data.sql`) rather than JS/TS hooks

| Option | Tradeoff | Decision |
|---|---|---|
| `data.mjs` / `data.ts` dynamic import runner | Transpilation/module-cache hazards, breaks single-transaction guarantee if caller opens its own client, widens security/testing surface ahead of a second real caller | Rejected |
| Optional `migrations/<id>/data.sql` executed via `client.exec(dataSql)` inside the same open transaction as `migration.sql` | Zero new deps, atomic DDL+DML rollback on failure, deterministic checksum over exact UTF-8 bytes, works identically on PGlite and real `pg` | **Chosen** |

### Decision 2: Domain-separated checksum preserving byte-identity when `data.sql` is absent

```ts
const DATA_CHECKSUM_SEPARATOR = "\0--indigo:data.sql--\0";
export function migrationChecksum(sql: string, dataSql?: string): string {
  const hash = createHash("sha256").update(sql);
  if (dataSql !== undefined) {
    hash.update(DATA_CHECKSUM_SEPARATOR).update(dataSql);
  }
  return hash.digest("hex");
}
```

- When `data.sql` does not exist on disk, `dataSql` is `undefined`, yielding the exact same sha256
  as before (`migrationChecksum(sql)`).
- When `data.sql` exists on disk (even empty), `dataSql` is a string, changing the checksum so
  post-apply edits, additions, or deletions of `data.sql` are caught by ALL four integrity checks:
  `migrateDeploy`'s `checksumPreflight`, `migrateDev`'s `buildShadowSchema`, `migrateStatus`'s
  `⚠ modified` reporter, and `migrateResolve --applied`.

### Decision 3: Existing `MigrationSource` seam stays unwidened

`MigrationSource` (`packages/migrator/src/shadow.ts:40-51`) already separates `read(id)` (SQL to
replay into PGlite) from `checksum(id)` (integrity digest). `fsMigrationSource` keeps `read(id)`
returning `migration.sql` ONLY (so shadow replay skips `data.sql`), while `checksum(id)` returns
`migrationChecksum(sql, dataSql)` (so shadow replay still refuses if `data.sql` drifted).

### Decision 4: `--empty` requires `--create-only`

`indigodb migrate dev --empty` without `--create-only` fails fast with exit 1 BEFORE opening a
DB connection: scaffolding an unedited stub and immediately applying it as a recorded migration
would permanently burn a migration ID on a no-op. With `--create-only --empty`, `migrateDev`
still runs `ensureHistory` + `resolvePrevSchema` (refusing pending/drifted/missing history), then
writes `migration.sql` (comment header) and `data.sql` (template stub) without running
`planMigration` or touching `.snapshot.json`.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modify | `readMigrationFiles`, updated `migrationChecksum(sql, dataSql?)`, `applyMigrationSql(client, sql, dataSql?)`, `data.sql` scanning in `migrateDeploy`, `DevOptions.empty` scaffolding |
| `packages/cli/src/index.ts` | Modify | Add `--empty` option to `migrate dev` and thread `empty: options.empty` |
| `packages/cli/test/migrate-data.mjs` | Create | PGlite-backed test suite covering all scenarios |
| `packages/cli/test/run-all.mjs` | Modify | Register `migrate-data.mjs` |
