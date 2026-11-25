# Verify Report: data-migrations-attach-point

**Date**: 2026-11-25
**Branch**: `data-migrations-attach-point`
**Verdict**: PASS — archive-ready

## Task Completion

All tasks in `tasks.md` complete.

## Test Evidence (real in-process PostgreSQL via PGlite)

- **RED** (`node packages/cli/test/migrate-data.mjs` before edits): 8/9 failed on the expected
  assertions; #8 (shadow replay skips `data.sql`) passed as a pre-existing regression guard.
- **GREEN** (`node packages/cli/test/migrate-data.mjs` after edits): **9/9 passed**:
  1. `migrationChecksum` byte-identical when `dataSql` omitted, distinct when present.
  2. DDL + `data.sql` backfill applies atomically in one transaction.
  3. Failing `data.sql` rolls back both DDL and DML and records `success = false`.
  4. Data-only migration (comment-only `migration.sql` + `data.sql`) applies cleanly.
  5. `data.sql` with `-- indigo:requires-force` refuses without `--force` and applies with `--force`.
  6. Post-apply edit to `data.sql` detected by `migrateStatus` (`⚠ modified`), `migrateDeploy`,
     `migrateDev` shadow replay, and `migrateResolve --applied`.
  7. Adding `data.sql` post-apply to an already-applied DDL-only migration triggers checksum drift.
  8. Shadow replay skips `data.sql` even when `data.sql` raises on an empty table.
  9. `--empty` without `--create-only` refuses before connecting; `--create-only --empty`
     scaffolds `migration.sql` + `data.sql` with zero schema changes without applying.
- **Mutation proof 3.1**: disabled the `dataSql` branch in `migrationChecksum`, rebuilt CLI,
  re-ran `migrate-data.mjs` → **exact 3 checksum/drift tests failed** (all 6 other tests stayed
  green); reverted and rebuilt → 9/9 green.
- **Regression**: `migrate-runner.mjs` and `pnpm lint` pass with exit 0.
