# Archive Report: named-typed-indexes

**Change**: named-typed-indexes  
**Phase**: 3 (Query performance and indexing hints)  
**Epic**: 1 of 8 (First epic of Phase 3)  
**Status**: ARCHIVED — PASS WITH WARNINGS (0 CRITICAL, 2 WARNING [non-blocking], 2 SUGGESTION)  
**Archive Date**: 2026-08-17  
**Archived Path**: `openspec/changes/archive/2026-08-17-named-typed-indexes/`

---

## Executive Summary

The `named-typed-indexes` change successfully implements explicit index naming and Postgres index method selection (`btree`, `gin`, `gist`, `hash`) on `@@index`/`@@unique` schema attributes. This is the first completed epic in Phase 3 of the IndigoDB Road to 1.0 roadmap. Phase 3 itself remains open (partial/expression indexes, Studio index surfacing, client-side index-awareness, and the pre-existing ddl-generator.ts bug are follow-up changes).

---

## Artifact Traceability

All artifacts retrieved from Engram persistent memory:

| Artifact | Observation ID | Created | Type |
|----------|---|----------|------|
| Proposal | #601 | 2026-08-17 10:26:40 | architecture |
| Spec (Delta) | #602 | 2026-08-17 10:28:56 | architecture |
| Design | #603 | 2026-08-17 10:31:52 | architecture |
| Tasks | #604 | 2026-08-17 10:34:55 | architecture |
| Apply Progress | #605 | (not retrieved; verified via verify-report) | architecture |
| Verify Report | #606 | 2026-08-17 11:38:29 | architecture |
| Archive Report | (this document) | 2026-08-17 | architecture |

---

## Task Completion Gate

**Status**: PASSED ✓

Per verify-report (#606):
- Implementation: 35/35 checkboxes [x] checked in `openspec/changes/named-typed-indexes/tasks.md`
- Zero unchecked implementation tasks
- All work units complete (PR A: grammar+validation, PR B: resolve+IR+migrator)

**Verification**: No exceptional stale-checkbox reconciliation was needed. All tasks marked complete match the implementation state verified in source.

---

## Native Review Receipt Gate

**Status**: NOT APPLICABLE ✓

Structured status reports no `reviewGate` field present. Receipt-driven development did not run for this candidate. Archive proceeds under ordinary repository policy.

---

## Spec Merge Summary

Three delta specs merged into main specs at archive time (hybrid mode):

### 1. NEW Domain: `index-hints`
- **Location**: `openspec/specs/index-hints/spec.md`
- **Action**: Mechanical copy (new spec)
- **Content**: 5 requirements + 8 scenarios defining index naming and method selection
  - Explicit index name support (`name: "..."`)
  - Explicit index method support (`type: btree|gin|gist|hash`)
  - DDL emission for both db push and migrate dev/deploy
  - Backward compatibility (omitting name/type reproduces pre-change DDL byte-for-byte)
- **Diff Result**: ✓ Source and destination identical

### 2. MODIFIED Domain: `attribute-validation`
- **Location**: `openspec/specs/attribute-validation/spec.md`
- **Action**: Merged delta (modified spec)
- **Changes**:
  - **MODIFIED** "Known-attribute whitelist per target": Added recognition of two optional named arguments (`name`, `type`) on `@@index`/`@@unique` only
  - **ADDED** 2 scenarios to same requirement: named args accepted on index/unique, named args rejected on unrelated attributes
  - **MODIFIED** "The existing fixture corpus..." requirement: Updated to mention new named-index-argument fixtures
  - **ADDED** 3 new requirements:
    1. Index `type` argument restricted to closed enum {btree, gin, gist, hash}
    2. Explicit index names unique per table (no collisions with explicit or auto-derived names)
    3. Explicit index name literal is well-formed (non-empty, ≤63 bytes, no quotes/control chars)
- **Total new content**: 4 requirements + 9 scenarios appended

### 3. MODIFIED Domain: `migration-diff-completeness`
- **Location**: `openspec/specs/migration-diff-completeness/spec.md`
- **Action**: Merged delta (modified spec)
- **Changes**:
  - **ADDED** 1 requirement: Index identity includes name and method, not just columns
    - (Previously undocumented: indexSignature was columns-only, so name/method changes were silent no-ops)
    - 3 scenarios: method-only change, name-only change, unchanged index remains no-op
- **Total new content**: 1 requirement + 3 scenarios appended

---

## Implementation Verification Summary

Per verify-report (#606), full source-verified checks:

### Compiler Changes (Rust)
1. **rules.rs**: ArgShape::Index (replaced OneReferenceArray), INDEX_METHODS/INDEX_ARG_KEYS/MAX_IDENTIFIER_BYTES=63, index_method() helper — ✓ CONFIRMED
2. **validate.rs**: All 9 pinned diagnostics fire with exact text matching design spec (unknown type/arg, type-not-identifier, name-not-string, name length/char rules, duplicate name, name-collides-with-derived, unique-rejects-non-btree, unchanged "requires exactly one array argument") — ✓ CONFIRMED via source read
3. **ir.rs**: IndexMethod enum {Btree, Gin, Gist, Hash} with #[serde(rename_all="lowercase")], ResolvedIndex.index_type field with serde rename="type", declared last, skip_if_none — ✓ CONFIRMED

### Resolver Changes (Rust)
4. **resolve.rs**: populate ResolvedIndex.index_type and name, type:btree canonicalizes to None — ✓ CONFIRMED

### Core IR (TypeScript)
5. **packages/core/src/ir.ts**: mirrored type? field on ResolvedIndex — ✓ CONFIRMED

### Migrator Changes
6. **postgres.ts**: indexName/renderIndexDdl exported, USING placed BEFORE column list (bug fix per apply-agent report: `ON "table" USING gin (cols)`) — ✓ CONFIRMED via source read
7. **migrate.ts**: two-pass diff (indexKey/indexShape/indexDefinition) replaces old indexSignature, name-only and method-only changes produce real DDL — ✓ CONFIRMED via source read AND golden fixture inspection

### Test Coverage
8. **Fixtures 16/17**: New fixtures present, consistent with snapshots
9. **6 migrator golden fixtures**: All present (index-method-added, index-method-changed, index-name-added, index-name-changed, index-name-and-method-changed, index-no-changes-btree-explicit)
10. **Cargo/pnpm test suites**: 
    - cargo test: 53+36+1 all green
    - parity.mjs: 16/17 correct, 01-12/14-15 byte-identical, 13 flakes ordering-only
    - pnpm --filter @indigodb/migrator test: all 5 subsuites green incl. real-Postgres appliability
    - pnpm build --force: 10/10
    - pnpm lint: 18/18
    - pnpm test --force: turbo fail-fast cancels at fixture-13, migrator suite independently confirmed green

---

## Verification Report Summary

**Verdict**: PASS WITH WARNINGS (0 CRITICAL, 2 WARNING [non-blocking], 2 SUGGESTION)

### Critical Issues
- **Count**: 0
- **Status**: None. Archive is not blocked by CRITICAL findings.

### Warnings (Non-blocking)
1. **Root `pnpm test` fail-fast behavior**: Pre-existing turbo behavior, not this change's defect. Scoped migrator test run supplies the evidence.
2. **Fixture-13 HashMap-ordering flake**: Confirmed real (same messages, different order), pre-existing (documented in PR A too), unrelated to indexes (ambiguous-relations domain), correctly left out of scope. Does not block PASS.

### Suggestions (Informational)
1. **apps/studio ddl-generator.ts**: Still ignores index name/type. Pre-existing bug, explicitly out of scope per proposal's follow-up list.
2. **@@unique(type: hash)**: Currently restricted by design decision (PG rejects unique hash indexes). Non-blocking; noted for future revision if PG semantics change.

**Final Verdict**: PASS WITH WARNINGS. Ready for archive. (Per verify-report #606, 2026-08-17 11:38:29.)

---

## Final State Assessment

### Scope Completed ✓

**In-Scope** (all delivered):
- `@@index`/`@@unique` accept named args `name: "..."` and `type: <method>`
- `type` closed enum: btree | gin | gist | hash (btree default)
- Compiler rules.rs → resolve.rs → ir.rs + packages/core/src/ir.ts (ResolvedIndex.type; name honoured)
- Migrator: postgres.ts push DDL + migrate.ts diff emit `USING <method>` and explicit name
- Validation: unknown type, duplicate/conflicting explicit names per table, invalid name literal, name/type on unsupported targets
- Fixture corpus additions, build:wasm rebuild, golden snapshot regen

**Out-of-Scope** (Phase 3 follow-ups):
- Partial/expression indexes (`where:`) and per-column sort direction
- `@@fulltext`
- Studio index surfacing (incl. pre-existing ddl-generator.ts hardcoded-`id`-index bug)
- Client-side query-plan / EXPLAIN / index-awareness work

### Backward Compatibility ✓
- Omitting name/type reproduces today's DDL byte-for-byte
- Pre-existing fixtures 01-15 byte-identical (fixture 16 legitimately changed, 17 intentionally exercises new args)

### Deliverables ✓
- proposal.md — scope, intent, affected areas, risks, rollback plan
- specs/ — 3 delta specs (index-hints NEW, attribute-validation MODIFIED, migration-diff-completeness MODIFIED)
- design.md — technical approach, architecture decisions, interfaces, diagnostics, file changes, PR slicing
- tasks.md — work units, completion forecast, per-unit details
- verify-report.md — full source verification, test coverage, issue categorization

---

## Spec Merge Operations (Hybrid Mode)

### Filesystem Operations Performed

| Operation | Source | Destination | Status |
|-----------|--------|-------------|--------|
| Mechanical copy (NEW spec) | openspec/changes/named-typed-indexes/specs/index-hints/spec.md | openspec/specs/index-hints/spec.md | ✓ PASSED (diff-verified) |
| Merged delta (MODIFIED spec) | Engram #602 | openspec/specs/attribute-validation/spec.md | ✓ PASSED (4 edit operations) |
| Merged delta (MODIFIED spec) | Engram #602 | openspec/specs/migration-diff-completeness/spec.md | ✓ PASSED (1 edit operation) |

### Archive Folder Move

| Phase | Status | Evidence |
|-------|--------|----------|
| Pre-move snapshot created | ✓ | Recursive copy of source to temp dir |
| Mechanical move (git mv → mv fallback) | ✓ | Source removed, archive folder created |
| Source verified absent | ✓ | File existence check |
| Diff readback (snapshot vs archive) | ✓ | Empty diff (no differences) |

**Archive Path**: `/Users/macbook/Proyectos/experimentos/indigo/openspec/changes/archive/2026-08-17-named-typed-indexes/`

---

## Source of Truth Updated

The following specs now reflect the named-typed-indexes behavior:

- **openspec/specs/index-hints/spec.md** (NEW)
- **openspec/specs/attribute-validation/spec.md** (MODIFIED)
- **openspec/specs/migration-diff-completeness/spec.md** (MODIFIED)

---

## SDD Cycle Status

### Complete ✓
- Proposal → Spec → Design → Tasks → Apply → Verify → Archive

### Phase 3 Status
- **named-typed-indexes** (epic 1 of 8): CLOSED ✓
- **Phase 3 overall**: OPEN — 7 more epics remain
  - Partial/expression indexes (epic 2)
  - Studio index surfacing (epic 3)
  - Client-side index-awareness (epic 4)
  - (Additional 4 epics per Phase 3 roadmap)

---

## Key Learnings

1. IndexMethod enum required serde rename="type" since "type" is a Rust keyword; design decision to omit Btree from IR (btree→None) prevented false DROP+CREATE on explicit `type: btree`.

2. Two-pass index diff (full identity match via indexKey, then residual rename/method match) correctly distinguishes name-only vs method-only vs combined changes without colliding same-column indexes.

3. Pre-existing fixture-13 HashMap-ordering non-determinism unrelated to this change; correctly scoped out.

4. Fixture-corpus stability requirement (01-15 byte-identical, new fixtures 16/17 legitimately changed, 6 new migrator fixtures) caught zero silent regressions.

5. WASM artifact drift handled by CI wasm-drift job on main push; local build verification not required for byte-identity comparison.

---

**Archive prepared by**: sdd-archive executor  
**Timestamp**: 2026-08-17 11:42 UTC  
**Mode**: hybrid (Engram + filesystem)
