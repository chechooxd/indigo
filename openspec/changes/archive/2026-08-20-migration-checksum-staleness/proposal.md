# Proposal: Migration Checksum + Staleness Detection

Change: `migration-checksum-staleness` (Road to 1.0, Phase 3, epic "Introspection — `indigodb db pull`", task 3/8). One focused slice, not the epic.

## Intent

`_indigo_migrations` (`migrate-runner.ts:70-77`) records only `id, name, applied_at`. Editing an already-applied `migration.sql` is **silently replayed** — `buildShadowSchema` reads current disk bytes for a recorded id and warns nothing, and `migrateDeploy` only checks set membership, so CI/prod has the same blind spot. `shadow.ts`'s header even documents this as accepted ("no stronger signal than recorded vs on-disk exists"). Pre-1.0 is the last cheap window to change the history table shape.

## Scope

### In Scope
- Add `checksum` (sha256 hex of exact `migration.sql` bytes) + `success` boolean to `_indigo_migrations`; record on apply in `migrateDev`/`migrateDeploy`.
- New shadow-replay desync rule: recorded id whose on-disk checksum differs → hard refusal, same shape as existing missing/pending refusals.
- `migrate deploy` preflight: recompute + compare checksums for already-recorded ids before applying any pending migration.
- `migrate status`: per-row drift state (applied vs modified).
- Update `shadow.ts`'s now-false "no stronger signal" doc comment.
- First direct test harness for `migrate-runner.ts` (PGlite-backed, mirroring `pg-harness.mjs`) — zero coverage today.

### Out of Scope
- Flyway's `installed_by`, `installed_rank`, `description`, `type`, `version`, `execution_time` — no consumer, no driving need. **Recorded as a deliberate exclusion**; reopening requires justification.
- `db pull` command, advisory locking, destructive-statement gating (other Phase 3 tasks).
- Migration-file newline normalization.

## Capabilities

### New Capabilities
- `migration-history-integrity`: history table shape, checksum computation, deploy preflight, status drift reporting, legacy-table upgrade.

### Modified Capabilities
- `shadow-database-replay`: adds checksum-mismatch as a fourth desync rule alongside missing/pending/reorder.

## Approach

Exploration approach 1 (minimal Flyway-inspired subset). Checksums thread through `MigrationSource`'s existing I/O-injection seam — `shadow.ts` must keep never touching `node:fs`/`pg` directly. `ensureHistory` gains an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` path for existing tables. Enforcement is symmetric: dev via shadow replay, prod via deploy preflight.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/cli/src/migrate-runner.ts` | Modified | table shape, checksum record/compare, status drift |
| `packages/migrator/src/shadow.ts` | Modified | checksum desync rule; stale doc comment |
| `packages/cli/test/` | New | first migrate-runner harness |
| `packages/migrator/test/shadow.mjs` | Modified | extend C.8-C.11 desync suite |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Legacy `_indigo_migrations` blocks a user's next run | High | explicit backfill semantics (design decision); never hard-fail without documented path |
| New CLI test harness inflates scope beyond checksum logic | High | sized into tasks explicitly, not a rounding error |
| CRLF/line-ending drift breaks byte-exact hash | Low | files are 100% generator-authored; document, don't normalize |
| `MigrationSource` seam broken by fs reach-in | Medium | checksums travel through the injected source |

## Rollback Plan

1. Revert the enforcement call sites (shadow rule + deploy preflight + status) — checksum columns become inert data.
2. Drop columns via `ALTER TABLE ... DROP COLUMN IF EXISTS` if desired; `CREATE TABLE IF NOT EXISTS` tolerates either shape.
3. No migration-file format change on disk; nothing user-authored to undo.

## Dependencies

- Builds on `shadow-database-replay` (shipped) — reuses `ShadowReplayError`'s refusal shape.

## Success Criteria

- [ ] Editing an applied `migration.sql` fails `migrate dev` with a message naming the drifted id
- [ ] `migrate deploy` refuses on drift before applying any pending migration
- [ ] `migrate status` distinguishes applied from modified
- [ ] A pre-existing checksum-less `_indigo_migrations` upgrades without data loss or a dead end
- [ ] `migrate-runner.ts` has direct test coverage for the first time
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` stay green

## Open questions for sdd-design (auto mode: no interactive round held)

1. Legacy backfill: NULL checksum = "trusted once, backfilled on next touch" vs. forced re-baseline?
2. New error type: extend `ShadowReplayError` or a sibling `MigrationChecksumError`?
3. `success`: today failed migrations are rolled back and discarded (`rmSync` dev, `ROLLBACK` deploy), so no failed row ever exists. Does `success=false` start being persisted, or is the column recorded-but-always-true for now?
