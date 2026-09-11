# Proposal: Surface Real Indexes in the Studio Docs View

## Intent

`ddl-generator.ts:22` appends a fabricated `CREATE INDEX idx_<table>_lookup ON <table>(id)` —
labelled `-- Create optimized index` — to every table's DDL. That is the symptom.
The cause is upstream: `schema-adapter.ts:70-99` maps `ResolvedTable → Table` and never reads
`table.indexes`, and `types.ts:26-40`'s `Table` has no `indexes` field at all (verified absence:
`rg ResolvedIndex apps/studio/src/` → 0 matches). Real `@@index`/`@@unique` data exists in the IR
(`ir.ts:90-104, 198`) and is discarded at the adapter boundary — almost certainly why an index was
hardcoded. A generator-only patch trades a lie for a permanent blind spot.
The generator also hardcodes `(id)` while `table.primaryKey` is populated (`schema-adapter.ts:94`)
and never read.

Second defect: `openspec/specs/studio-ui-honesty/spec.md:5` names **docs** as a covered surface,
yet none of its ten requirements or scenarios mention docs, DDL, or indexes. The Purpose claims
coverage the body never specifies.

## Scope

### In Scope
- Add `indexes` to `Table` (`apps/studio/src/types.ts`), carrying `ResolvedIndex` shape.
- Populate it in `resolvedToTables` (`apps/studio/src/lib/schema-adapter.ts`).
- Rewrite `generateTableDDL` to render real `CREATE INDEX` / `CREATE UNIQUE INDEX` off that array,
  emit nothing when empty, and use `table.primaryKey` instead of a literal `id`.
- Delta on `studio-ui-honesty` adding real docs-surface requirements.
- First test for `generateTableDDL`, including the negative case.

### Out of Scope
- Partial/expression indexes (compiler + migrator, separate roadmap item).
- Client-side index-awareness.
- The three deferred docs fabrications below.

## Capabilities

### New Capabilities
- `studio-docs-ddl`: docs-view DDL rendering fidelity — every rendered DDL statement corresponds to
  resolved schema data; index and primary-key clauses are never fabricated or defaulted.

### Modified Capabilities
- `studio-ui-honesty`: gains docs-surface requirements so the Purpose line's claim is enforced.
  Any requirement the delta *modifies* must reuse its existing title verbatim.

## Approach

Exploration Approach 1 (adapter-first), settled. Fix the data path before the renderer: the IR is
already correct, so the only work is stopping the loss at the adapter and rendering what arrives.

**Rejected**: (2) generator-only patch — suppresses the fabrication but leaves docs permanently
unable to show real indexes; showing nothing when indexes exist is less wrong, not honest.
(3) bundling the other docs fabrications — different sub-scope, inflates review, each deserves its
own honesty scenarios.

**btree constraint**: `ir.ts:97-102` canonicalizes an explicit `type: btree` to *absent*. The
renderer MUST NOT emit `USING btree` when `type` is absent, or it contradicts that canonicalization.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `apps/studio/src/types.ts:26-40` | Modified | Add `indexes` to `Table` |
| `apps/studio/src/lib/schema-adapter.ts:70-99` | Modified | Root fix — map `table.indexes` |
| `apps/studio/src/features/docs/lib/ddl-generator.ts:9-24` | Modified | Render real indexes; use `primaryKey` |
| `apps/studio/src/features/docs/lib/*.test.ts` | New | First `generateTableDDL` test |
| `openspec/specs/studio-ui-honesty/spec.md` | Modified | Docs-surface delta |
| `packages/core/src/ir.ts` | Unchanged | Source of truth, confirms contract |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Title-match archive hazard.** Spec merge matches requirements by title; `migration-history-forensics` expressed a MODIFIED requirement under a new title and the merge read it as an addition, so the predecessor survived beside it. | Med | Archive MUST re-count the canonical requirement list before and after. ADDs are expected and fine; any MODIFIED requirement reuses its title verbatim. |
| Re-adding `USING btree` for absent `type` | Med | Explicit scenario + test asserting no `USING` clause when `type` is absent |
| Negative test written but toothless | Med | Per repo convention, prove it bites: reintroduce the fabrication and confirm the test fails |
| Composite PK / PK-less table renders wrongly | Med | Cover composite `primaryKey` and empty-`indexes` cases |
| Delta scope-creeps into the deferred fabrications | Low | Docs requirements stay scoped to DDL/index fidelity |

## Rollback Plan

Revert the change commit. The four touched files are additive and independent: reverting
`types.ts` + `schema-adapter.ts` restores the prior `Table` shape with no other consumer affected
(no existing reader of `indexes` exists today), and reverting `ddl-generator.ts` restores the prior
string. The spec delta is not yet merged into `openspec/specs/` until archive, so a pre-archive
rollback touches only the change folder.

## Dependencies

None. All required data already exists in `ResolvedSchema`.

## Deferred Follow-Ups (named, not dropped)

Same defect class, separate change:
- `TableHeroBanner.tsx:34` — "Automatically managed within the transactional limits of active
  cluster branches." `rg "cluster branch"` matches only this file and its i18n; **no such feature
  exists in the codebase**. A fabricated capability claim in user-facing copy — the most serious
  of the three.
- `ColumnsSpecTable.tsx:51` — fallback `'Database engine system column value.'` presented as real
  documentation.
- `RelationsPanel.tsx:57` — "X live rows" while `records` is always `[]` (`schema-adapter.ts:96`).

## Success Criteria

- [ ] A table declaring no `@@index`/`@@unique` renders DDL containing **zero** occurrences of
      `CREATE INDEX` and zero occurrences of `idx_`.
- [ ] A table with `@@index([authorId, createdAt])` renders
      `CREATE INDEX ... ON <table>(authorId, createdAt)` — column order preserved, not `(id)`.
- [ ] A table with `@@unique([email])` renders `CREATE UNIQUE INDEX`, not `CREATE INDEX`.
- [ ] An index whose `type` is absent renders **no** `USING` clause; `type: gin` renders `USING gin`.
- [ ] A table whose primary key is `uuid` (not `id`) renders no reference to a column named `id`
      that the schema does not declare.
- [ ] `studio-ui-honesty` contains at least one docs-surface requirement with scenarios, and the
      canonical requirement count after archive equals the pre-archive count plus the number of
      ADDED requirements — no duplicated titles.
