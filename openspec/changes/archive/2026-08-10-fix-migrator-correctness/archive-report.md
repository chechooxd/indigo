# Archive Report: fix-migrator-correctness

**Change**: fix-migrator-correctness
**Status**: ARCHIVED
**Archived**: 2026-08-10
**Store**: hybrid (OpenSpec + Engram)

## Final State Summary

The `fix-migrator-correctness` SDD change has completed successfully. All 30 implementation tasks are verified complete. The change has been fully implemented, verified (with one intermediate warning now closed), and is ready for delivery.

### Final Verification State

**Verification Result**: PASS (after closure of intermediate warning)

Per `sdd/fix-migrator-correctness/verify-report` (observation #301):
- Initial verdict: PASS WITH WARNINGS
- 30/30 tasks verified genuinely complete against source (not just checkboxes)
- All 4 gates run fresh: pnpm test, pnpm build, pnpm lint, cd crates && cargo test — all green

**Key Gate Results (at time of initial verification)**:
- `pnpm test --force`: 13/13 Turbo tasks green
  - Migrator: 19 fixtures × 4 assertions + 3 splitMigrationSql unit cases
  - Generator: 3/3 enum-mapping tests
- `pnpm build --force`: 10/10 successful
- `pnpm lint --force`: 18/18 successful
- `cd crates && cargo test`: 23 passed / 0 failed

### Intermediate Warning — NOW CLOSED

**Warning (from initial verify-report)**: Design specified three arms for enum diff (added→ADD VALUE, removed→refusal diagnostic, retained-with-changed-@map→ALTER TYPE ... RENAME VALUE). The third arm was never implemented in the apply phase. A member kept under the same name whose @map moved produced zero DDL and zero diagnostic, a silent divergence in the exact class this change exists to remove.

**Resolution**: Implemented by orchestrator follow-up in commit `6cfe759` — "fix(migrator): emit RENAME VALUE when an enum member's @map moves".
- Reproduced independently by orchestrator, then closed TDD-first: fixture `enum-value-remapped` was written RED (3 failing checks), then implementation made it green
- Regenerating that golden moved no other fixture

**Final gate state re-run after `6cfe759`**:
- `pnpm test` — 13 Turbo tasks green: **20 migrator fixtures** (one additional), 3 splitMigrationSql unit cases, generator enum-mapping suite, compiler regression suite
- `pnpm build` — 10 successful
- `pnpm lint` — 18 successful
- `cd crates && cargo test` — **23 passed / 0 failed**

### Final Git State (no push/PR intended)

Stacked-to-main chain as of archive time, intentional pending user authorization:
```
main → (5 commits from fix-compiler-correctness)
     → f8f20ef test(migrator): golden harness
     → 10a040c docs(sdd): planning artifacts
     → d389235 refactor(migrator): MigrationPlan contract
     → 5e0a2e8 fix(migrator): FK ordering, referential actions, enum dbName
     → f71601c fix(migrator): renames, PK changes, enum removal, NOT NULL guard
     → ea9bc14 test(migrator): dependent-object realignment fixture
     → 6cfe759 fix(migrator): RENAME VALUE when an enum member's @map moves
```

Branches: `fix/migrator-golden-harness-and-plan-contract`, `fix/migrator-ordering-and-referential-actions`, `fix/migrator-diff-completeness-and-guards` (current HEAD).

## Closed Inherited Incompletenesses

The predecessor change `fix-compiler-correctness` handed over two tracked items. Both are now closed by this change:

1. **ForeignKey.onUpdate reached the IR but emitted no DDL** — Now emitted in both `packages/migrator/src/migrate.ts` and `packages/migrator/src/postgres.ts`, via fkDefinition's onUpdate field and addForeignKey/renderForeignKey emission. Test coverage: fk-actions-emitted and fk-actions-changed fixtures.

2. **Enum members/dbName reached the IR but the migrator still rendered values** — Now rendered from members' dbName in both renderers (migrate.ts:createEnum, postgres.ts:renderEnum) AND in the generated client (packages/generator/src/client.ts), closing design's Open Questions #2 cross-package hazard. Test coverage: enum-value-mapped fixture in both migrator and generator/enum-mapping harnesses.

## Known Limitations (Documented, Not Defects)

These capabilities are explicitly out of scope and are documented as follow-up work:

1. **PK change assumes PostgreSQL's default <table>_pkey constraint naming**
   - A hand-named PK constraint would not be found during DROP
   - Disclosure: design.md Open Questions #3
   - Fixture coverage: pk-change passes (default naming); hand-named constraint remains unfixed

2. **Goldens pin generated SQL text, not PostgreSQL applicability**
   - Golden fixtures assert exact SQL/diagnostic TEXT only
   - MUST NOT be read as proof of applicability against real PostgreSQL
   - No PostgreSQL instance runs in this suite or in CI
   - Disclosure: design.md Honest Verification Limit, all 6 specs' Known Limitation section
   - Follow-up: integration testing against real PostgreSQL (named as separate change)

3. **First migrate dev after upgrade may be unexpectedly large**
   - Newly-emitting classes (@map rename, PK change, enum value removal) that were previously silent on existing schemas
   - Not a new defect, but a surfacing of pre-existing drift
   - Disclosure: design.md Migration/Rollout section, release-notes.md

## Carried-Forward Suggestion

From initial `verify-report` (observation #301), one SUGGESTION for a future enhancement:
- **Spec tightening for hand-named PK constraints**: add a fixture exercising PK drop-and-recreate where the PK constraint carries a user-supplied name (not PostgreSQL's default). Coverage is currently by build+lint only (untested on actual data). Low priority.

## Specs Synced

Four new capability specs created in `openspec/specs/`, two existing specs extended with ADDED Requirements:

| Domain | Type | Details |
|--------|------|---------|
| migration-ddl-ordering | NEW | Foreign key statement ordering, top-level category order, enum ADD VALUE transaction boundary |
| migration-diff-completeness | NEW | Unambiguous @map rename (RENAME COLUMN), PK change, enum value removal refusal, ambiguous rename refusal |
| migration-safety-guards | NEW | ADD COLUMN NOT NULL guard for populated tables |
| migration-golden-tests | NEW | Golden fixture contract, harness, regeneration discipline |
| referential-actions | MODIFIED | 2 ADDED Requirements: DDL emission and change detection for onDelete/onUpdate |
| enum-value-mapping | MODIFIED | 1 ADDED Requirement: both renderers emit from members' dbName |

**Source of Truth**: All 6 specs now live in `openspec/specs/{domain}/spec.md`.

## Archive Contents

- proposal.md ✅
- design.md ✅
- tasks.md ✅ (30/30 tasks complete)
- verify-report.md ✅
- release-notes.md ✅
- specs/ ✅
  - migration-ddl-ordering/spec.md
  - migration-diff-completeness/spec.md
  - migration-safety-guards/spec.md
  - migration-golden-tests/spec.md
  - referential-actions/spec.md (delta merged into main)
  - enum-value-mapping/spec.md (delta merged into main)

## Artifact IDs for Traceability

Engram artifacts persisted during this SDD cycle:

- `sdd/fix-migrator-correctness/proposal` — observation #287
- `sdd/fix-migrator-correctness/spec` — observation #288
- `sdd/fix-migrator-correctness/design` — observation #290
- `sdd/fix-migrator-correctness/tasks` — observation #291
- `sdd/fix-migrator-correctness/verify-report` — observation #301
- `sdd/fix-migrator-correctness/archive-report` — (this document, persisted as new observation)

## SDD Cycle Complete

The change has been fully planned (proposal), specified (6 specs across migration/referential domains), designed (MigrationPlan contract, three-slice sequencing), implemented (30/30 tasks), verified (PASS after closure of intermediate warning), and archived.

Ready for user delivery decision and release.
