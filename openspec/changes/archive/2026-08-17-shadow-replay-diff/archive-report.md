# Archive Report: shadow-replay-diff

**Change**: shadow-replay-diff  
**Status**: ARCHIVED  
**Archive Location**: `openspec/changes/archive/2026-08-17-shadow-replay-diff/`  
**Archived**: 2026-08-17  
**Verification**: PASS (0 CRITICAL, 0 WARNING, 2 SUGGESTION non-blocking)

## Artifact Traceability

All SDD artifacts successfully retrieved from Engram and archived:

| Artifact | Observation ID | Type | Status |
|----------|----------------|------|--------|
| Proposal | #609 | architecture | Retrieved and archived |
| Spec (4 domains) | #610 | architecture | Retrieved, specs merged into main |
| Design | #611 | architecture | Retrieved and archived |
| Tasks | #612 | architecture | Retrieved and archived (35/35 complete) |
| Verify Report | #614 | architecture | Retrieved and archived (PASS) |

## Executive Summary

**shadow-replay-diff** is the FIRST change of roadmap "Road to 1.0" Phase 3, epic "Delete the snapshot as source of truth". This change delivers a minimal slice of introspection — the hard prerequisite for the full `db pull` command — plus the shadow-replay diff source that uses it. The change completes 35 implementation tasks across 3 phases (A: physical-identity fallback matching, B: schema introspection, C: shadow replay + migrate-runner restructure) and passes full verification against a comprehensive test suite covering plan equivalence, @map degradation cases, and shadow replay desync diagnostics.

## Specs Merged into Main Specs

Four domain specs processed from `openspec/changes/shadow-replay-diff/specs/` into `openspec/specs/`:

| Domain | Status | Action | Details |
|--------|--------|--------|---------|
| schema-introspection | NEW | Created | 7 requirements: table/column introspection, PK/FK/indexes/enums with full member sets, name=dbName fidelity boundary, no metadata recovery, round-trip fidelity |
| shadow-database-replay | NEW | Created | 5 requirements: fresh PGlite per build, recorded-order replay, PGlite hard runtime dep, missing-dir diagnostic, order-divergence diagnostic, no real-DB mutation |
| migration-diff-completeness | MODIFIED | Updated | First requirement expanded with two scenarios: schema-sourced prev emits RENAME COLUMN (unchanged), shadow-derived prev emits DROP+ADD (accepted degradation) |
| migration-appliability-tests | MODIFIED | Updated | 5 ADDED requirements: plan-equivalence across corpus excluding @map case, migrate dev works without .snapshot.json on disk, .snapshot.json still written post-run, missing/out-of-order migrations produce diagnostic |

**Mechanical Verification**: All spec copies verified with `diff -r`; zero byte differences confirm lossless transfer.

## Task Completion Gate

**Result**: PASS

All 35 implementation tasks complete and checked in `openspec/changes/archive/2026-08-17-shadow-replay-diff/tasks.md`:

- **Phase A** (Physical-Identity Fallback Matching): 9/9 complete [x]
  - A.1-A.4: RED tests (@@map steady state, @map column type-change NOT skipped, @map'd enum member, byte-identical goldens)
  - A.5-A.8: GREEN implementation (matchTables, matchColumns pass-2 pairs, enum-member fallback, consumed-set drop detection)
  - A.9: VERIFY regression harness green

- **Phase B** (Schema Introspection): 10/10 complete [x]
  - B.1-B.5: RED tests (type/nativeType inversion, unmappable type throws, FK NO ACTION normalization, derived-vs-explicit name policy, round-trip fidelity 32-fixture corpus)
  - B.6-B.8: GREEN implementation (introspectResolvedSchema with 6 catalog queries, column mapping, PK/FK/index/enum derivation)
  - B.9-B.10: GREEN export + VERIFY round-trip passes

- **Phase C** (Shadow Replay + migrate-runner Restructure): 16/16 complete [x]
  - C.1-C.7: RED tests (plan-equivalence 27 fixtures, @map divergence cases, chain replay, @@realtime trigger replay under PGlite confirmed, 4 desync diagnostics)
  - C.12-C.15: GREEN implementation (shadow.ts buildShadowSchema + desync rules, migrate-runner restructure with recorded-migration ordering, PGlite promotion to dependency)
  - C.16: VERIFY all tests green, manual smoke deferred (no live Postgres sandbox available; PGlite coverage substitutes)

- **Phase D** (Cross-cutting Verification): 2/3 items
  - D.1 [ ]: Full monorepo `pnpm test` — surfaces pre-existing, unrelated compiler flake (13-ambiguous-relations.indigo diagnostic-order mismatch). Confirmed out-of-scope: zero changes to packages/compiler or crates in this diff. Does not block archive.
  - D.2 [x]: cli/package.json unchanged, confirmed via git diff. PGlite arrives transitively via @indigodb/migrator.
  - D.3 [ ]: README/CHANGELOG for INDIGODB_MIGRATE_PREV=snapshot escape hatch — deferred as non-blocking docs gap. Reasonable to address post-archive.

**Status**: No stale unchecked implementation tasks. D.1 and D.3 legitimately deferred per verify-report. Gate PASSES.

## Discoveries Beyond Original Design Scope

Two divergence findings were discovered during apply and are documented, test-covered, and accepted per the same @map-degradation policy the user approved in sdd-design:

1. **enum-value-remapped (remapped enum member)**: When an enum member's @map target changes (e.g., enum S { A @map("a_old") } becomes S { A @map("a_new") }), the physical dbName changes between prev and next. With shadow-derived prev (name===dbName), this is indistinguishable from an enum-value-removed on the prev side, triggering the refuse-generation diagnostic. This is the same root cause as the documented @map column-rename degradation: introspected prev cannot recover logical names. Test coverage: `enum-member-physical-fallback` fixture + dedicated assertion in shadow.mjs. Status: documented, accepted, no mitigation needed (same fidelity boundary as @map columns).

2. **map-rename-with-dependents (required column without default)**: When a @map column is renamed via DROP+ADD and that column is required (no @default), the ADD COLUMN statement for the new name hits `required-column-without-default` diagnostic, refusing generation. This is correct diagnostic behavior (the new column must either have a @default or be NOT NULL only in an existing row). The test was updated to assert this diagnostic rather than "no diagnostics". Status: documented in test comment, correct behavior per the schema design (not a bug; the user must provide a @default or migrate data separately).

Both findings are consistent with the documented @map-degradation cost of introspection-derived prev and are explicitly NOT blockers to archive.

## Phase 3 Roadmap Status

This change closes the first epic task: "Delete the snapshot as source of truth" moving from design to implementation+verification.

**Scope Delivered**:
- Minimal introspection primitive (internal plumbing, not byte-for-byte .indigo regeneration)
- Shadow-database mechanism via PGlite
- migrateDev prev-source swap from loadSnapshot() to shadow-replay-then-introspect
- Comprehensive test coverage for plan equivalence and documented @map degradation

**Explicitly Out of Scope (follow-up changes/epics)**:
- Full `db pull` CLI command / new package (epic 2 "Introspection" — this change delivers only the internal primitive)
- Byte-for-byte .indigo regeneration (full db pull capability)
- Checksum column on `_indigo_migrations` + edited-applied-migration detection (epic 3 "Staleness detection")
- `pg_advisory_lock` around `migrate deploy` (epic 4 "Concurrent-deploy safety")
- Destructive-statement classification / `--force` gating (epic 5 "Destructive-statement safety")

**Phase 3 Remains Open**: Four additional epics/follow-up changes as listed above are required to complete Phase 3 "A migration engine a bank would accept". This archive closes the first change; the phase epic itself stays active.

## Roadmap Ordering Inconsistency (Resolved in Design)

The proposal noted an inconsistency: the roadmap listed epic 1 (delete snapshot) BEFORE epic 2 (Introspection / db pull), but the code dependency graph requires epic 2's literal scope first (introspection primitive) to deliver epic 1 (shadow-replay diff). This was resolved in sdd-design by accepting the minimal introspection primitive as part of this change, with the full db pull command deferred to epic 2. The change's scope statement explicitly marks this as "hard prerequisite delivered early, full db pull remains unbuilt."

## Source-Level Verification (Terminal Record)

All implementation details confirmed against live source:

- **migrate.ts**: `matchTables`/`matchColumns`(pass-2 pairs)/`matchEnumMembers` present per Design Decision 1. Byte-identical golden claim verified: zero changes to any pre-existing fixture directory; only 3 new fixtures added.
- **introspect.ts**: `introspectResolvedSchema` present with 6 catalog queries, type inversion table (text→String, etc.), nativeType recovery, unmappable type throws naming table.column, NO ACTION ('a')→absent, derived-vs-explicit name policy for index/fk names, single-column @unique-vs-@@unique collapsing.
- **shadow.ts**: `buildShadowSchema`/`ShadowReplayError`/`MigrationSource` present. No node:fs/pg/process.cwd() imports (only @indigodb/core types, plan.js, introspect.js). PGlite dynamically imported. All four desync rules implemented: missing-on-disk refuse, pending-unrecorded refuse (points at migrate deploy), reorder-same-set warn+replay-in-recorded-order, empty-history→EMPTY_SCHEMA.
- **migrate-runner.ts**: `migrateDev` connects before planning. `recordedMigrations(client)` (ORDER BY id) exists. `resolvePrevSchema` via buildShadowSchema by default; INDIGODB_MIGRATE_PREV=snapshot escape hatch reachable. `saveSnapshot` still called after successful apply, before success log.
- **migrator/package.json**: @electric-sql/pglite under dependencies (not devDependencies), ^0.5.4.
- **cli/package.json**: unchanged via git status. PGlite arrives transitively via @indigodb/migrator.
- **Test execution**: Full suite green: migrator.mjs (32 fixtures), native-type.mjs, index-ddl.mjs, appliability.mjs, replay.mjs, introspect.mjs (36 checks including round-trip 32-fixture corpus), shadow.mjs (38 checks: 27 plan-equivalence + 5 divergence + chain + realtime + 4 desync). pnpm build, pnpm lint all green. One pre-existing unrelated compiler flake in parity.mjs (13-ambiguous-relations ValidationError order), confirmed out-of-scope.

## Verification Report Summary

**Per #614 (verify-report)**:

- **Verdict**: PASS
- **Task Completeness**: 35/35 implementation tasks complete and checked
- **Spec Domain Compliance**: All 4 domains (schema-introspection, shadow-database-replay, migration-diff-completeness delta, migration-appliability-tests delta) covered by passing runtime tests
- **Design Decisions**: All 7 design decisions match implementation
- **Critical Issues**: 0
- **Warnings**: 0
- **Suggestions (non-blocking)**: 2
  - D.3: README/CHANGELOG note for INDIGODB_MIGRATE_PREV=snapshot escape hatch deferred (docs gap, low risk)
  - Manual live-Postgres smoke test not run (no Postgres instance in sandbox; PGlite coverage substitutes)

## Final State Authority

This archive report reflects the state of the change at close, per SDD Final-State Authority hierarchy:

1. **Native review authority**: No review was conducted for this change (reviewGate structurally absent; receipt-driven development not in use for this candidate).
2. **Persisted tasks artifact**: All 35 tasks checked in `openspec/changes/archive/2026-08-17-shadow-replay-diff/tasks.md`; D.1 and D.3 legitimately deferred.
3. **Explicit final-state facts in launch prompt**: User noted two divergence discoveries (enum-value-remapped, map-rename-with-dependents) beyond original design scope, both test-covered and accepted. Phase 3 remains open (four additional follow-up epics required).
4. **Verify-report intermediate snapshot**: All claims in verify-report #614 are authoritative (PASS verdict confirmed by fresh test execution; no stale claims reused).

All higher-ranked sources agree: this change is ready for archive with no blocking conditions.

## Archive Completeness

Archive folder contains all SDD artifacts in `openspec/changes/archive/2026-08-17-shadow-replay-diff/`:

- [x] proposal.md (from #609)
- [x] design.md (from #611)
- [x] tasks.md with all 35 tasks checked (from #612)
- [x] verify-report.md (from #614)
- [x] specs/ directory with 4 domain subdirectories (from delta specs)
  - schema-introspection/spec.md (NEW)
  - shadow-database-replay/spec.md (NEW)
  - migration-diff-completeness/spec.md (delta merged into main)
  - migration-appliability-tests/spec.md (delta merged into main)
- [x] archive-report.md (this file, added at archive time)

Main specs in `openspec/specs/` successfully updated:
- [x] openspec/specs/schema-introspection/spec.md (created)
- [x] openspec/specs/shadow-database-replay/spec.md (created)
- [x] openspec/specs/migration-diff-completeness/spec.md (merged delta)
- [x] openspec/specs/migration-appliability-tests/spec.md (merged delta)

## SDD Cycle Complete

The shadow-replay-diff change has been fully planned (proposal), specified (4 domain specs), designed (3-phase seam architecture), implemented (35 tasks across packages/migrator and packages/cli), verified (comprehensive test suite with plan equivalence and desync diagnostics), and archived. The change is closed.

---

**Archived by**: sdd-archive executor  
**Archive Date**: 2026-08-17  
**Archive Method**: Hybrid (Engram + filesystem)  
**Verification**: Mechanical copy with `diff -r` readback; empty diff confirms lossless transfer
