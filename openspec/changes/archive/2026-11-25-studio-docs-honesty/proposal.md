# Proposal: Remove Fabricated Copy and Actions from the Studio Docs View

## Intent

`studio-ui-honesty` Purpose (line 5) names **docs** as a covered surface, yet only its DDL
requirement binds it. Five fabrications survive in `apps/studio/src/features/docs/`. One of them,
`copyDDL`'s `alert()`, already violates a shipped requirement and went unnoticed because every
scenario of that requirement names the ERD pane.

## Scope

### In Scope

| # | Location | Fix |
|---|---|---|
| 1 | `TableHeroBanner.tsx:34` | Delete the "cluster branches" sentence; keep the factual first sentence |
| 2 | `ColumnsSpecTable.tsx:51` | Muted `—` with accessible "No description" label; real `@note` text unchanged |
| 3 | `RelationsPanel.tsx:57`, `DocBrowserPage.tsx:55` | Remove the "live rows" metric and `recordCount` plumbing |
| 4 | `useDocBrowser.ts:57-60` (`copyDDL`) | Inline transient confirmation on the control; no dialog |
| 5 | `useDocBrowser.ts:62-66` (`shareReference`) | Remove the action, the `onShare` prop, and the button |

### Out of Scope

- `DocsNavSidebar.tsx:19-20` hardcoded schema grouping (separate follow-up).
- Any real row count (`fetchTableRows` wiring).
- URL routing and deep links.
- `queryTable()`'s TODO comment; i18n of docs strings.
- Adjacent epics: no auth, pagination, write-guard, or realtime change. No named seam is touched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `studio-ui-honesty`:
  - **MODIFIED** "Copy-to-clipboard actions give inline, non-blocking feedback" — exact title
    kept, full prior block copied, docs scenarios added (Copy Schema shows inline confirmation
    with no `alert()`; a rejected write shows no dialog).
  - **ADDED** "UI copy never claims a capability or data the product does not have" — every
    scenario names the docs view (items 1, 2, 3, 5).
- `studio-docs-ddl`: unchanged.

## Approach

Remove or neutralize only; no new data plumbing. Item 4 reuses the `DslEditorToolbar.tsx:32-50`
shape: awaited `writeText` in try/catch, ref-tracked timeout cleared on unmount. Strict TDD: RED
against each scenario first.

Item 3 is ADDED rather than folded into "Displayed record count reflects real loaded data":
"0 live rows" is never *larger* than the loaded count, so that requirement cannot catch it.

**Design decisions (sdd-design):** shared hook (a second real caller now exists, but extraction
touches ERD) vs. local duplication; copy state in `useDocBrowser` vs. `DdlPanel`; whether the
now-empty "Metadata Summary" box is removed with its only metric.

## Affected Areas

| Area | Impact |
|---|---|
| `apps/studio/src/features/docs/components/{TableHeroBanner,ColumnsSpecTable,RelationsPanel,DdlPanel}.tsx` | Modified |
| `apps/studio/src/features/docs/{DocBrowserPage.tsx,hooks/useDocBrowser.ts}` | Modified |
| `apps/studio/src/features/docs/__tests__/` | New |
| `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` | Modified only if the hook is extracted |
| `openspec/specs/studio-ui-honesty/spec.md` | Delta |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| MODIFIED title drifts; predecessor survives at archive | Med | Title verbatim; archive re-counts (+1 expected) |
| Toothless negative tests (removed copy, `alert`, share button) | Med | Prove each bites by reintroducing the removed code |
| Hook extraction regresses ERD copy | Low | `DslEditorToolbar.test.tsx` stays green unmodified |
| Scenarios read as ERD-only again | Med | Every new scenario names the docs view |

## Rollback Plan

Revert the change's commit range. Removals are self-contained (no other reader of
`shareReference` or `recordCount`). The delta merges only at archive, so a pre-archive rollback
touches only the change folder.

## Dependencies

None.

## Success Criteria

- [ ] Docs view renders no "cluster branches" text, no "live rows" text, no "Share Reference" button.
- [ ] An undocumented column renders `—` named "No description"; an `@note` column renders its text.
- [ ] Copy Schema writes the DDL, shows a transient inline "Copied" that clears, never calls `alert()`; a rejected write shows no dialog.
- [ ] Each negative test fails when its removed code is reintroduced.
- [ ] Post-archive `studio-ui-honesty` has one copy-to-clipboard requirement; count = prior + 1.
- [ ] `pnpm build && pnpm lint && pnpm test` green.
