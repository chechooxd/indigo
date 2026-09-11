# Tasks: Surface Real Indexes in the Studio Docs View

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~230-280 (types +10, adapter +3, generator ~-15/+45 net rewrite, new test ~150-180, spec deltas ~120) |
| 800-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
800-line budget risk: Low

Four source files (~60 lines), one new vitest file (~150-180 lines covering 10 scenario rows + 2
mutation proofs), and two spec deltas (~120 lines, already written by sdd-spec) total well under
the 800-line project budget even summed together — no split needed. Single PR is honest here; do
not invent a chain the size doesn't justify.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Types + adapter + generator + test, all four files land together (the fix is one indivisible data-loss chain) | PR 1 | `node --run test --filter=@indigodb/studio -- ddl-generator` (or `pnpm --filter @indigodb/studio exec vitest run src/features/docs/lib/ddl-generator.test.ts`) | Real `parse`+`resolve` via `@indigodb/core`, no mocking — same harness as `patch-semantics.test.ts` | Revert the single commit; no other file reads `Table.indexes` today (proposal "Rollback Plan") |

## Phase 1: Preconditions

- [x] 1.1 Confirm `apps/studio/src/data/mockData.ts` (read-only) never sets `Table.indexes` or
  `Table.primaryKey` on any mock `Table` literal — CONFIRMED by grep: the only `indexes`/`primaryKey`
  hit in that file is unrelated comment text in a mock comment row (`'Could we optimize the
  composite indexes?'`), not a field assignment. Rows 2 and 9 (mock-`Table`, field genuinely absent)
  are reachable as designed; they will not silently degrade into duplicates of rows 1/7.

## Phase 2: Foundation — Types and Adapter

- [x] 2.1 In `apps/studio/src/types.ts` (`Table` interface, ~line 26-40), add
  `indexes?: ResolvedIndex[]` with a doc comment: mirrors `ResolvedTable.indexes`
  (`packages/core/src/ir.ts:198`), optional and undefaulted so "unknown" (mock data) stays
  distinguishable from "verified none" (`[]`), matching the `realtime`/`primaryKey` convention at
  the same file. Import `ResolvedIndex` from `@indigodb/core`.
- [x] 2.2 In the same file, narrow the `primaryKey` doc comment (currently "falls back to `id`",
  `types.ts:33`) to name that fallback's actual scope — consumer/row-identity, not the DDL renderer
  — so a future reader does not repeat this defect (flagged by design's Open Questions).
- [x] 2.3 RED: write a failing assertion in `ddl-generator.test.ts` (created in 3.1) for the
  adapter-boundary scenario "Indexes reach the adapted Table" (spec `studio-docs-ddl` scenario 1)
  before touching `schema-adapter.ts`. Confirm it fails because `table.indexes` is `undefined`.
- [x] 2.4 GREEN: in `apps/studio/src/lib/schema-adapter.ts` (`resolvedToTables`, ~line 90-97), add
  `indexes: table.indexes` to the returned object (assign by reference, no per-field copy). Re-run
  2.3's test to confirm it passes.

## Phase 3: Core Implementation — Test-First on the Renderer

Test file: `apps/studio/src/features/docs/lib/ddl-generator.test.ts` (new, vitest, sibling/style
of `relations.test.ts`). Fixture path per design: `.indigo` source → real `parse`+`resolve`
(`@indigodb/core`, not mocked) → `resolvedToTables` → `generateTableDDL`, precedent
`apps/studio/src/features/erd/lib/__tests__/patch-semantics.test.ts:28`. Hand-built `Table` objects
ONLY for the two renderer-only mock-data rows (2, 9). Each RED task below precedes its GREEN task;
run every RED test and confirm the failure before writing the fix.

- [x] 3.1 Create `apps/studio/src/features/docs/lib/ddl-generator.test.ts` scaffold: imports
  (`describe`/`it`/`expect` from vitest, `parse`/`resolve` from `@indigodb/core`,
  `resolvedToTables` from `../../../lib/schema-adapter`, `generateTableDDL` from `./ddl-generator`),
  and a `renderTable(source, tableName)` helper that runs the real pipeline. No test bodies yet.
- [x] 3.2 RED — Scenario row 1 (no `@@index`/`@@unique`, single PK `id`): write the full-string
  `toBe` assertion plus `not.toContain('CREATE INDEX')` / `not.toContain('idx_')`. Run it against
  the current (unfixed) `generateTableDDL` and confirm it fails on the fabricated
  `idx_<table>_lookup` line.
- [x] 3.3 RED — Scenario row 2 (mock `Table` with `indexes` absent, renderer entry): hand-build a
  `Table` with no `indexes` key. Assert same as row 1: no crash, no `CREATE INDEX` clause. Confirm
  it currently fails (fabricated index still present).
- [x] 3.4 RED — Scenario row 9 (mock `Table`, PK absent, no column `isPK`): hand-build a `Table`
  with `primaryKey` absent and no column carrying `isPK: true`. Assert zero `PRIMARY KEY` in the
  output. Confirm it currently fails (nothing invents `id` yet, but confirm the assertion is
  reachable and would fail once table-level PK synthesis lands incorrectly — see 3.10 GREEN order).
- [x] 3.5 RED — Scenario row 3 (one plain index, unnamed, `type` absent): `@@index([authorId])`
  fixture via adapter entry. Assert `CREATE INDEX ON public.T (authorId)` and
  `not.toContain('USING')`. Confirm current failure (no real index rendering exists yet).
- [x] 3.6 RED — Scenario row 4 (`@@unique([email])`): assert `CREATE UNIQUE INDEX`, and that no
  bare `CREATE INDEX` for that same index appears. Confirm current failure.
- [x] 3.7 RED — Scenario row 5 (composite `@@index([authorId, createdAt])`): assert
  `(authorId, createdAt)` column order preserved. Confirm current failure.
- [x] 3.8 RED — Scenario row 6 (explicit `type: gin` + named index): assert `name USING gin (...)`
  with the name emitted verbatim. Confirm current failure.
- [x] 3.9 RED — Scenario row 7 (non-`id` single PK `uuid` + index on an unrelated column): assert
  `PRIMARY KEY (uuid)` and no `(id)` anywhere in the output. Confirm current failure (generator
  hardcodes `(id)` today).
- [x] 3.10 RED — Scenario row 8 (composite PK): assert exactly one
  `PRIMARY KEY (a, b)` clause and no inline per-column `PRIMARY KEY`. Confirm current failure
  (today's inline form emits two `PRIMARY KEY` markers — invalid SQL, the correctness bug named in
  design). **Deviation**: `@@id([a, b])` does not exist in the `.indigo` language — `rules.rs:14`
  explicitly names `@@id` as unsupported/rejected, confirmed by grep (no `@@id` handling anywhere
  in `crates/indigo-compiler/src/{resolve,validate}.rs`). A composite primary key is expressed
  instead by marking two fields `@id` (`resolve.rs:430-431` collects every `is_pk` column into
  `primary_key` — no arity limit), which is what the real compiler actually supports and is
  therefore the correct real-pipeline fixture for this row.
- [x] 3.11 RED — Scenario row 10 (two indexes, one unique one not): assert both rendered in IR
  declaration order. Confirm current failure.
- [x] 3.12 GREEN: rewrite `apps/studio/src/features/docs/lib/ddl-generator.ts`:
  - Delete the `-- Create optimized index` / `idx_${table.name}_lookup` fabrication outright.
  - Add `usingClause(index: ResolvedIndex): string` taking the index OBJECT (not a `type` arg),
    returning `''` or `` `USING ${index.type}` ``; no `??`/`||` default anywhere in the module.
  - Render one `CREATE INDEX` / `CREATE UNIQUE INDEX` per `table.indexes` entry, in array order;
    emit `name` verbatim when present, no name when absent; emit nothing when `table.indexes` is
    absent or `[]`.
  - Replace per-column inline `PRIMARY KEY` (`col.isPK` → `' PRIMARY KEY'`) with one table-level
    `PRIMARY KEY (cols)` line built from `table.primaryKey`; if absent/empty, fall back to columns
    with `isPK: true` in column order; if still none, emit no `PRIMARY KEY` clause at all.
  - Run all of 3.2-3.11 and confirm every one now passes.
- [x] 3.13 Mutation proof #1 (mandatory, named in design): re-append the deleted
  `idx_${table.name}_lookup` fabrication line to `ddl-generator.ts`. Run row 1's test and confirm
  it goes red **naming the unexpected `CREATE INDEX idx_..._lookup` line in an assertion diff** —
  not a `TypeError`. Record the observed red output, then revert the reintroduction. **Observed**:
  row 1 reddened on `expect(ddl).toBe(...)`, diff explicitly showed the added
  `-- Create optimized index` / `CREATE INDEX idx_T_lookup ON T(id);` lines — an assertion diff,
  not a `TypeError`. Reverted; full suite re-confirmed green (12/12).
- [x] 3.14 Mutation proof #2 (mandatory, named in design): change `usingClause` to
  `index.type ?? 'btree'`. Run row 3's test and confirm it goes red on
  `not.toContain('USING')` — record the observed red output — then revert the mutation.
  **Observed**: row 3 reddened; diff showed the rendered statement gained
  `USING btree ` before `(authorId)`, caught first by the `toContain('CREATE INDEX ON public.T
  (authorId);')` assertion (string no longer matches with the injected clause spliced in) — same
  mutation, real assertion diff, not a `TypeError`. Reverted; full suite re-confirmed green (12/12).

## Phase 4: Spec and Verification

- [x] 4.1 Confirm `openspec/changes/studio-index-surfacing/specs/studio-docs-ddl/spec.md` (NEW, 4
  requirements, 11 scenarios) and `specs/studio-ui-honesty/spec.md` (ADDED, 1 requirement, 3
  scenarios) already match the implemented behavior in 3.12 — no spec edits are in scope for this
  phase; this is a read-verify step, not a write. Confirmed: no spec files were edited.
- [x] 4.2 Run the full focused suite: `pnpm --filter @indigodb/studio exec vitest run
  src/features/docs/lib/ddl-generator.test.ts` — confirm all 10 scenario-row assertions pass and
  both mutation proofs were exercised and reverted per 3.13/3.14. **Result**: 12/12 passed (10
  scenario rows + 2 adapter-boundary scenarios from spec Requirement 1).
- [x] 4.3 Run `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`) to confirm the new
  `indexes?: ResolvedIndex[]` field and `usingClause` signature typecheck across `types.ts`,
  `schema-adapter.ts`, and `ddl-generator.ts`. **Result**: exit 0, `pnpm lint` full run also green
  (21/21 tasks).

## Out of Scope (named, not folded in)

- Partial/expression indexes (compiler + migrator) and client-side index-awareness — separate
  roadmap items, not part of this change.
- Four docs-feature honesty defects deferred to their own change: `TableHeroBanner.tsx:34`
  (fabricated "cluster branches" capability), `ColumnsSpecTable.tsx:51` (placeholder text presented
  as real documentation), `RelationsPanel.tsx:57` ("X live rows" over an always-empty array), and
  `useDocBrowser.ts:59` (`alert()` on copy — a live violation of `studio-ui-honesty:184-187`,
  requiring inline transient UI state, not just deleting the call). None of these four files are
  edit targets in this change.
