# Archive Report: Client Type Honesty

**Change**: client-type-honesty  
**Status**: ARCHIVED  
**Archive Date**: 2026-08-12  
**Archive Location**: `openspec/changes/archive/2026-08-12-client-type-honesty/`  
**Closes Epic**: 3/5 ("Type honesty") of Phase 2, IndigoDB Road to 1.0 roadmap

## SDD Cycle Summary

This change completed the full SDD cycle: proposal → specification → design → implementation → verification → archive. All 26 implementation tasks were completed, verification passed with 0 CRITICAL issues, 0 WARNING issues, and full compliance across all 5 requirements and 11 scenarios.

## Artifact Traceability

All change artifacts were persisted to Engram and the filesystem during the cycle and are now recorded here for terminal archive reference:

| Artifact | Observation ID | Location | Status |
|----------|---|---|---|
| Proposal | #570 | `sdd/client-type-honesty/proposal` | ✓ Archived |
| Specification | #571 | `sdd/client-type-honesty/spec` | ✓ Archived |
| Design | #572 | `sdd/client-type-honesty/design` | ✓ Archived |
| Tasks | #573 | `sdd/client-type-honesty/tasks` | ✓ Archived |
| Verification Report | #575 | `sdd/client-type-honesty/verify-report` | ✓ Archived |

## Scope Summary

### Intent

The generated client/runtime made three false claims and one unverified claim:
1. BigInt columns typed `bigint` but pg returns JS `string` (no setTypeParser)
2. Real Postgres failures escape unwrapped, forcing SQLSTATE string-matching
3. Nominal `enum` emission blocks isolatedModules/erasableSyntaxOnly consumers
4. `select` narrowing unverified

### Resolutions

All four issues are now resolved:

1. **Typed DB-error taxonomy**: New `IndigoDatabaseError extends Error` with `code` field (UNIQUE_VIOLATION for SQLSTATE 23505, UNKNOWN for others), wrapping pg errors at all exec sites in `packages/client/src/client.ts`.
2. **BigInt mapping correction**: `SCALAR_TO_TS[ScalarType.BigInt]` changed from "bigint" to "string", type-only fix matching actual pg runtime behavior.
3. **Const-object enums**: Generated enums now emit as `export const X = {...} as const` paired with `export type X = typeof X[keyof typeof X]`, compiling under erasableSyntaxOnly.
4. **select narrowing verification**: Confirmed via typecheck.mjs regression guard; `SelectedScalars` uses `Pick` and continues narrowing correctly.

## Specs Merged

### New Capability: client-database-errors

**Action**: Created  
**Location**: `openspec/specs/client-database-errors/spec.md`  
**Requirements**: 2 (IndigoDatabaseError wraps failures; original error and SQLSTATE preserved)  
**Scenarios**: 5 (unique violation classification, non-unique→UNKNOWN, non-pg passthrough, cause-chain intact, raw SQLSTATE exposed)

### Modified Capability: client-query-type-safety

**Action**: Updated (additive delta)  
**Location**: `openspec/specs/client-query-type-safety/spec.md`  
**Added Requirements**: 3 (BigInt→string, const-object enums, select narrowing regression guard)  
**Added Scenarios**: 6 (BigInt type mapping, no runtime change, enum value-position, enum type-position, erasableSyntaxOnly, select narrowing verification)

All existing requirements and scenarios preserved; no removals or modifications to pre-existing content.

## Implementation Summary

### Completion Status

| Phase | Tasks | Status | Details |
|-------|-------|--------|---------|
| Phase 1: IndigoDatabaseError | 8 | ✓ Complete | Foundation: error class, code taxonomy, withDatabaseErrors wrapper |
| Phase 2: Wire wrapping | 8 | ✓ Complete | Integration: pool executor, session executor, BEGIN/COMMIT wrapping |
| Phase 3: Generator | 6 | ✓ Complete | BigInt correction, const-object enums |
| Phase 4: Verification | 4 | ✓ Complete | Regression checks, build/test execution |
| **Total** | **26** | **✓ Complete** | All tasks marked complete in tasks.md |

### Build & Test Results

**Per verify-report (#575)**:

| Gate | Result | Evidence |
|------|--------|----------|
| Build | PASS | `pnpm build --force`, 10/10 successful |
| Tests | PASS | `pnpm test --force`, 16/16 turbo test tasks successful |
| Spec Compliance | PASS | 11/11 scenarios compliant with covering tests |
| Correctness | PASS | All 5 load-bearing design points confirmed in source |

**Test Coverage**: 
- `packages/client/test/database-errors.mjs`: 8/8 ok (taxonomy, passthrough, cause chain, double-wrap prevention)
- `packages/client/test/transactions-pg.mjs`: Real-Postgres 23505 cases (statement-level and inside $transaction)
- `packages/generator/test/enum-mapping.mjs`: 4/4 ok (const-object well-formedness, BigInt→string)
- `packages/client/test/typecheck.mjs`: tsc --noEmit fixture (enum in both positions, erasableSyntaxOnly, select narrowing)

### Key Design Decisions

1. **Wrapping innermost in the extension chain**: `withDatabaseErrors` wraps the raw driver executor before `wrapLog`/`applyExtensions`, ensuring all extensions observe the typed error and the taxonomy is uniform.
2. **All three exec paths wrapped**: Pool executor, session executor, and BEGIN/COMMIT control statements all wrapped; ROLLBACK deliberately left untouched to preserve existing poison/console.error handling.
3. **Injected db.exec path unwrapped by design**: Host engine (PGlite, shared pool) owns its own error shapes; SQLSTATE not guaranteed. Documented as a boundary; spec-covered by integration test.
4. **Minimal SQLSTATE taxonomy**: Structural `.code` read only; no instanceof checks (avoids duplicate pg copies in pnpm tree) and no exhaustive catalog (out of scope).
5. **Const-object enums with parenthesized typeof**: `export type X = (typeof X)[keyof typeof X]` ensures type-position and value-position both work, with no separately-named type export needed.

## Archive Integrity Verification

**Mechanical Copy Contract**: Per skill, all archive moves verified via shell commands (`cp -R`, `mv`) with mandatory `diff -r` readback.

**Pre-Move Snapshot**: 
- Created recursive snapshot of `openspec/changes/client-type-honesty` before move
- Snapshot verified identical to archived folder via `diff -r` (0 differences)
- Source directory confirmed removed after move

**Archive Contents**:
- ✓ proposal.md
- ✓ specs/ (both client-database-errors and client-query-type-safety)
- ✓ design.md
- ✓ tasks.md (26/26 tasks complete)
- ✓ verify-report.md
- ✓ archive-report.md (this file)

**Active changes directory**: `openspec/changes/client-type-honesty` no longer exists; change fully moved to archive.

## Verification Report Final State

**Per verify-report (#575)**, verified at 2026-08-12 15:47:12:

- **Verdict**: PASS
- **Critical Issues**: 0
- **Warning Issues**: 0
- **Requirements**: 5/5
- **Scenarios**: 11/11
- **Test Exit Code**: 0
- **Build Exit Code**: 0

All compliance scenarios have passing runtime-executed covering tests. No intermediate snapshots carried forward; this archive report reflects the final, verified state at close.

## Roadmap Status

This change closes **Epic 3/5** ("Type honesty") of Phase 2, IndigoDB Road to 1.0 roadmap.

**Phase 2 Epic Status**:
- ✓ Epic 3: Type honesty (ARCHIVED, this change)
- ✓ Epic 5: Query relations + aggregation (archived prior)
- ✓ Epic 1: Basic relation/include support (archived prior)
- ✓ Epic 2: Nested writes (archived prior)
- ⏳ Epic 4: native-type-attributes-driver-adapters (1 remaining)

Phase 2 itself is not closed; Epic 4 remains pending.

## Generated Artifacts

No interim artifacts were generated as part of archival. The specs were merged directly into the source of truth (`openspec/specs/`), and the change folder was moved to the archive with full artifact preservation.

**Source of Truth Updated**:
- `openspec/specs/client-database-errors/spec.md` (new)
- `openspec/specs/client-query-type-safety/spec.md` (merged)

## Rollback / Recovery

The archived change is immutable. A full revert would require:
1. Moving `openspec/changes/archive/2026-08-12-client-type-honesty/` back to `openspec/changes/client-type-honesty/`
2. Removing the merged requirements from `openspec/specs/client-query-type-safety/spec.md`
3. Removing `openspec/specs/client-database-errors/spec.md`

The single committed PR containing all implementation work can be reverted via its commit SHA if rollback is needed.

## Attestation

- **Archival Completed**: 2026-08-12
- **Skill Version**: sdd-archive/2.0
- **Execution Mode**: hybrid (Engram + filesystem)
- **Archive Authority**: openspec/hybrid convention, mechanical shell copy verified by diff -r
- **Task Completion Gate**: PASS (26/26 tasks complete, no stale checkboxes)
- **Verification Gate**: PASS (0 CRITICAL, 0 WARNING)
- **Native Review Gate**: Not applicable (review-driven development not active for this change)

---

**This archive report is the terminal record of the SDD cycle for `client-type-honesty`. All work is complete, verified, and committed to source control.**
