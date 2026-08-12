# Proposal: Delete the Studio Simulations

## Intent

`indigodb studio` ships UI that lies. Ten confirmed defects in `apps/studio` claim work that
never happens: `alert('Simulating...')` stubs behind Refresh/Filter/Sort/pager, fake success
toasts after pure-Zustand "saves", fabricated `Simulated Value` rows, a fabricated `1,200,000`
row count for a 4-row mock table, and — worst — no visible indicator when the Studio is
running on mock data instead of the user's real database. A schema-first toolkit whose
flagship UI fabricates data undermines trust in every honest part of the product. This closes
the last Phase 0 epic.

## Scope

### In Scope
- Remove every `alert()`-based simulation stub in `TableBrowserPage.tsx` (Refresh, Filter,
  Sort, both pager buttons) and the "(simulated client memory cache)" footer copy.
- Refresh becomes a real refetch (`fetchTableRows`) when the backend is available; disabled
  with an explanatory tooltip when it is not. Filter/Sort/pager are removed or disabled — no
  control may claim capability it lacks.
- Report the true seeded record count; delete `MOCK_USERS_DISPLAY_RECORD_COUNT` (1,200,000).
- Disable Add Record, Save Changes, Discard, and Create Table with a tooltip: "Row editing
  isn't available yet — this build is read-only." (resolved decision, not reopened).
- Remove fabricated `'Simulated Workspace Row'` / `'Simulated Value'` row generation.
- Add a persistent, visible sample-data indicator when `!isBackendAvailable()`.
- Establish a minimal Vitest + `@testing-library/react` harness in `apps/studio`, scoped only
  to the behaviors above.

### Out of Scope
- Backend write endpoints in `packages/cli/src/studio-server.ts` (Phase 5; read-only by design).
- The ERD editor module and any Studio area outside the data browser.
- General-purpose component testing for the whole app; server-side pagination/filtering/sorting.

## Capabilities

### New Capabilities
- `studio-ui-honesty`: no Studio control may claim an effect it does not perform; mock/fallback
  data MUST be visibly labeled; unavailable actions MUST be disabled with a stated reason.
- `studio-ui-tests`: minimal React test harness for `apps/studio` covering the honesty rules.

### Modified Capabilities
- None. Existing studio specs (`studio-server-security`, `studio-readonly-queries`,
  `studio-server-tests`) are server-side and unaffected.

## Approach

1. Add Vitest + jsdom + `@testing-library/react` to `apps/studio`, wire `test` into Turbo.
   RED first (strict TDD): assert no `alert` on control click, disabled+tooltip on write
   actions, sample-data banner under mock fallback, true record count.
2. Strip the simulation stubs; wire Refresh to the existing fetch path.
3. Add the sample-data banner, sourced from `isBackendAvailable()`; new copy goes through
   `react-i18next` (`src/i18n/locales/` en + es), matching existing Studio convention.
4. Delete the fabricated count constant and simulated row generators.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/studio/src/features/studio/browser/TableBrowserPage.tsx` | Modified | Remove 5 alert stubs, footer copy; real Refresh; disable Add Record |
| `apps/studio/src/features/studio/browser/hooks/useRecordEditor.ts` | Modified | Remove fake-success alert and simulated row generation |
| `apps/studio/src/features/studio/browser/hooks/useCreateTableForm.ts` | Modified | Disable submit; no fabricated table push |
| `apps/studio/src/store/useDataStore.ts` | Modified | Delete `MOCK_USERS_DISPLAY_RECORD_COUNT` |
| `apps/studio/src/features/studio/browser/components/TableList.tsx` | Modified | Render true count |
| `apps/studio` (banner component, i18n locales, `package.json`, vitest config) | New | Sample-data indicator + test harness |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| New test toolchain inflates the diff past the 800-line budget | Med | Deliver harness setup as its own PR slice (auto-chain, stacked-to-main) |
| Vitest/jsdom conflicts with Vite 6 + React 19 + Tailwind v4 setup | Low | Harness slice lands and goes green before behavior slices |
| Disabling write actions reads as regression | Low | Tooltip states the reason; capability was never real |
| Untranslated new copy | Low | Add en + es keys in the same change |

## Rollback Plan

Pure `apps/studio` change with no schema, IR, WASM, migration, or backend surface. Revert the
change branch(es); no data migration, no artifact regeneration, no `build:wasm` (nothing under
`crates/`). Removing the Vitest devDependencies restores the prior install graph exactly.

## Dependencies

- None blocking. Real Refresh benefits from `indigodb studio` running, but the mock path is the
  primary tested surface.

## Success Criteria

- [ ] Zero `alert(` occurrences remain in `apps/studio/src`.
- [ ] No string containing "Simulat"/"simulated" remains in Studio user-facing copy or data.
- [ ] `useDataStore.ts` contains no fabricated record count; the browser shows the true count.
- [ ] Write actions are disabled and expose a reason; clicking them mutates nothing.
- [ ] A sample-data indicator is visible whenever `isBackendAvailable()` is false.
- [ ] `pnpm test` runs the new `apps/studio` suite and is green; `pnpm lint` and `pnpm build` pass.

## Proposal question round (auto mode — assumptions for user review)

Execution mode is `auto`, so these were resolved as assumptions rather than asked:
1. Filter/Sort/pager are **removed**, not kept-and-disabled — they encode no real capability
   and no roadmap commitment. (Alternative: disable with "coming soon".)
2. The sample-data indicator is a persistent banner, not a dismissible toast — dismissal would
   reintroduce a silent-fake state.
3. "True record count" means rows currently loaded client-side, since the read-only backend
   exposes no `COUNT(*)` endpoint.
4. i18n coverage is en + es only, matching existing locales.
