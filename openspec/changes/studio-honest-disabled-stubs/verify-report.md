# Verification Report: studio-honest-disabled-stubs

**Mode**: full artifacts (proposal, spec, design, tasks, apply-progress) — all retrieved and read.
**Commit under test**: 4ee50af (already on main).

## Task completeness
17/17 checkboxes in `tasks.md` are `[x]`. Confirmed via grep of the actual file. 0 unchecked.

## Fresh command evidence (re-run, not reused)
- `pnpm --filter @indigodb/studio test` → 8 test files / 31 tests, ALL PASS (exit 0). Includes the 3 new suites plus pre-existing `TableBrowserPage.test.tsx` (13 tests) and `SampleDataBanner.test.tsx` (2 tests) unaffected.
- `pnpm build` (root) → 10/10 Turbo tasks pass, studio `tsc -b && vite build` succeeds, no type errors.
- `pnpm lint` (root) → 18/18 Turbo tasks pass (`tsc --noEmit` across every package).

## Source-level compliance matrix

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `useDashboardActions.ts` openCli/viewAllSchemas deleted, no `alert()` | PASS | Functions/interface members fully absent. `WelcomeHero.tsx` `#btn-open-cli` has `disabled` + `title={CLI_DISABLED_TITLE}`, no onClick. `RecentSchemasTable.tsx` view-all button has `disabled` + `title={VIEW_ALL_DISABLED_TITLE}`, no onClick. Zero `alert(` in either file or `DashboardPage.tsx`. |
| 2 | `SchemaBrowserPanel` refresh gated on real backend via `schema-loader.ts` | PASS (functional) — WARNING (process) | `lib/schema-loader.ts` exports `loadSchemaIntoStore(store)`; `useSchemaBootstrap.ts` delegates to it; `QueryEnginePage.tsx` wires `canRefresh={isBackendAvailable()}` + `onRefresh`; `SchemaBrowserPanel.tsx` disables + tooltips only when `!canRefresh`, no `alert()`. **But**: the spec artifact's "Resolved scope" note (point 3) says this was "fixed by user, not open questions" as an *unconditional* disable — design (decision 3) reversed it to gated without raising it as an open question (unlike the Spanish-string deviation, which correctly was flagged). The persisted scenario text is gating-agnostic so no spec-text violation exists, and the gated behavior is arguably more honest. WARNING, not CRITICAL. |
| 3 | ERD `handleCopyCode` → inline "Copied" via `DslEditorToolbar`; History honestly disabled; no `alert()` | PASS | `DslEditorToolbar.tsx` awaits clipboard write, sets `copied` with 1500ms revert on success, shows nothing on rejection. History button `disabled` + `title={HISTORY_DISABLED_TITLE}`. `ERDDesignerPage.tsx` renders the toolbar; old handler/buttons removed. Zero `alert(` in either file. |
| 4 | 3 Spanish layout-toggle titles translated; no remaining Spanish in touched files | PASS | `title="Editor only"` / `"Split view"` / `"Canvas only"` present. Grep for Spanish diacritics across all 10 touched files: zero matches. |
| 5 | 3 new test files exist, assert `window.alert` never called, exercise disabled + enabled/real paths | PASS | `DashboardPage.test.tsx` (1 test), `SchemaBrowserPanel.test.tsx` (2 tests: disabled/no-op AND enabled/real-onRefresh), `DslEditorToolbar.test.tsx` (2 tests: History disabled, Copy shows/reverts "Copied"). All spy `window.alert`. |
| 6 | Fresh `pnpm test`/`build`/`lint` from repo root | PASS | All green, matches apply-progress's claimed numbers, independently reproduced. |
| 7 | `openspec/specs/studio-ui-honesty` and `studio-ui-tests` deltas widen scope, still unmerged (archive not run) | PASS | Live `openspec/specs/studio-ui-honesty/spec.md` Purpose is still the OLD narrow (data-browser-only) scope, confirming archive has not run. Widened delta correctly sits only in `openspec/changes/studio-honest-disabled-stubs/specs/` and reads coherently. |

## Requirement/scenario counts (authoritative, from spec artifact)
- `studio-ui-honesty`: 3 ADDED requirements, 6 scenarios — all covered.
- `studio-ui-tests`: 2 MODIFIED requirements, 10 scenarios — harness-exists scenario covered by the successful `pnpm test` run; 3 of the 9 fail-before/pass-after scenarios covered by the 3 new suites, the other 6 inherited and reconfirmed green via the pre-existing suites.

## Design coherence
Decisions 1, 2, 4, 5, 6 implemented exactly as specified. Decision 3 (gated refresh) implemented exactly as designed, but conflicts with a spec-phase note marked "fixed by user" — see WARNING.

## Non-blocking observations
- `proposal.md`, `design.md`, and `specs/` for this change are untracked in git (never committed), while `tasks.md` was committed inside 4ee50af. Harmless pre-archive state.
- An unrelated pre-existing modification to `packages/client/src/client.ts` is present in the working tree; confirmed out of scope for this change.

## Issues

**CRITICAL**: None.

**WARNING**:
1. SchemaBrowserPanel refresh gating reverses a spec-phase note marked "fixed by user, not open questions" without being escalated as a design open question. No spec-text violation; behavior is arguably more honest; should be acknowledged/ratified by the user.

**SUGGESTION**:
1. Commit `proposal.md`, `design.md`, and `specs/` for this change so the working tree is clean ahead of archive.

## Verdict: **PASS WITH WARNINGS**
