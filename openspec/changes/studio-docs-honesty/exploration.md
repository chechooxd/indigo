## Exploration: studio-docs-honesty (Studio docs surface fabrication sweep)

> Materialized by the orchestrator from Engram `sdd/studio-docs-honesty/explore` (#1375); the
> explore agent had no file-write tool. An orchestrator addendum with verified follow-ups and the
> pending product decisions is at the end.

### Current State

Four confirmed survivors of Phase 0 "Delete the simulations" live in `apps/studio/src/features/docs/`, all traced to real code at `main`@2dcc039:

**1. `components/TableHeroBanner.tsx:34`** — renders: *"Provides unified metadata specifications for the {table.name} entity. Automatically managed within the transactional limits of active cluster branches."* `rg -i "cluster branch"` across the whole repo (including `i18n/locales/en.json`, `es.json`) matches ONLY this JSX literal — no i18n key, no such feature exists anywhere. The string is hardcoded, not run through `t()`. Root cause: pure renderer invention; there is no IR field this could be sourced from.

**2. `components/ColumnsSpecTable.tsx:51`** — `{col.description || 'Database engine system column value.'}`. The `.indigo` language DOES carry real per-column documentation via `@note("...")` (`ResolvedColumn.note`, `packages/core/src/ir.ts:46`), and `schema-adapter.ts:82` (`resolvedToTables`) correctly maps `col.note` → `TableColumn.description` — **no data loss at the adapter boundary**. The fallback fires whenever a column has no `@note` (the common case) and presents "no documentation exists" as if it were real generic documentation, indistinguishable from an actual `@note`. `data/mockData.ts` sets `description` on every mock column, so mock mode never hits this fallback. Root cause: pure renderer fabrication.

**3. `components/RelationsPanel.tsx:57`** — `{recordCount} live rows`, fed by `DocBrowserPage.tsx:55`: `activeTable.records ? activeTable.records.length : 0`. `schema-adapter.ts:98` hardcodes `records: []` for every table unconditionally, in every mode, so this always renders "0 live rows" while "live" implies a real, current count. A real exact-count source exists elsewhere: `apps/studio/src/lib/api.ts`'s `fetchTableRows` returns `TablePage.total` (exact `COUNT(*)`, `packages/cli/src/studio-server.ts:1368`), consumed by `TableBrowserPage.tsx:559-560`. There is no count-only endpoint — a real count in docs means an extra `fetchTableRows` round trip per table view, gated on `isBackendAvailable()`, with a "not connected" fallback.

**4. `hooks/useDocBrowser.ts:59` (`copyDDL`) and `:65` (`shareReference`)** — both call `navigator.clipboard.writeText(...)` (not awaited, not failure-handled) followed by a blocking `alert(...)`. This LIVE-VIOLATES `openspec/specs/studio-ui-honesty/spec.md:184-187`. A compliant sibling exists: `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` (`handleCopyCode`) — awaited `writeText` in try/catch, `copied` state, a ref-tracked `setTimeout(..., COPY_FEEDBACK_MS)` cleared on unmount, title/aria-label toggling. Reuse or extract this shape rather than reinventing it.

### Spec mapping (`openspec/specs/studio-ui-honesty/spec.md`)

- Purpose (line 5) names "docs" as a covered surface. The later "Docs-view DDL never fabricates schema data" requirement (lines 222-244) binds only `generateTableDDL` (fixed by `studio-index-surfacing`; see `openspec/specs/studio-docs-ddl/spec.md`).
- #4 is covered by the GENERAL "Copy-to-clipboard actions give inline, non-blocking feedback" requirement (lines 184-187), but every scenario (189-201) names the ERD pane — the "general text, single-surface scenarios" trap (#1346). `copyDDL`/`shareReference` are in violation today.
- #1–#3 have NO binding requirement. New requirements/scenarios must explicitly name the docs surface.

### Sweep of the rest of `features/docs/`

Every file read (`DocBrowserPage.tsx`, `DocsNavSidebar.tsx`, `DdlPanel.tsx`, `lib/relations.ts`, `lib/ddl-generator.ts` + tests). No further fabricated values. Candidates NOT in scope:
- `useDocBrowser.ts:69-70` — `queryTable()` performs real navigation; honestly incomplete, not fabricated.
- `DocsNavSidebar.tsx:19-20` — hardcodes `'public' | 'billing'` vs `'analytics'` grouping; `schema-adapter.ts:93` always sets `schema: 'public'`, so the grouping is dead for real schemas and only active for `mockData.ts`.

### Test harness

`apps/studio` uses `vitest run`, with two existing patterns:
1. Pure-logic / IR-pipeline, `// @vitest-environment node`, real `parse`/`resolve` through `resolvedToTables`: `features/docs/lib/ddl-generator.test.ts`.
2. Component/hook with `@testing-library/react`, `vi.useFakeTimers()`, `vi.spyOn(window, 'alert')`, mocked `navigator.clipboard`: `features/erd/__tests__/DslEditorToolbar.test.tsx`.

No test exists for `TableHeroBanner`, `ColumnsSpecTable`, `RelationsPanel`, or `useDocBrowser`. No new packages needed.

### Approaches

1. **Minimal honesty (remove/neutralize, no new data plumbing)** — delete the fabricated banner sentence; render an honest absence marker for undocumented columns; remove "live rows" (or replace with something docs actually knows); extract the ERD copy-feedback shape into a shared hook for both copy actions. Low risk, ~60-100 source lines.
2. **Wire real data where it exists** — for #3 only, `fetchTableRows(...).total` behind `isBackendAvailable()` with a "not connected" fallback. Medium: +40-60 lines, a new loading/absent state, first coupling of docs to the data-browser API.

### Recommendation

Approach 1 for #1, #2, #4. #3 is a product decision (remove vs. wire).

### Estimated size

~300-400 changed lines including four new test files (~150-250) and spec updates. Candidate split: pure copy fixes (#1/#2) vs. behavioural fixes (#3/#4).

### Risks

- #3's direction depends on the human's decision.
- The two copy call sites share one hook; preserve the ERD's unmount-safe timeout cleanup.
- New requirements must be scenario-complete for the docs surface (#1346).

---

## Orchestrator addendum (2026-09-11, verified against the tree)

- Spot-checked and confirmed: `ColumnsSpecTable.tsx:51` fallback literal; `schema-adapter.ts:82` (`description: col.note`) and `:98` (`records: []`); `DslEditorToolbar.tsx:33-48` (ref-tracked timeout, awaited `writeText`, silent failure, no dialog).
- **Open question 4 resolved — the share link is dead.** Studio has no router: no `react-router`, no `HashRouter`/`BrowserRouter`, and no read of `location.hash`, `hashchange`, or `pushState` anywhere in `apps/studio/src`. Navigation is store-driven (`navigate('studio', 'query')`). So the URL `shareReference` copies (`window.location.href + '#docs/{schema}/{table}'`) restores nothing on load — it is a fabricated capability, the same class as the banner. It also appends a second `#` whenever the current URL already carries a hash. This moves #4b from "secondary" to in scope: either implement read-back or remove the action.

### Resolved by orchestrator default (copy choices with a conventional answer)

- **Empty column description (#2):** muted em dash `—`, matching the adjacent `defaultValue` `'-'` fallback treatment, with an accessible label so assistive tech reads "No description" rather than a bare dash.
- **Banner (#1):** delete only the fabricated second sentence; keep the factual first sentence.

### Human product decisions — CONFIRMED 2026-09-11

1. Row count in `RelationsPanel` (#3): **remove the metric.** No `fetchTableRows` wiring.
2. Share-reference action (#4b): **remove the action** (the button and `shareReference`). Real deep
   links wait for Studio to have URL routing — a separate change.
3. `DocsNavSidebar` hardcoded schema grouping: **separate follow-up**, out of scope here.
4. `sdd-research`: **skipped** — every decision is repo-internal and verified against the tree.
