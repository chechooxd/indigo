# Archive Report: relations-include-select

**Change**: relations-include-select  
**Archived**: 2026-08-11  
**Status**: COMPLETED  
**Verdict**: PASS (0 CRITICAL, 0 WARNING, 1 documented non-blocking design limitation)

## Overview

This change closes **roadmap Phase 2, epic 2 of 8 ("Relations")** across two implementation slices:
- **Slice 1 (`relations-epic`, archived 2026-08-11)**: Paired relations in the IR.
- **Slice 2 (this change, `relations-include-select`, now archived)**: Include/select query API and return-type narrowing.

Together, these slices complete the full epic as originally scoped in the roadmap **except** for two explicitly deferred capabilities:
- **`_count` aggregation** — deferred to a separate follow-up change (`relation-count-aggregate`), which requires a new `GROUP BY` shape.
- **Depth ≥ 2 nested include** — deferred to a future change, no named follow-up yet.

All work documented, implemented, and verified. The change is ready to ship.

## Observation IDs for Traceability

All SDD artifacts and verifications recorded in Engram:

| Artifact | Engram ID | Type | Date |
|----------|-----------|------|------|
| Proposal | #528 | architecture | 2026-08-11 20:04:12 |
| Spec | #529 | architecture | 2026-08-11 20:08:38 |
| Design | #530 | architecture | 2026-08-11 20:10:15 |
| Tasks | #531 | architecture | 2026-08-11 20:12:12 |
| Apply Progress | #532 | architecture | 2026-08-11 20:21:08 (revised 2026-08-11) |
| Verify Report | #534 | architecture | 2026-08-11 23:03:22 |

**Pre-existing defect (tracked separately, not this change's scope)**:
- Engram #533 (bugfix): Generated `IndigoClient.$transaction` violates TS override compatibility (TS2416). Confirmed byte-identical in code before this change touched the file. Tracked separately; not a blocker for this change.

## Task Completion (Final Authority)

**Source**: `openspec/changes/archive/2026-08-11-relations-include-select/tasks.md` (persisted artifact, all checkboxes marked complete).

### Breakdown by Phase

| Phase | Name | Tasks | Status |
|-------|------|-------|--------|
| 1 | Generator metadata & types | 1.1–1.8 (8 tasks) | ✅ Complete |
| 2 | Client types & GetPayload checkpoint | 2.1–2.4 (4 tasks) | ✅ Complete |
| 3 | Delegate wiring & batched load | 3.1–3.12 (12 tasks) | ✅ Complete |
| 4 | Join-key stripping | 4.1–4.4 (4 tasks) | ✅ Complete |
| 5 | Composite-key runtime rejection | 5.1–5.3 (3 tasks) | ✅ Complete |
| 6 | Realtime regression | 6.1–6.3 (3 tasks) | ✅ Complete |
| 7 | Wiring, cleanup, verification | 7.1–7.5 (5 tasks) | ✅ Complete |

**Total**: 39/39 tasks complete.

**Delivery Strategy**: `auto-chain` (stacked-to-main PRs, high-risk 900–1200 line budget).

## Verification Report Summary

**Source**: Engram #534 (sdd/relations-include-select/verify-report), captured 2026-08-11 23:03:22.

**Verdict**: **PASS**

### Test Execution (Forced, Non-Cached, Live This Session)

| Test Suite | Command | Result | Counts |
|------------|---------|--------|--------|
| Monorepo build | `pnpm build --force` | ✅ exit 0 | 10/10 packages |
| Monorepo lint | `pnpm lint --force` | ✅ exit 0 | 18/18 tsc --noEmit |
| Monorepo test | `pnpm test --force` | ✅ exit 0 | 16/16 Turbo task nodes, 322 "ok" lines |
| Generator enum-mapping | (subset of pnpm test) | ✅ | 3/3 ok |
| Generator transaction-emission | (subset of pnpm test) | ✅ | 10/10 ok |
| Generator relation-emission | (subset of pnpm test) | ✅ | 12/12 ok |
| Client typecheck.mjs (GetPayload) | `node packages/client/test/typecheck.mjs` | ✅ | 1/1 ok (real narrowing, no fallback needed) |
| Client client.mjs | (subset of pnpm test) | ✅ | 10/10 ok |
| Client relations.mjs | (subset of pnpm test) | ✅ | 14/14 ok |
| Client transactions.mjs | (subset of pnpm test) | ✅ | 6/6 ok |
| Client transactions-pg.mjs | (subset of pnpm test) | ✅ | 5/5 ok |

### Design Coherence

Implementation matches `design.md` decisions exactly:

1. ✅ **Direction collapsed at codegen time**: `__meta` emits `{ name, target, from, to, list }` with field names (not physical columns).
2. ✅ **Child fetch reuses sibling delegate**: `findMany` on target model via existing `in` → `ANY($n)` operator.
3. ✅ **Siblings lazy registry thunk**: `ModelDelegate` ctor accepts `siblings?: () => SiblingRegistry` as 4th arg, appended last.
4. ✅ **Payload conditional types in types.ts**: Real conditional narrowing implemented, no generator string templates.
5. ✅ **Single-column relation keys only**: Composite keys throw typed `IndigoRelationError` at runtime; omitted from `<Model>Relations` at codegen.
6. ✅ **Zero cost when include absent**: `loadRelations` only runs when `args.include` is set.

### Six Scrutiny Points (Per Verify-Report, All Independently Confirmed)

1. ✅ **Empty to-many → `[]`** (test 3.4 asserts key presence + array + length 0, never undefined); empty to-one → `null` (test 3.2), not undefined/missing key.
2. ✅ **Join-key stripping tested as two cases** (4.1 parent side, 4.2 child side), not combined.
3. ✅ **Composite-key rejection**: `IndigoRelationError` thrown before batched query; consistency across PR1 codegen + PR2 runtime per task 5.3.
4. ✅ **Realtime regression**: Test 6.1 asserts exact call count (1, no batched follow-up) AND absence of relation keys on payload.
5. ✅ **Round-trip count confirmed**: Scales with relation count, not parent row count (tests 3.5 and 3.7).
6. ✅ **Filesystem verify-report twin**: Verified to exist on disk (8245 bytes) per explicit instruction.

### Known, Documented, Spec-Permitted Design Limitation

**Nested `select` inside `include` does NOT narrow the static TS shape for the included relation.**

- **Runtime behavior**: Correct (tests 3.6/4.2 confirm narrowed JS shape).
- **Static TS inference**: Does not narrow `Rel[K]` to the selected subset (requires broader generic redesign).
- **Mitigation**: Documented inline in `packages/client/src/types.ts` (above `Payload` type) and in `packages/client/test/typecheck-fixture.ts`.
- **Classification**: Documented design limitation, NOT the GetPayload fallback scenario. Does not block PASS.

### Confirmed Out of Scope

**Pre-existing `IndigoClient.$transaction` TS2416 override defect** (Engram #533):
- Confirmed byte-identical via `git show HEAD` before this change touched the file.
- Correctly excluded from this change's spec/tasks/verification.
- Not a blocker for this change; tracked separately for eventual fix.

## Specs Synced to Main Capability Domains

### New Domains Created

Both delta specs were full specs (no pre-existing main specs to merge into). Copied mechanically to `openspec/specs/`:

| Domain | Filepath | Status | Requirements | Scenarios |
|--------|----------|--------|--------------|-----------|
| client-relation-loading | `openspec/specs/client-relation-loading/spec.md` | ✅ Created | 7 requirements | 13 scenarios, all passing |
| client-query-type-safety | `openspec/specs/client-query-type-safety/spec.md` | ✅ Created | 5 requirements | 9 scenarios, all passing (with documented fallback clause) |

**Verification**: Every requirement and scenario in both specs mapped to passing tests re-executed this session per verify-report #534.

## Delivery Artifacts

### Archived Change Folder

**Path**: `openspec/changes/archive/2026-08-11-relations-include-select/`

**Contents**:
- ✅ proposal.md (original scope and approach)
- ✅ design.md (technical decisions and contracts)
- ✅ tasks.md (39/39 tasks complete)
- ✅ specs/client-relation-loading/spec.md (delta spec for relation loading)
- ✅ specs/client-query-type-safety/spec.md (delta spec for type safety)
- ✅ verify-report.md (verification results, PASS)
- ✅ archive-report.md (this document, added post-archive)

### Main Specs Updated

- ✅ `openspec/specs/client-relation-loading/spec.md` (new)
- ✅ `openspec/specs/client-query-type-safety/spec.md` (new)

## Implementation Summary

### Two PR Delivery Structure (Stacked to Main)

#### PR 1: Generator Metadata & Include Input

**Files Modified**:
- `packages/generator/src/client.ts` — Emits `__meta.<Model>.relations` with `{ target, from, to, list, composite? }` structure; emits `<Model>Relations` interface and `<Model>IncludeInput` type per model.
- `packages/generator/test/relation-emission.mjs` — New 12 codegen tests covering 1-1, 1-N, N-1, nullable, @map columns, composite rejection.

**Key Decisions**:
- Direction collapsed at codegen time (from/to as field names, not physical columns).
- Composite keys omitted from `<Model>Relations` (compile-time prevention); still recorded in `__meta` as `composite: true` for runtime detection.

#### PR 2: Client Runtime (Types, Delegate, Integration)

**Files Modified**:
- `packages/client/src/types.ts` — Added conditional types `IncludeInput<Rel>`, `SelectedScalars<Row, S>`, `Payload<Row, Rel, A>` (real narrowing, GetPayload-style); added `include?` to FindManyArgs/FindFirstArgs/FindUniqueArgs; added RelationMeta and ModelMeta.relations.
- `packages/client/src/delegate.ts` — Added 4th generic `Rel`; `siblings?: () => SiblingRegistry` ctor arg; private `loadRelations` method for batched loading; join-key forcing/stripping on both parent and child sides; composite-key `IndigoRelationError` rejection.
- `packages/client/src/realtime-delegate.ts` — Propagates `Rel` and `siblings` through to `super()`; dispatch logic unchanged (regression confirmed).
- `packages/client/test/typecheck.mjs` — GetPayload checkpoint with `tsc --noEmit` on a hand-authored User/Post fixture (1 test, PASS, narrowing holds).
- `packages/client/test/relations.mjs` — 14 integration tests covering batch/stitch/pagination/join-key-stripping/composite rejection/realtime regression.
- `packages/generator/src/client.ts` (Phase 7) — Threads 4th generic through `ModelDelegate`/`RealtimeModelDelegate`; builds `__delegates` sibling registry with lazy construction and post-construction registration.
- `packages/generator/test/transaction-emission.mjs` — Updated 6 assertions to match new 4-generic delegate signature.

**Key Decisions**:
- Full conditional `Payload<Row, Rel, A>` type narrowing implemented; GetPayload checkpoint confirmed narrowing holds, no fallback needed.
- Sibling delegates reached via lazy registry thunk, avoiding construction-order cycles.
- Round trips = 1 + distinct included relations (bounded, never per-row).

## Rollback Plan

Additive change; `include` is optional, existing calls unchanged.

1. Revert `packages/generator/src/client.ts` (PR 1 diff) and new test files.
2. Revert `packages/client/src/{types,delegate,realtime-delegate}.ts` (PR 2 diff) and new test files.
3. Run `pnpm build && pnpm lint && pnpm test` to confirm clean state.
4. No DB migration or state change required.

## Scope Boundaries Enforced

The following were explicitly scoped OUT and remain deferred:

| Out of Scope | Follow-up Change | Rationale |
|--------------|------------------|-----------|
| `_count` aggregation on relations | `relation-count-aggregate` | Requires new SQL GROUP BY shape. |
| Nested `include` depth ≥ 2 | Future (no named follow-up yet) | Increases algorithm complexity; single-level sufficient for MVP. |
| Relation-scoped where/orderBy/take/skip | N/A | Type-level prevented in `IncludeInput<Rel>` shape. |

These remain out of scope and are not part of this epic's completion.

## Roadmap Phase 2 Epic Status

### Epic 2 of 8: "Relations" — COMPLETE

**Completed Slices**:
1. **relations-epic** (archived 2026-08-11) — Relation pairing in IR; target model identity; inverse detection.
2. **relations-include-select** (this change, archived 2026-08-11) — Include/select query API; return-type narrowing; batched loading.

**Remaining Gaps** (Explicitly Deferred, Not Blockers):
- `_count` aggregation — separate `relation-count-aggregate` change.
- Depth ≥ 2 nested include — future change, no name assigned yet.

This epic closure means IndigoDB is now **an ORM at the read boundary** with correct cardinality, type-honest returns, and batched loading — the core relation-loading capability the roadmap required for Phase 2.

## Key Learnings

1. The two-layer composite-key rejection (compile-time omission from `<Model>Relations`, runtime `IndigoRelationError` marker) prevents both type-level and runtime confusion at different boundaries without sacrificing clarity.
2. The sibling delegate lazy-registry pattern (registries built post-construction, accessed via thunk) is robust for avoiding construction-order cycles while keeping ModelDelegate constructors clean and positional.
3. The GetPayload-style conditional type narrowing holds in practice for Indigo's API shape, so the optional `Row & Partial<Pick<Rel, …>>` fallback was never needed — full compile-time narrowing ships.
4. Round-trip guarantees (1 + relation count) scale gracefully with relation cardinality and parent row count, making the API predictable for performance-sensitive callers.
5. Realtime's separate refetch path (no include passed to internal findFirst) remains an easy regression test, ensuring this change does not silently affect subscription behavior.

## Verification Checklist (Per Skill §4)

- [x] Main specs updated correctly (`client-relation-loading`, `client-query-type-safety` both created in `openspec/specs/`)
- [x] Change folder moved to archive at `openspec/changes/archive/2026-08-11-relations-include-select/`
- [x] Archive contains all artifacts (proposal, specs, design, tasks, verify-report)
- [x] Archived tasks.md has no unchecked implementation tasks (all 39/39 complete)
- [x] Active changes directory no longer has this change
- [x] Verbatim diff -r readback confirms archive matches pre-move snapshot (no byte differences)
- [x] Archive-report twin exists on filesystem and recorded in Engram (traceability)

---

**Archive completed**: 2026-08-11  
**Engram observations**: #528, #529, #530, #531, #532, #534  
**Filesystem twin**: `openspec/changes/archive/2026-08-11-relations-include-select/archive-report.md`
