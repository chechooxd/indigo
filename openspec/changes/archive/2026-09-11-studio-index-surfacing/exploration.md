# Exploration: studio-index-surfacing

**Change**: `studio-index-surfacing`
**Phase**: explore
**Date**: 2026-09-11
**Engram topic**: `sdd/studio-index-surfacing/explore`

> Written by the orchestrator from the Engram artifact: the `sdd-explore` agent's toolset carried
> no Write tool. Content is the agent's; this file is the hybrid-store filesystem copy.

## Current State

The IR already carries index data. `packages/core/src/ir.ts:90-104` defines
`ResolvedIndex { columns: string[]; unique: boolean; name?: string; type?: "btree"|"gin"|"gist"|"hash" }`,
and `ResolvedTable.indexes: ResolvedIndex[]` at `ir.ts:198`.

**The defect is one layer upstream of the DDL generator.** `apps/studio/src/lib/schema-adapter.ts:70-99`
(`resolvedToTables`) maps `ResolvedTable → Table` field by field — name, schema, realtime,
primaryKey, columns, records — and **never reads `table.indexes`**. It is silently dropped at the
adapter boundary. Confirmed absences: `rg ResolvedIndex apps/studio/src/` returns zero matches, and
`apps/studio/src/types.ts:26-40`'s `Table` interface has **no `indexes` field at all**.

So even a corrected `generateTableDDL` could not render real indexes today — the shape that reaches
it structurally cannot carry them. `apps/studio/src/features/docs/lib/ddl-generator.ts:22` is the
visible symptom, not the root cause.

The generator also hardcodes `(id)` regardless of `table.primaryKey` — a field that **does** exist
and **is** populated by the adapter (`schema-adapter.ts:94`), and which the generator never reads.

All three consequences named in the brief are confirmed: real indexes invisible, a fake one shown on
every table, and a wrong-column reference on any table whose PK is not literally `id`.

## The honesty spec makes a claim its own body never backs

`openspec/specs/studio-ui-honesty/spec.md:5` — the Purpose explicitly lists the covered surfaces:

> "dashboard, query engine, ERD designer, data browser, **docs**"

But scanning every Requirement and Scenario in the file, **none mention docs, DDL, or indexes**.
All ten target the data browser (refresh/filter/sort/pagination/write-guards) plus a few
dashboard, query-engine and ERD scenarios.

This is the same scoping gap the 2026-08-18 audit recorded for `useDataStore` — with the sharper
twist that the Purpose line here actively promises the coverage. Skipping a delta leaves the spec
making a false claim independent of this bug fix.

**No canonical spec covers docs-view DDL rendering.** This is unspecified territory.

## Tests

No test exists for `generateTableDDL` — `apps/studio/src/features/docs/**/*.test.*` returns only
`docs/lib/relations.test.ts`. Nothing ratifies the fabrication; nothing needs flipping, only writing.

## Other fabrications in the same feature — the Phase-0 pattern travels in packs

Found, confirmed, and recommended as a **separate follow-up change**, not folded in here:

- `apps/studio/src/features/docs/components/TableHeroBanner.tsx:34` — *"Automatically managed within
  the transactional limits of active cluster branches."* `rg "cluster branch"` across the whole repo
  matches only this file and its i18n translation. **No such feature exists anywhere in the
  codebase.** This is a fabricated capability claim in user-facing copy, not cosmetic filler — a
  different and more serious thing than a placeholder.
- `apps/studio/src/features/docs/components/ColumnsSpecTable.tsx:51` — fallback text
  `'Database engine system column value.'` rendered whenever `col.description` is empty, presented
  as though it were real documentation.
- `apps/studio/src/features/docs/components/RelationsPanel.tsx:57` — labels a record count as
  *"X live rows"*, but `schema-adapter.ts:96` always sets `records: []` for docs-sourced tables, so
  it always renders "0 live rows" while implying liveness.

## Affected Areas

| Area | Role |
|---|---|
| `packages/core/src/ir.ts:90-104, 186-198` | Source of truth. No change needed; confirms the contract. |
| `apps/studio/src/types.ts:26-40` | `Table` needs an `indexes` field to carry the data. |
| `apps/studio/src/lib/schema-adapter.ts:70-99` | **The real fix location** — must map `table.indexes`. |
| `apps/studio/src/features/docs/lib/ddl-generator.ts:9-24` | Render real indexes (or none), and use `table.primaryKey` rather than a hardcoded `id`. |
| `openspec/specs/studio-ui-honesty/spec.md` | Needs a delta adding real docs-surface requirements, or its Purpose stays false. |
| (new) a `ddl-generator` test | None exists. |

## Approaches

1. **Adapter-first fix — RECOMMENDED.** Add an indexes field to `Table`, populate it in
   `resolvedToTables`, rewrite `generateTableDDL` to render real `CREATE INDEX` /
   `CREATE UNIQUE INDEX` off that array (or emit nothing when empty), respecting `table.primaryKey`.
   Add a `studio-ui-honesty` delta covering docs DDL fidelity. Write the missing test.
   *Pros:* fixes the actual root cause, not the symptom; closes the spec's false claim.
   *Cons:* touches three files plus a spec delta. *Effort:* Medium.
2. **Generator-only patch.** Stop fabricating; render nothing.
   *Cons:* does **not** fix the defect — real indexes still never reach the Studio, so the docs view
   stays permanently blind to `@@index`/`@@unique`. Suppresses the fabrication without restoring
   truth. Showing nothing when real indexes exist is also not honest, merely less actively wrong.
   *Effort:* Low.
3. **Bundle the other three fabrications in.**
   *Cons:* unrelated defect class by name and intent; inflates review scope; each needs its own
   honesty-spec scenarios and deserves review on its own merits. *Effort:* Low incremental, but
   scope-creeps the change.

**Recommendation: Approach 1.**

## Risks

- **btree canonicalization.** The IR canonicalizes an explicit `type: btree` to *absent*
  (`ir.ts:97-102`). The renderer must not re-add `USING btree` when `type` is absent, or it
  contradicts the IR's own stated canonicalization intent.
- `studio-ui-honesty`'s Purpose promises docs coverage that does not exist; skipping the delta
  leaves that false independent of this fix.
- No regression test guards `generateTableDDL`. The new test must assert the **negative** case —
  a no-index table renders no `CREATE INDEX` — not only the positive ones, per this repo's
  "prove negative tests actually bite" convention.

## Scope Boundary

**In:** the adapter, the `Table` shape, the DDL generator, the honesty-spec delta, and a test.

**Explicitly out:** partial/expression indexes (compiler + migrator, a separate Phase 7 item);
client-side index-awareness (also Phase 7); and the three other docs-feature fabrications above,
which are a separate change.

## Ready for Proposal

Yes.
