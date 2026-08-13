# Archive Report: Native Type Attributes (`@db.X`)

**Archived**: 2026-08-12
**Change**: native-type-attributes
**Archive Location**: `openspec/changes/archive/2026-08-12-native-type-attributes/`

---

## Archive Summary

The `native-type-attributes` change — the second and final half of Phase 2 epic 4/5 ("Native type attributes + driver adapters") — has been successfully completed, verified, and archived. This closes the entire Phase 2 of the IndigoDB Road to 1.0 roadmap.

**Verification Status**: PASS (0 CRITICAL, 0 WARNING, 1 cosmetic SUGGESTION)
**Implementation**: Complete (48/48 real tasks, all marked complete in tasks.md)
**Artifacts Synced**: 3 delta specs merged into main specs

---

## Phase 2 Epic Completion

This archive marks the completion of **ALL 5 epics of Phase 2** ("Make it an ORM"):
1. ✅ extension-seam (archived)
2. ✅ where-composition (archived)
3. ✅ batch-aggregate (archived)
4. ✅ type-honesty (archived)
5. ✅ native-type-attributes + driver-adapters (archived) — this archive closes both the second half (native-type-attributes, current) and the first half (client-driver-adapters, previously archived)

**Phase 2 is now CLOSED.** The IndigoDB compiler and runtime now support namespace attributes, logical-to-physical type override, native Postgres type emission, and driver adaptation for external ORMs.

---

## SDD Artifacts & Observation IDs

All artifacts retrieved from Engram before archive:

| Artifact | ID | Observation | Status |
|----------|----|-----------|----|
| Proposal | 583 | `sdd/native-type-attributes/proposal` | Active |
| Spec (3 delta specs) | 584 | `sdd/native-type-attributes/spec` | Active |
| Design | 585 | `sdd/native-type-attributes/design` | Active |
| Tasks | 586 | `sdd/native-type-attributes/tasks` | Active |
| Verify-Report | 594 | `sdd/native-type-attributes/verify-report` | Active |

---

## Delta Specs Merged

### 1. native-type-attributes (NEW)
- **Status**: Merged into `openspec/specs/native-type-attributes/spec.md`
- **Action**: Created new main spec (no prior spec existed)
- **Content**: Defines namespaced `@db.X(...)` attribute syntax, AST representation with `namespace: Option<String>`, and resolved IR `nativeType` field
- **Requirements**: 3 base requirements + 6 scenarios

### 2. attribute-validation (MODIFIED)
- **Status**: Merged into `openspec/specs/attribute-validation/spec.md`
- **Actions**:
  - Updated "Known-attribute whitelist per target" requirement to explain namespace handling and add 4 new scenarios (native type recognized, unknown native type, unknown namespace)
  - Added new requirement "Native type attributes require scalar compatibility" with 2 scenarios (incompatible scalar, compatible scalar)
  - Updated "The existing fixture corpus remains valid" requirement to reflect new fixture additions and add 3 new scenarios (pre-existing unaffected, new accepted fixture, new rejected fixture)
- **Details**: Whitelist now admits `db` namespace restricted to `{VarChar, Uuid, Numeric}`; scalar compatibility matrix enforced (String for VarChar/Uuid, Float/Decimal for Numeric)

### 3. migration-ddl-ordering (MODIFIED)
- **Status**: Merged into `openspec/specs/migration-ddl-ordering/spec.md`
- **Action**: Added new requirement "Column type rendering honors a native type override"
- **Content**: 4 scenarios covering native type override rendering, zero-argument forms, fallback to mapScalarToPg, and ADD COLUMN in versioned migrations
- **Details**: Deferred follow-up (ALTER COLUMN TYPE diffing) explicitly noted as out-of-scope

---

## Specs Sync Verification

**Mechanical Copy Contract**: All spec syncs performed via shell `cp -R` and `mv` commands only (no model Read/Write). Verified by verbatim `diff -r` output (empty = passing):

```
Archive verification PASSED - diff is empty (identical content)
```

**Main Specs Updated**:
- ✅ `openspec/specs/native-type-attributes/spec.md` — NEW (82 lines, 3 requirements)
- ✅ `openspec/specs/attribute-validation/spec.md` — MODIFIED (2 new requirements, 8 new scenarios, existing requirements preserved)
- ✅ `openspec/specs/migration-ddl-ordering/spec.md` — MODIFIED (1 new requirement, 4 new scenarios, existing requirements preserved)

---

## Change Folder Archive

**Archive Path**: `openspec/changes/archive/2026-08-12-native-type-attributes/`
**Contents**:
- ✅ `proposal.md` — User-facing intent and approach (confirmed user decision on namespace field)
- ✅ `specs/native-type-attributes/spec.md` — NEW capability delta spec
- ✅ `specs/attribute-validation/spec.md` — MODIFIED delta spec (whitelist opening, scalar compatibility)
- ✅ `specs/migration-ddl-ordering/spec.md` — MODIFIED delta spec (native type rendering)
- ✅ `design.md` — Technical approach, grammar, file changes, threat matrix
- ✅ `tasks.md` — 48 implementation tasks across PR A (19 tasks, parse-only) and PR B (29 tasks, semantic), all marked complete; explicit deferred follow-up noted

**Archive Verification**:
- ✅ Archive moved successfully from `openspec/changes/native-type-attributes/`
- ✅ Source directory removed (no orphaned files)
- ✅ Diff-verified byte-identical (mechanical copy integrity)
- ✅ All artifacts present and accounted for

---

## Task Completion Gate

**Status**: PASSED

All 48 real implementation tasks marked complete ([x]) in `tasks.md`:
- **PR A (19 tasks)**: Lexer `Dot` token (2), parser namespace grammar (4), AST `namespace` field + guards (3), TS mirror (1), validate.rs namespace whitelist (2), fixture 14 + WASM + parity (5) — all complete
- **PR B (29 tasks)**: rules.rs NATIVE_TYPE_RULES (3), validate.rs full diagnostics (6), resolve.rs + ir.rs nativeType (4), ir.ts mirror (1), migrator renderColumn (7), fixtures 15 + regen + parity (8) — all complete

**Follow-up Task** (correctly marked [ ] as deferred, not silently dropped):
- `packages/migrator/src/migrate.ts::alterColumn`/`diffResolved` does NOT diff `nativeType` changes between schema versions. User-confirmed deferred work. Adding `@db.X` to existing schema produces DDL via `renderPushSql` only until follow-up lands.

---

## Verification Report Summary

**Source**: Observation #594, `sdd/native-type-attributes/verify-report`, created 2026-08-12 19:55:32

**Verdict**: PASS

**Metrics**:
- 0 CRITICAL issues
- 0 WARNING issues  
- 1 cosmetic SUGGESTION (apply-progress memory claimed 52/52 tasks; live tasks.md shows 48 real checkboxes; file is ground truth; flagged as non-blocking bookkeeping note)

**Verification Depth**:
- Rust corpus: `cargo test 64/64` passing (all Rust units + fixtures)
- WASM rebuild: `build:wasm` rebuilt, verified via `git status` showing zero diff in fixture 01-13 snapshots
- Snapshot regen: Fixture 14 regenerated twice (PR A with empty `validation: []` and no `nativeType`, PR B with populated `nativeType`), fixture 15 added (new rejected-case fixture), all 01-13 confirmed byte-identical
- TS parity: `pnpm test` 16/16 passing (AST + ResolvedSchema + ValidationError verification)
- Package builds: `pnpm build --force 10/10`, `pnpm lint --force 18/18` all passing
- Correctness checks (per design):
  - ✅ `get_attr`/`has_attr` filter `a.namespace.is_none()` before name match (unit-tested in ast.rs)
  - ✅ `format_native_type_arg` uses i64 stringification for integral f64 (255.0 → "255"), verified in fixture 14 golden args
  - ✅ `renderColumn` branch order: autoincrement → nativeType → mapScalarToPg fallback, IDENTITY-wins test passes
  - ✅ Migrator DDL end-to-end test: same table with autoincrement ID and VARCHAR(255) bio verified
- Deferred follow-up: `migrate.ts::alterColumn` deferral documented as explicit non-silent follow-up, flagged to reviewers

---

## Known Gaps & Deferred Work

### Explicit Deferred Follow-up (NOT Silently Dropped)

**Change**: `packages/migrator/src/migrate.ts::alterColumn` / `diffResolved` native type diffing

**Status**: OUT OF SCOPE (user-confirmed)

**Details**: 
- Adding `@db.X` to an existing column in an existing schema does NOT generate an `ALTER COLUMN TYPE` statement in a versioned migration
- DDL for native type override appears only via `renderPushSql`/`CREATE TABLE` (for new columns) or `db push` (idempotent path)
- Until this follow-up lands, users who add `@db.X` to an existing column must manually manage the `ALTER COLUMN TYPE` statement or re-initialize the database
- **Flagged in**: Design (Migration/Rollout section), tasks.md (line 124), proposal (Success Criteria note), verify-report (design correctness point #4)

---

## Final-State Authority

This archive report describes the state of the change **at close**, not at earlier intermediate points:

- **Native Review Receipt Gate**: No review was conducted for this change (structural absence of review gate; receipt-driven development not activated for this candidate)
- **Task Completion Gate**: PASSED — all implementation tasks marked complete in persisted tasks.md, verified by live grep
- **Intermediate snapshots**: `apply-progress` and `verify-report` are dated intermediate records; their claims about incomplete/pending work are superseded by final completion evidence in this archive (see Task Completion Gate above)

This archive is the terminal record. Future readers consulting this archive will find the final state: complete, verified, merged, and closed.

---

## Rollback & Recovery

Per design's Rollout section:

- **PR A rollback**: `git revert <PR-A-SHA>` (clean revert); then:
  ```
  cd crates && cargo test
  pnpm --filter @indigodb/compiler build:wasm  # Rebuild artifact
  node packages/compiler/test/regen-snapshots.mjs
  pnpm test
  ```
  
- **PR B rollback**: `git revert <PR-B-SHA>` (clean revert alone, or on top of PR A revert); then same toolchain sequence

**No data migration required** — pure DDL opt-in schema feature. Existing schemas unaffected until `@db.X` is explicitly added.

---

## Archive Integrity

- ✅ Proposal, specs (3 delta), design, tasks, and verify-report all present and accounted for
- ✅ All observation IDs recorded above for traceability
- ✅ Main specs synced via mechanical copy (verbatim diff-verified empty)
- ✅ Change folder archived with date-prefixed name (2026-08-12)
- ✅ Source directory removed after successful move
- ✅ No breaking changes to existing functionality (backward-compatible whitelist opening, additive AST field, optional IR field)
- ✅ All 48 implementation tasks marked complete
- ✅ Verification PASSED with no blockers

**Ready for next phase.**
