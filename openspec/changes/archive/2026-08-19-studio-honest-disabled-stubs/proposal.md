# Proposal: Honest Disabled States for Studio's Remaining Simulated Controls

## Intent

Three Studio controls still `alert()` a fabricated success for an action that never
happens — a browser cannot open a CLI socket, no schema-metadata refetch is wired, and
no revision-history feature exists. This survived `2026-08-11-delete-studio-simulations`,
which scoped `studio-ui-honesty` to the data browser only. These lie regardless of
backend state, so the existing fail-soft/mock convention does not excuse them. A fourth
site ships untranslated Spanish UI copy, against the English-default convention.

## Scope

### In Scope
- `useDashboardActions.ts:40` `openCli` — remove alert; render the trigger disabled with an honest tooltip (a browser cannot open a CLI connection).
- `SchemaBrowserPanel.tsx:26` refresh — remove alert; disable with honest tooltip, mirroring `TableBrowserPage`'s `REFRESH_DISABLED_TITLE` pattern.
- `ERDDesignerPage.tsx:123` History — remove alert; disable with honest tooltip (no backup history exists).
- `ERDDesignerPage.tsx:40` `handleCopyCode` — replace `alert('Código copiado…')` with an inline transient "Copied" confirmation on the button (no toast component exists in `components/ui/`; adding one is out of scope). Clipboard write is real and unchanged.
- Extend `studio-ui-honesty` beyond the data browser; add regression tests under `studio-ui-tests`.

### Out of Scope
- Building real CLI-connect, schema-refresh, or revision-history features (fixed user constraint).
- `useDataStore.ts` `tables` mock fallback — correct fail-soft behavior.
- Dashboard `schemas`/`alerts` mock data — a **missing backend feature** (`studio-server.ts` exposes no recent-schemas/alerts endpoint), tracked as a separate future gap.
- `useDocBrowser.ts:59,65` — real actions, `alert()`-as-toast UX only.
- Introducing a toast/notification system.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `studio-ui-honesty`: purpose currently scoped to `features/studio/browser/`; widen to all Studio surfaces, and add a requirement that a control with no real implementation is disabled with a stated reason rather than alerting fake success.
- `studio-ui-tests`: harness is explicitly scoped to data-browser components and forbids broader rollout; amend to cover dashboard, query, and ERD honesty tests.

## Approach

Apply the established `TableBrowserPage` pattern verbatim: a module-level explanatory
title constant, `disabled` on the control, `title={...}` tooltip, handler deleted. For
`openCli` the disable is unconditional (never possible from a browser); for the schema
refresh and ERD history it is unconditional in this change because no implementation
exists to gate on. Tests assert `window.alert` is never called and the controls are
disabled with the expected tooltip.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/studio/src/features/dashboard/hooks/useDashboardActions.ts` | Modified | Drop `openCli` alert; expose disabled affordance |
| `apps/studio/src/features/dashboard/` (consumer of `openCli`) | Modified | Render disabled + tooltip |
| `apps/studio/src/features/studio/query/components/SchemaBrowserPanel.tsx` | Modified | Disable refresh with tooltip |
| `apps/studio/src/features/erd/ERDDesignerPage.tsx` | Modified | Disable History; English inline copy feedback |
| `openspec/specs/studio-ui-honesty/spec.md` | Modified | Widen scope beyond data browser |
| `openspec/specs/studio-ui-tests/spec.md` | Modified | Lift data-browser-only harness restriction |
| `apps/studio/test/` | New | Regression tests for the three controls |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Disabled controls read as "broken app" | Med | Tooltip states the reason, not just "unavailable" |
| Test harness expansion becomes a broad rollout | Med | Amend `studio-ui-tests` to name exactly the three new surfaces |
| `viewAllSchemas:66` is the same class of no-op but excluded | High | Open question below; do not fix silently |
| Removing a visible action without a placeholder confuses the dashboard layout | Low | Keep control visible-but-disabled, never delete it |

## Rollback Plan

Pure UI change, no data/schema/type-contract surface. Revert the commit(s); the deleted
`alert()` handlers restore verbatim. Spec deltas revert with the same commit. No
migration, no generated artifact, no WASM rebuild.

## Dependencies

- `apps/studio` has no test runner today; `studio-ui-tests` requires Vitest + `@testing-library/react` + jsdom to already be installed or installed by this change.

## Open Questions

1. `useDashboardActions.ts:66` `viewAllSchemas` is also a pure no-op alert (exploration item 3) but was not in the approved three. Include it, or defer?
2. Is inline "Copied" feedback acceptable for `handleCopyCode`, or should the confirmation be removed entirely?

## Success Criteria

- [ ] No `alert()` remains in `useDashboardActions.ts`, `SchemaBrowserPanel.tsx`, or `ERDDesignerPage.tsx`.
- [ ] Each of the three controls renders disabled with a tooltip stating why.
- [ ] No Spanish string remains in shipped Studio UI copy.
- [ ] Tests fail against pre-change code and pass after.
- [ ] `pnpm lint` and `pnpm test` pass from the repo root.
