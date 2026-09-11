# Archive Report: Surface Real Indexes in the Studio Docs View

**Change**: studio-index-surfacing  
**Date**: 2026-09-11  
**Status**: COMPLETE  
**Branch**: studio-index-surfacing (4 commits)  
**Archiving Agent**: sdd-archive (Haiku 4.5)

---

## Executive Summary

Change `studio-index-surfacing` has been fully planned, implemented, verified, and archived. The docs view now renders real indexes from the schema IR instead of fabricating them, fixing a data-loss defect that revealed three upstream issues: index data was never being read from the IR, composite primary keys produced invalid SQL, and physical column names (after `@map`) were not being used consistently. All 22 implementation tasks completed, 6 requirements and 16 scenarios verified, 0 CRITICAL findings.

---

## Final State Authority

This archive report records the state **at close** per the Task Completion Gate and Final-State Authority hierarchy:

1. **Persisted tasks artifact**: `openspec/changes/archive/2026-09-11-studio-index-surfacing/tasks.md` — all 22 tasks complete with checkmarks, no unchecked implementation tasks.
2. **Explicit final-state facts**: Orchestrator launch prompt confirmed: verify-report verdict pass (0 CRITICAL), 6/6 requirements, 16/16 scenarios, test_exit_code 0. WARNING about test count discrepancy in apply-progress.md (12/12 reported but actually 13/13) was noted as cosmetic and confirmed by verify-report.
3. **Verify-report and apply-progress**: Intermediate snapshots, used for attribution only when ranked lower than persisted artifacts and launch facts.

---

## Capability Merge Summary

### NEW Capability: studio-docs-ddl
- **Status**: Created
- **Location**: `openspec/specs/studio-docs-ddl/spec.md`
- **Requirements**: 5
  1. Resolved index data survives the adapter boundary (2 scenarios)
  2. Rendered DDL contains no fabricated index statement (5 scenarios)
  3. `USING <method>` is emitted only when the index declares a type (2 scenarios)
  4. Primary-key clauses derive from `table.primaryKey`, never hardcoded (2 scenarios)
  5. Every identifier a `PRIMARY KEY` or `CREATE INDEX` clause references corresponds to a rendered column line (2 scenarios)
- **Total scenarios**: 11

**Verification**: `openspec/specs/studio-docs-ddl/spec.md` exists with exactly 5 requirements. ✅

### MODIFIED Capability: studio-ui-honesty
- **Status**: Merged (1 requirement added)
- **Location**: `openspec/specs/studio-ui-honesty/spec.md`
- **Added requirement**: "Docs-view DDL never fabricates schema data" (3 scenarios)
  - Scenario: A table with zero indexes shows no fabricated index
  - Scenario: A table with a real index shows exactly that index
  - Scenario: Primary-key reference matches the declared schema
- **Requirement count before merge**: 10
- **Requirement count after merge**: 11
- **Merge method**: Native `sdd-archive-compose` (exit 0)

**Verification**: `openspec/specs/studio-ui-honesty/spec.md` has exactly 11 requirements post-merge, no collisions with existing titles. ✅

**Merge command**:
```bash
gentle-ai sdd-archive-compose \
  --canonical "openspec/specs/studio-ui-honesty/spec.md" \
  --delta "openspec/changes/studio-index-surfacing/specs/studio-ui-honesty/spec.md" \
  --output "openspec/specs/studio-ui-honesty/spec.md.compose-tmp"
```
Exit status: 0 (success)

---

## Implementation Summary

**Commits**: 4 on branch `studio-index-surfacing`  
**Changed files**: 4
- `apps/studio/src/types.ts` — Added `indexes?: ResolvedIndex[]` to `Table` interface; narrowed `primaryKey` doc comment
- `apps/studio/src/lib/schema-adapter.ts` — `resolvedToTables` now maps `table.indexes`
- `apps/studio/src/features/docs/lib/ddl-generator.ts` — Deleted fabricated `idx_<table>_lookup` line, rewrote to render real indexes with table-level PRIMARY KEY and physical column names
- `apps/studio/src/features/docs/lib/ddl-generator.test.ts` — New vitest file (13 tests: 2 adapter-boundary + 10 scenario rows + 1 @map identifier-correspondence invariant)

**Test Results**:
- Focused suite: 13/13 passed (includes mandatory mutation proofs for fabrication absence and `usingClause` default-free contract)
- Full workspace: `pnpm test` — 20/20 Turbo tasks, Studio 30/30 test files including new ddl-generator tests
- Build: `pnpm clean && pnpm build --force` — 11/11 tasks successful
- Lint: `pnpm lint` — 21/21 tasks successful (Studio's `tsc -b --noEmit` confirmed)

---

## Root Cause Analysis and Key Lessons

**Central lesson**: A fabricated UI value often marks a data-loss point upstream, not laziness in the renderer.

### The Four Defects

1. **Index data loss (adapter layer, primary defect)**  
   `apps/studio/src/lib/schema-adapter.ts` never read `ResolvedTable.indexes`. The `Table` interface had no `indexes` field. **The fabrication existed because the real data had already been dropped upstream.** This is the root cause of the entire change. A future maintainer seeing fabricated `idx_<table>_lookup` in DDL output would blame the renderer; the real defect was that the adapter discarded the data before the renderer could use it.

2. **Fabricated index statement (renderer)**  
   `generateTableDDL` rendered `CREATE INDEX idx_<table>_lookup ON <table>(id)` labelled `-- Create optimized index` for every table, whether or not a real index existed. This was the user-facing symptom.

3. **Invalid SQL for composite primary keys (renderer)**  
   `if (col.isPK) line += ' PRIMARY KEY'` ran per-column, so a two-column PK emitted two inline `PRIMARY KEY` clauses, which Postgres rejects as invalid SQL. Nobody had noticed **because no test for `generateTableDDL` had ever existed** — the entire rendering pipeline was untested. Caught only when this change introduced the first test suite.

4. **Regression: physical vs field names (adapter boundary)**  
   `ResolvedTable.primaryKey` and `ResolvedIndex.columns` are always physical column names (dbName). The adapter maps field names to physical names via `dbName`. When a field carries `@map` (e.g., field `authorId` → physical `author_id`), the PK/index clause must reference the physical name or it references a column that doesn't exist in the rendered column list. Example: a table with `@@id authorId @map("author_id")` would render:
   ```sql
   CREATE TABLE ... (
     author_id TEXT,        -- column line, physical name
     ...
   )
   PRIMARY KEY (authorId)   -- wrong: references nonexistent column
   ```
   This regression was introduced, caught at the gatekeeper before verify, and fixed in commit `fab2f85` by adding `dbName?: string` to `TableColumn` and a `physicalName(col)` helper. The spec's fifth requirement was written after this discovery to prevent recurrence.

---

## Test Suite Coverage and Mutation Proof

**Test file**: `apps/studio/src/features/docs/lib/ddl-generator.test.ts`

**Fixture design**: Real `parse` + `resolve` pipeline via `@indigodb/core` (no mocking), except two renderer-only scenarios with hand-built `Table` objects.

**Coverage**:
- Scenario rows 1–10: one per spec scenario (10 total)
- Adapter-boundary scenarios: 2 (indexes reach adapted Table, empty array maps to [])
- Invariant test: 1 (@map identifier-correspondence, catches physical/field-name divergence)
- **Total**: 13 tests

**Mutation proofs** (mandatory, named in design, independently verified):
1. **Fabrication absence**: Re-appended `idx_${table.name}_lookup` line to `ddl-generator.ts`. Row 1 reddened on assertion diff showing the unexpected `CREATE INDEX idx_T_lookup` line — an assertion diff, not a `TypeError`. Reverted.
2. **`usingClause` default-free contract**: Changed `usingClause` to `index.type ?? 'btree'`. Row 3 reddened on assertion diff showing the injected `USING btree ` clause — real assertion diff, not a `TypeError`. Reverted.

**Verification note** (per verify-report): `apply-progress.md` reported "12/12" test count (undercount by one), but the actual test file contains 13 and all pass. This is a cosmetic discrepancy in the apply-phase snapshot, not a correctness issue. The @map invariant test exists, runs, passes, and was independently mutation-proven.

---

## Test Count Discrepancy Resolution

**Issue**: `apply-progress.md` (task 4.2, lines 52, 96) reports the focused suite as "12/12 passed" or "13/13 passed" inconsistently.

**Fact**: The actual test file `ddl-generator.test.ts` contains exactly 13 tests:
- 10 scenario rows (3.2–3.11)
- 2 adapter-boundary scenarios (3.1, measuring index presence/absence)
- 1 @map identifier-correspondence invariant test

**Root cause**: The apply phase documented 12 as a working hypothesis before the invariant test was added; the spec's fifth requirement was written after the regression was discovered, and the test was added to close that spec requirement.

**Resolution**: Verify-report independently confirmed all 13 tests pass and the @map invariant is mutation-proven. This archive report records the final count as 13/13.

---

## Archive Contents Verification

- [x] proposal.md ✅ — archived at `openspec/changes/archive/2026-09-11-studio-index-surfacing/proposal.md`
- [x] specs/ ✅ — archived with delta specs at `openspec/changes/archive/2026-09-11-studio-index-surfacing/specs/`
- [x] design.md ✅ — archived
- [x] tasks.md ✅ — 22/22 tasks complete, no unchecked implementation tasks
- [x] exploration.md ✅ — archived
- [x] apply-progress.md ✅ — archived
- [x] verify-report.md ✅ — archived

---

## Canonical Spec Changes

**Before archive**:
- `openspec/specs/studio-ui-honesty/spec.md`: 10 requirements
- `openspec/specs/studio-docs-ddl/spec.md`: does not exist

**After archive**:
- `openspec/specs/studio-ui-honesty/spec.md`: 11 requirements (10 original + 1 added via merge)
- `openspec/specs/studio-docs-ddl/spec.md`: 5 requirements (new capability)

**Merge verification**: Both specs confirmed by requirement count grep. No manual Read/Edit merge was performed; composition used native `sdd-archive-compose` command.

---

## Deferrals and Out of Scope

Four additional docs-feature honesty defects were identified but deliberately kept out and recommended as a separate follow-up change, sharing the `studio-ui-honesty` spec as their seam:

1. `apps/studio/src/features/docs/components/TableHeroBanner.tsx:34` — Fabricated "cluster branches" capability claim in user-facing copy (most serious — no such feature exists in the codebase)
2. `apps/studio/src/features/docs/components/ColumnsSpecTable.tsx:51` — Placeholder text presented as real documentation
3. `apps/studio/src/features/docs/components/RelationsPanel.tsx:57` — "X live rows" counter over an always-empty `records` array
4. `apps/studio/src/features/docs/hooks/useDocBrowser.ts:59` — `alert()` confirmation on copy (live violation of existing `studio-ui-honesty:184-187`)

Also deferred: partial/expression indexes and client-side index-awareness (separate roadmap items).

---

## Verification Audit Trail

**Verdict**: PASS  
**CRITICAL findings**: 0  
**WARNING findings**: 1 (test count cosmetic discrepancy in apply-progress, confirmed resolved and cosmetic by verify-report)  
**Requirements**: 6/6 compliant  
**Scenarios**: 16/16 compliant  
**Tasks**: 22/22 complete

**Evidence**:
- Build exit code: 0
- Test exit code: 0
- Lint exit code: 0
- Independent mutation proofs: 2/2 passed (both reverted)
- Physical-name invariant: independently mutation-proven to fail on its own assertion

**See**: `openspec/changes/archive/2026-09-11-studio-index-surfacing/verify-report.md` for full verification details.

---

## Archive Location

**Path**: `openspec/changes/archive/2026-09-11-studio-index-surfacing/`

**Mechanical move verification**: `diff -r` confirmed source and destination identical (snapshot created pre-move, compared post-move, empty diff result).

**Git tracking**: Moved via `git mv` into archive directory.

---

## Mechanical Copy Contract Evidence

All merges and archive operations followed the Mechanical Copy Contract:
- Delta spec merge: native `sdd-archive-compose` command (exit 0) — no Read/Write
- New spec copy: shell `cp` with `diff -r` readback verification — no Read/Write
- Archive move: shell `git mv` with `diff -r` readback verification — no Read/Write

No model-based Read/Write operations were used for any file artifacts, preserving byte-identity for audit trail integrity.

---

## Conclusion

Change `studio-index-surfacing` is fully complete and archived. Two new/modified capabilities are now part of the source of truth, the indexes data-loss chain is fixed end-to-end (IR → adapter → renderer), and the test suite ensures future regressions in this critical path are caught early.

The change exemplifies a key lesson: when a renderer fabricates data, check upstream first — the real defect is often a data-loss boundary being silently crossed.

---

*Archive report generated 2026-09-11 by sdd-archive (Haiku 4.5)*
