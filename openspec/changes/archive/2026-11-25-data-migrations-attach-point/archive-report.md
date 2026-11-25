# Archive Report: data-migrations-attach-point

**Date Archived**: 2026-11-25
**Branch**: `data-migrations-attach-point`
**Verdict**: PASS — 5/5 requirements, 9/9 PGlite scenarios, surgical mutation proof verified

## Summary

Added `migrations/<id>/data.sql` as the official transactional attach point for DML/backfill
migrations alongside `migration.sql`, plus `indigodb migrate dev --create-only --empty` to
scaffold data-only migrations. `MigrationSource` in `@indigodb/migrator` was NOT widened:
`read(id)` still feeds `migration.sql` only to shadow replay, while `checksum(id)` hashes both
files with a NUL-delimited domain separator (byte-identical to `sha256(sql)` whenever `data.sql`
is absent).

## Spec Merge

- NEW canonical spec: `openspec/specs/data-migrations-attach-point/spec.md` (5 requirements, 9 scenarios).
- MODIFIED canonical spec: `openspec/specs/migration-plan-apply-separation/spec.md` (+1 ADDED
  requirement for `--empty` requiring `--create-only`, 0 duplicate titles).
