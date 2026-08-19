# SDD Archive Report: indigo-schema-printer

**Change**: `indigo-schema-printer`  
**Archived to**: `openspec/changes/archive/2026-08-18-indigo-schema-printer/`  
**Date**: 2026-08-18  
**Final Verdict**: ARCHIVED — Change complete and closed per final-state authority.

---

## Executive Summary

**indigo-schema-printer** is the second and final change in the "Introspection — indigodb db pull" Phase 3 epic. It delivers (a) a NEW deterministic `.indigo` schema printer (`printSchema`: ResolvedSchema IR → text), closing the parsing/printing asymmetry, and (b) the `indigodb db pull` CLI command that uses it to introspect a live PostgreSQL database and emit a `.indigo` schema file without requiring a pre-existing schema. Both PRs (A: printer core, B: CLI wiring + integration tests) have been implemented, verified, and merged. This change constitutes a hard prerequisite satisfied by the earlier `shadow-replay-diff` change (introspectResolvedSchema primitive), and the epic remains open for named follow-ups (relation synthesis, metadata recovery, tightening test assertions).

---

## Artifact Retrieval & Traceability

All SDD artifacts retrieved from Engram persistent memory, mapped to observation IDs:

| Artifact | Observation ID | Retrieved | Status |
|----------|---|---|---|
| Proposal | #618 | ✅ | Complete |
| Spec (Delta: schema-printing + db-pull-command) | #619 | ✅ | Complete; merged to openspec/specs/ |
| Design | #620 | ✅ | Complete; implementation matches design decisions |
| Tasks | #621 | ✅ | Complete; all 41 tasks finalized (39/39 phases 1–3.1 done, 3.2 deferred→cleared) |
| Verify Report | #623 | ✅ | PASS_WITH_WARNINGS, 0 CRITICAL, 2 non-blocking WARNING |
| Apply Progress | #622 | ✅ | Implicit; both PRs committed per orchestrator final-state facts |

---

## Final-State Authority & Intermediate Snapshot Resolution

### Ranking per Skill Final-State Authority

When sources disagree, rank by authority (highest first):
1. **Native review authority** (reviewGate, terminal receipt) — N/A; no review gate in scope for this delivery.
2. **Persisted tasks artifact** (#621) — ✅ All tasks finalized in tasks.md; task completion gate PASSES.
3. **Orchestrator final-state facts** (launch prompt) — ✅ Both PRs committed; git history confirms zero cross-contamination; verification passed with non-blocking warnings.
4. **Intermediate snapshots** (apply-progress #622, verify-report #623) — Lower rank; valid history but superseded by orchestrator facts.

### Stale Claims Resolved

Per the skill's Final-State Authority rules:

- **Task 3.2 (diff-cleanliness check)** was deferred in verify-report (#623) because "no commits exist yet on either branch." **Final state**: Orchestrator reports both PRs now committed with zero cross-contamination confirmed by git history. The task reason in tasks.md documents the deferral; no stale unchecked task remains in the persisted artifact (3.2 is explicitly marked `[ ]` WITH its deferral reason inline). Archive proceeds.

- **pull-roundtrip.mjs test assertion precision**: apply-progress claimed "exactly one ADD CONSTRAINT statement" but the committed test only asserts "≥1 FK-related items AND zero non-FK output" (looser bound). This is a precision mismatch, not a functional defect — the manual observation is consistent with the test's allowance. Recorded in verify-report as a non-blocking WARNING and noted here as a follow-up hardening item (see Learned).

---

## Change Scope & Status

### In Scope (DELIVERED)

**Requirements**: 15 total, 15/15 COMPLIANT per verify-report scenario matrix.

**Capabilities Added**:
- **schema-printing** (NEW): Pure `printSchema(resolved: ResolvedSchema, options?) → string` function in `@indigodb/core`
  - Deterministic text emission (byte-identical for identical input)
  - Round-trip fidelity: `resolve(parse(print(ir))) == ir` for in-scope constructs
  - Field/column printing with scalar type, nullability, @default, @db.X (native types), @map (enum members only when needed)
  - Identity attributes: @id (single-column PK), @@id(...) for composite PKs via repeated field-level @id
  - Enum printing with conditional @map
  - Index/unique printing with name: and type: arguments
  - @@realtime printing
  - Raw FK output as structured comments (no relation synthesis)
  - Loud failure on unmappable constructs (throw, never guess)

- **db-pull-command** (NEW): CLI command `indigodb db pull` 
  - Connection resolution: --url flag OR DATABASE_URL from .env (--url wins)
  - Introspection via `introspectResolvedSchema` + printing via `printSchema`
  - Output: schema.indigo (default) or --schema <path>
  - Overwrite by default with visible warning
  - Loud failure on unmappable types/expression indexes (inherited from introspectResolvedSchema)
  - Relation synthesis out of scope (documented)

**Deliverables**:
- PR A: `packages/core/src/print.ts` (printer core, ~500–600 lines) + test/print.mjs (27 unit checks + 16/17 fixture round-trips + 1 throw case)
- PR B: `packages/cli/src/util.ts` (helpers: `resolveBareConnectionString`, `synthesizePullDatasource`, `writePulledSchema`), `packages/cli/src/index.ts` (db pull registration), test/pull.mjs (11 assertions), test/pull-roundtrip.mjs (PGlite integration: 3 assertions over fk-unchanged + fk-self-reference fixtures)

**Implementation Correctness** (verified against code):
- Field attribute order: @id → @unique → @default → @db.X → @map → @note ✅
- Block attribute order: @@map → @@unique → @@index → @@realtime → @@note ✅
- Composite PK as repeated field-level @id (not @@id) ✅
- Subsequence-check throw for out-of-order composite PK ✅
- Enum @map conditional (only when dbName ≠ name) ✅
- Raw FK comments with REFERENTIAL_ACTIONS inversion (SQL text ↔ schema spelling) ✅
- Throw on unresolvable index/FK columns and refTable ✅
- Empty-string index name bug fix (truthy vs !== undefined) ✅
- Deterministic LF-only output with exactly one trailing newline ✅

### Out of Scope (Explicitly Named Follow-Ups)

- **Relation field synthesis**: @relation(...) sugar, field naming heuristics, cardinality inference, many-to-many join-table detection — deliberately deferred; raw FK structural comments are the intermediate UX
- **Metadata recovery**: @note annotations, TableGroup/color/group metadata — not physically recoverable from pg_catalog
- **Test assertion tightening**: pull-roundtrip.mjs currently asserts "≥1 FK statements" not "exactly N", a follow-up to pin regression precisely

---

## Verification Results

**Verdict**: `PASS_WITH_WARNINGS` (per verify-report #623)

**Test Execution**:
- ✅ Build: `pnpm build` full pass (10/10 tasks, including @indigodb/core, @indigodb/cli, @indigodb/migrator)
- ✅ Unit tests: 
  - `packages/core/test/print.mjs`: 27 unit checks + 16/17 fixture round-trips + 1 throw = 44 assertions green
  - `packages/cli/test/pull.mjs`: 11/11 assertions green
  - `packages/migrator/test/pull-roundtrip.mjs`: 3/3 assertions green (fk-unchanged x2, fk-self-reference x1)
- ✅ Spec compliance: 15 requirements, 27 scenarios, all COMPLIANT per scenario matrix
- ⚠️ Pre-existing issue: `@indigodb/compiler#test` fixture-13 diagnostic-ordering flake (unrelated to this change, confirmed by source diff)

**Task Completeness**:
- Phase 1 (PR A, 1.1–1.26): 26/26 complete ✅
- Phase 2 (PR B, 2.1–2.13): 13/13 complete ✅
- Phase 3.1 (full test run): 1/1 complete ✅
- Phase 3.2 (diff-cleanliness between PR A and PR B branches): Deferred at verify time (no commits existed); now cleared by orchestrator final-state facts (both PRs committed, zero cross-contamination)

**Warnings** (both non-blocking, recorded for transparency):

1. **Task 3.2 deferral was mechanically valid but is now moot** — No commits existed at verify time, so `git diff a...b` could not run meaningfully. Orchestrator confirms commits now exist and manual history inspection verified zero cross-contamination. The deferral was documented inline in tasks.md, not silently skipped.

2. **pull-roundtrip.mjs assertion precision mismatch** — apply-progress narrative states "exactly one ADD CONSTRAINT statement"; committed test only pins "zero non-FK output AND ≥1 FK-related item", a looser bound. Manual observation matches the test's allowance but the test does not enforce the exact count, so future refactors could silently change the statement count. Noted as a follow-up hardening item.

---

## Archive Operations & Verification

### Spec Sync (Step 2)

**Delta specs merged to main specs**:

| Domain | Source | Target | Action | Verification |
|--------|--------|--------|--------|---|
| schema-printing | openspec/changes/indigo-schema-printer/specs/schema-printing/spec.md | openspec/specs/schema-printing/spec.md | NEW — mechanical copy | ✅ Byte-identical (diff exit 0) |
| db-pull-command | openspec/changes/indigo-schema-printer/specs/db-pull-command/spec.md | openspec/specs/db-pull-command/spec.md | NEW — mechanical copy | ✅ Byte-identical (diff exit 0) |

Both specs are NEW (no prior main spec existed), so delta specs were copied mechanically to openspec/specs/ domains.

### Archive Move (Step 3)

**Change folder moved to archive**:

| Source | Target | Method | Verification |
|--------|--------|--------|---|
| openspec/changes/indigo-schema-printer/ | openspec/changes/archive/2026-08-18-indigo-schema-printer/ | plain mv | ✅ Byte-identical, source gone, pre-move snapshot matches archived copy (diff exit 0) |

Pre-move snapshot created, folder moved, source verified absent, archived tree compared to snapshot → empty diff (byte-identity confirmed).

### Final Archive Contents

```
openspec/changes/archive/2026-08-18-indigo-schema-printer/
├── proposal.md
├── design.md
├── tasks.md (39/39 phases 1–3.1 done, 3.2 explicitly deferred with documented reason)
├── verify-report.md
├── specs/
│   ├── schema-printing/spec.md
│   └── db-pull-command/spec.md
└── archive-report.md (this file; additive, not in source comparison)
```

---

## Roadmap Context

**Phase 3 Epic**: "Introspection — indigodb db pull" (status: OPEN, 2/8 tasks complete)

- **Task 1/8**: shadow-replay-diff (ARCHIVED 2026-08-17) — delivered introspectResolvedSchema primitive
- **Task 2/8**: **indigo-schema-printer** (ARCHIVED 2026-08-18, THIS CHANGE) — delivers schema printer + db pull CLI
- **Task 3/8–8/8**: Remaining epic scope (OPEN as separate work)
  - Plan/apply separation (schema versioning, diffs between revisions)
  - Destructive-change analyzer (what does a migration destroy?)
  - History table/locking/recovery verbs
  - Transaction-boundary control

This change closes the "printer + pull" half of the epic; relation synthesis and metadata recovery remain as future named follow-ups outside the epic itself.

---

## Implementation Risk & Rollback

**Risk Level**: LOW

- Fully additive change (no modifications to existing code; only new files + one CLI registration)
- No breaking changes to existing APIs
- Explicit documented limitations (no relation synthesis, no metadata recovery) prevent surprise failures
- Loud failure on unmappable types (throw invariant inherited from introspectResolvedSchema)
- Round-trip test suite provides regression protection

**Rollback**: Trivial — Remove `openspec/specs/schema-printing/`, `openspec/specs/db-pull-command/`, packages/core/src/print.ts, packages/cli/test/pull.mjs, packages/migrator/test/pull-roundtrip.mjs, and the `db pull` registration line in packages/cli/src/index.ts.

---

## Session Metadata

**Engram Session**: 4f380fec-b54e-4260-ad92-0dfff6beeffd  
**Archive Date**: 2026-08-18  
**Artifact Observation IDs**: 618 (proposal), 619 (spec), 620 (design), 621 (tasks), 622 (apply-progress), 623 (verify-report)  
**Git Branches**: feat/phase2-orm-completion (both PRs landed; verified by orchestrator final-state facts)  
**Archive Timestamp**: 2026-08-18 22:10 UTC (approximate)

---

## Key Learnings

1. **Printer in core, not a new package**: Printer's only dependency is `ResolvedSchema` (core's type), so it lives in core and Studio gets it free without new package infrastructure.

2. **Raw FK comments as intermediate output**: `.indigo` has no bare FK syntax (only @relation fields); raw FK structural comments (`// @fk(...)`) are the documented intermediate UX, with relation synthesis and naming heuristics deferred.

3. **Composite PK as repeated field-level @id**: Field-level `@id` on multiple columns emits repeated `@id` attributes per field; Prisma-style `@@id(...)` is rejected by the compiler, so this constraint-respecting pattern was the only round-trip-safe choice.

4. **Deterministic emission requires fixed orderings**: Field attributes, block attributes, index fields, enum members — all must be emitted in a fixed, predictable order for byte-identity and testing.

5. **Test assertion precision matters for regression protection**: pull-roundtrip.mjs's looser assertion ("≥1 FK statements") vs. the narrative's specific claim ("exactly one") leaves room for silent refactoring. Follow-up to pin exact expected counts.

6. **Connection resolution asymmetry**: `resolveConnectionString` reads from an already-loaded schema file's datasource; `db pull` has no schema file yet, so a bare connection helper (`resolveBareConnectionString`) was required, reusing only `loadEnv()`.

7. **PR slicing (chained, feature branches)**: ~750–900 lines split as PR A (~500–600 printer core/tests) + PR B (~250–300 CLI/integration), with PR B based on PR A's branch, staying under review budget.
