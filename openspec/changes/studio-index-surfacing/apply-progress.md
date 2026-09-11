# Apply Progress: Surface Real Indexes in the Studio Docs View

## Mode

Strict TDD Mode (active). Every renderer/adapter task followed RED → GREEN → REFACTOR-equivalent
(the "REFACTOR" step for this change was the deliberate rewrite itself; no further cleanup needed
after GREEN). Both mandatory mutation proofs re-confirm RED sensitivity of the two riskiest
mechanisms named in design (`usingClause` and the fabricated index string).

## Completed Tasks (22/22)

### Phase 1: Preconditions
- [x] 1.1 Confirmed `mockData.ts` never sets `Table.indexes`/`Table.primaryKey` on any mock
  `Table` literal (the only hit is unrelated comment text) — rows 2 and 9 are genuinely reachable.

### Phase 2: Foundation — Types and Adapter
- [x] 2.1 `types.ts`: added `indexes?: ResolvedIndex[]` (optional, undefaulted), imported from
  `@indigodb/core`.
- [x] 2.2 `types.ts`: narrowed the `primaryKey` doc comment to name its actual
  consumer/row-identity fallback scope, not license for a renderer to invent `id`.
- [x] 2.3 RED: adapter-boundary test written first — failed with `table.indexes` `undefined`
  (real production defect, named assertion diff).
- [x] 2.4 GREEN: `schema-adapter.ts` now passes `indexes: table.indexes` through
  `resolvedToTables`; both adapter-boundary tests pass.

### Phase 3: Core Implementation — Test-First on the Renderer
- [x] 3.1 Test scaffold created (`ddl-generator.test.ts`), real `parse`+`resolve` pipeline via
  `@indigodb/core`, `// @vitest-environment node` (WASM unavailable under jsdom, same as
  `patch-semantics.test.ts`).
- [x] 3.2–3.11 RED: all 10 scenario-row tests written and confirmed failing against the unfixed
  `ddl-generator.ts` (9 failed on real assertion diffs; row 9 happened to already pass because
  the old code never invented a PK when no column was flagged `isPK` — confirmed intentionally,
  not silently accepted).
- [x] 3.12 GREEN: `ddl-generator.ts` rewritten — fabricated `idx_<table>_lookup` deleted outright;
  `usingClause(index: ResolvedIndex)` takes the index object (no `??`/`||` default surface);
  one `CREATE INDEX`/`CREATE UNIQUE INDEX` per `table.indexes` entry in array order, name emitted
  verbatim when present; table-level `PRIMARY KEY (cols)` derived from `table.primaryKey`, falling
  back to `isPK`-flagged columns only when `primaryKey` itself is absent, never a hardcoded `id`.
  All 12 tests (10 rows + 2 adapter-boundary) pass.
- [x] 3.13 Mutation proof #1 (mandatory): re-appended the deleted fabrication line. Row 1
  reddened on `expect(ddl).toBe(...)`, diff named the exact unexpected
  `CREATE INDEX idx_T_lookup ON T(id);` line — an assertion diff, never a `TypeError`. Reverted;
  suite re-confirmed green.
- [x] 3.14 Mutation proof #2 (mandatory): changed `usingClause` to `index.type ?? 'btree'`. Row 3
  reddened (diff showed the injected `USING btree ` clause) — real assertion diff, never a
  `TypeError`. Reverted; suite re-confirmed green.

### Phase 4: Spec and Verification
- [x] 4.1 Confirmed both spec deltas (`studio-docs-ddl` NEW, `studio-ui-honesty` ADDED) already
  match implemented behavior — no spec edits made, read-verify only.
- [x] 4.2 Focused suite: `pnpm --filter @indigodb/studio exec vitest run
  src/features/docs/lib/ddl-generator.test.ts` → 12/12 passed.
- [x] 4.3 `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`) → exit 0.

## Deviation from tasks.md (task 3.10)

Task 3.10 names `@@id([a, b])` as the composite-PK fixture syntax. **`@@id` does not exist in the
`.indigo` language** — `crates/indigo-compiler/src/rules.rs:14` explicitly names `@@id` as
outside the supported attribute whitelist (compiled silently pre-Phase-3, now a hard
`ValidationError`), and grep confirms no `@@id` handling in `resolve.rs`/`validate.rs`. A real
composite primary key is expressed instead by marking two fields `@id` — `resolve.rs:422-431`
collects every column with `is_pk` into `primary_key` with no arity limit, so two `@id` fields
legally produce a two-column composite key through the real compiler. Used that fixture instead;
it is the correct real-pipeline equivalent of what the task intended (an "adapter" entry, not a
hand-built `Table`), and it is what exercises the actual data-loss chain rather than a syntax the
compiler rejects.

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `apps/studio/src/types.ts` | Modified | Added `indexes?: ResolvedIndex[]`; narrowed `primaryKey` doc comment |
| `apps/studio/src/lib/schema-adapter.ts` | Modified | `resolvedToTables` now maps `table.indexes` |
| `apps/studio/src/features/docs/lib/ddl-generator.ts` | Modified | Real indexes, `usingClause`, table-level PK, fabrication deleted |
| `apps/studio/src/features/docs/lib/ddl-generator.test.ts` | Created | 12 tests: 10 scenario rows + 2 adapter-boundary, real parse+resolve pipeline |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.3/2.4 (adapter) | `ddl-generator.test.ts` | Unit | N/A (new file) | Written | Passed | 2 cases (present/absent indexes) | None needed |
| 3.2-3.12 (renderer) | `ddl-generator.test.ts` | Unit | N/A (new file) | Written (10 rows) | Passed (12/12) | 10 scenario rows | None needed — single cohesive rewrite |

### Test Summary
- **Total tests written**: 12
- **Total tests passing**: 12
- **Layers used**: Unit (12) — real `@indigodb/core` parse+resolve, no mocking (`node` vitest env)
- **Approval tests**: N/A — this was a defect fix with spec-driven target behavior, not a
  behavior-preserving refactor
- **Pure functions created**: `usingClause`, `indexStatement`, `primaryKeyColumns` (all pure)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm --filter @indigodb/studio exec vitest run src/features/docs/lib/ddl-generator.test.ts` → 12/12 passed |
| Runtime harness command/scenario and exact result | Real `parse`+`resolve` (`@indigodb/core`, no mock) → `resolvedToTables` → `generateTableDDL`; this IS the runtime boundary where the original defect lived — 12/12 passed through it |
| Rollback boundary | Single commit `25a503b`; revert it wholesale — no other file reads `Table.indexes` today |

## Full Verification (foreground, all commands)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | exit 0, 11/11 tasks successful |
| `pnpm lint` | exit 0, 21/21 tasks successful (Studio's `tsc -b --noEmit` confirmed, not the zero-file plain `tsc --noEmit`) |
| `pnpm test` | exit 0, 20/20 turbo tasks successful; Studio: 30/30 test files, 266/266 tests (includes new `ddl-generator.test.ts` 12/12); CLI: 24/24 files; `@indigodb/realtime` Postgres-gated suites correctly `SKIP` (no `INDIGODB_TEST_DATABASE_URL`); pack-contents + version-parity guards green |
| Mutation proof #1 (fabricated index) | Row 1 reddened on named assertion diff, reverted |
| Mutation proof #2 (`?? 'btree'` default) | Row 3 reddened on named assertion diff, reverted |

## Workload / PR Boundary

- Mode: single PR (as forecast — Low risk, ~230-280 lines estimated)
- Current work unit: `studio-index-surfacing-single-pr` (the only unit; indivisible data-loss chain)
- Boundary: types → adapter → renderer → test, all four files landed together in commit `25a503b`
- Estimated review budget impact: within the 800-line project budget; well under

## Status

22/22 tasks complete. Ready for verify.
