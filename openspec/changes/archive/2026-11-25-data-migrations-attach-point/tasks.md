# Tasks: Data Migrations Attach Point

## Phase 1: RED PGlite Suite
- [x] 1.1 Write `packages/cli/test/migrate-data.mjs` covering all 9 scenarios using the real PGlite harness (`migrate-harness.mjs`) and wire it into `packages/cli/test/run-all.mjs`.
- [x] 1.2 Build CLI and run `node packages/cli/test/migrate-data.mjs` to confirm RED before implementation.

## Phase 2: Implement Attach Point & `--empty` Scaffolding (GREEN)
- [x] 2.1 Update `packages/cli/src/migrate-runner.ts`:
      - `migrationChecksum(sql, dataSql?)` with NUL-delimited domain separator (byte-identical when `dataSql === undefined`).
      - `readMigrationFiles(cwd, id)` returning `{ sql, dataSql }`.
      - `applyMigrationSql(client, sql, dataSql?)` executing `dataSql` in the same open transaction after `migration.sql`.
      - `migrateDeploy` pre-scan covers both `migration.sql` and `data.sql` with `scanRequiresForce`, and `checksumPreflight` / `fsMigrationSource` / `migrateResolve` use `readMigrationFiles` + `migrationChecksum(sql, dataSql)`.
      - `DevOptions.empty`: refuse without `createOnly` before connecting; with `createOnly`, run preflight then write comment-only `migration.sql` + stub `data.sql`.
- [x] 2.2 Add `--empty` flag to `indigodb migrate dev` in `packages/cli/src/index.ts`.
- [x] 2.3 Build and run `node packages/cli/test/migrate-data.mjs` + existing `migrate-runner.mjs` to confirm GREEN.

## Phase 3: Mutation Proof & Verification
- [x] 3.1 Mutation proof: temporarily drop `dataSql` from `migrationChecksum` in `migrate-runner.ts`, rebuild, run `migrate-data.mjs`, confirm drift scenarios go RED, then revert.
- [x] 3.2 Run `pnpm --filter @indigodb/cli test`, `pnpm --filter @indigodb/migrator test`, `pnpm build && pnpm lint`.
- [x] 3.3 Write `verify-report.md` and `archive-report.md`, merge canonical spec, archive, fast-forward `main`, delete branch, and save to Engram.
