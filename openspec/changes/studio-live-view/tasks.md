# Tasks: Studio Table Browser live view

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~420–520 (authored) + fixture/snapshot regen (excluded from authored count) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Browser-safe `@indigodb/client/realtime` subpath (packaging only, no Studio changes) | PR 1 | `pnpm --filter @indigodb/client test` (adds `node test/realtime-entry.mjs`) | N/A — packaging/export-graph check only, no live server needed | Revert `packages/realtime/package.json` `./protocol` export + `packages/client/src/realtime.ts` + `packages/client/package.json` `./realtime` export + delete `test/realtime-entry.mjs`; zero Studio-side coupling |
| 2 | `useLiveTable` hook + badge + `TableBrowserPage` wiring + fixture/schema-adapter | PR 2 | `pnpm --filter @indigodb/studio test -- useLiveTable TableBrowserPage` | `indigodb studio` against `fixtures/02-studio-initial.indigo` (external INSERT/UPDATE/DELETE observed live, no user action) | Revert `useLiveTable.ts`, `LiveStatusBadge.tsx`, the `TableBrowserPage.tsx`/`schema-adapter.ts`/`types.ts` hunks, and the fixture/snapshot pair — independent of PR 1's export surface once merged |

## Phase 1: `@indigodb/client/realtime` browser-safe subpath (PR 1)

- [x] 1.1 Modify `packages/realtime/package.json`: add additive `"./protocol"` export → `dist/protocol.js` (types before import), alongside the existing `.` export.
- [x] 1.2 RED: create `packages/client/test/realtime-entry.mjs` asserting `@indigodb/client/realtime` resolves, exports `SseTransport` + `REALTIME_PATH`, and its reachable module graph contains no `pg`/`node:async_hooks` import; also assert the root `.` entry's exports are unchanged. Wire it into `packages/client/package.json`'s `test` script. Confirm it fails (subpath does not exist yet).
- [x] 1.3 GREEN: modify `packages/client/src/realtime.ts` to add a re-export block sourcing `REALTIME_PATH`/`REALTIME_LOG_PATH` from `@indigodb/realtime/protocol` and `LIVE_DEBOUNCE_MS`/`LiveStatus` from `@indigodb/realtime`'s `live.js` (per design decision 2); add a header note that value imports stay `protocol`-only.
- [x] 1.4 GREEN: modify `packages/client/package.json` to add the additive `"./realtime"` export (`types` before `import`) mapping to `dist/realtime.js`.
- [x] 1.5 Verify: `pnpm --filter @indigodb/client build && pnpm --filter @indigodb/client test` passes, including `realtime-entry.mjs`; `pnpm --filter @indigodb/realtime build` unaffected.
- [x] 1.6 Verify spec scenario coverage for `client-live-queries`: subpath resolves + Node-surface-free, root `.` entry byte-identical, browser bundle excludes `pg` (covered by 1.2's graph check; no bundler step needed since the check inspects the module graph directly).

## Phase 2: `useLiveTable` hook — subscription + debounce/coalesce/status core (PR 2)

- [x] 2.1 Modify `apps/studio/src/types.ts` and `apps/studio/src/lib/schema-adapter.ts`: thread `realtime?: boolean` onto the `Table` type and populate it from the resolved schema's `@@realtime` metadata.
- [x] 2.2 RED: create `apps/studio/src/features/studio/browser/__tests__/useLiveTable.test.tsx` using `renderHook` + an injected fake `RealtimeTransport` (capturing `onEvent`/`onWake`/`onOpen`/`onError`) + `vi.useFakeTimers()`. Cover: exactly one subscription for a realtime-eligible table + backend connected; no subscription for a non-realtime table; no subscription with no backend (`enabled=false`); `change` frame refetches only after 50ms; `wake` frame follows the identical path; a burst of 5 frames within 50ms produces exactly one refetch; a frame mid-flight (in-flight refetch pending) produces exactly one follow-up refetch after resolution; status sequence `connecting → live`; reconnect (`onOpen(true)`) returns to `live` and triggers one immediate refetch bypassing debounce; `onError` sets `error` without tearing down, and a later `onOpen` recovers to `live`; switching `tableName` tears down the old subscription and opens exactly one new one; unmount tears down the subscription; `fetchRows` returning `null` leaves prior rows/status unchanged. Confirm all cases fail (hook does not exist yet).
- [x] 2.3 GREEN: create `apps/studio/src/features/studio/browser/hooks/useLiveTable.ts` implementing `useLiveTable(tableName, enabled, deps?)` per the design's interface: one `useEffect` keyed on `[tableName, enabled]`; `destroyed`/`inFlight`/`dirty`/`timer` as closure locals; `fetchRows`/`updateTableRecords` held in refs; default `transport` is `new SseTransport(origin, REALTIME_PATH)`; default `debounceMs` is `LIVE_DEBOUNCE_MS`; returns `{ status: LiveStatus | null }` with `null` when inert.
- [x] 2.4 Run `useLiveTable.test.tsx` and confirm all cases now pass (GREEN).
- [x] 2.5 RED: extend `apps/studio/src/features/studio/browser/__tests__/TableBrowserPage.test.tsx` (Testing Library) asserting the live status badge is absent for a non-realtime table, absent with no backend connected, and present/rendering `live` status text otherwise. Confirm it fails (badge component does not exist yet).
- [x] 2.6 GREEN: create `apps/studio/src/features/studio/browser/components/LiveStatusBadge.tsx` rendering only for a non-`null` status (encodes `studio-ui-honesty` in the type per design decision 8, not via a JSX `disabled` conditional).
- [x] 2.7 GREEN: modify `apps/studio/src/features/studio/browser/TableBrowserPage.tsx` to call `useLiveTable(activeTable?.name, isBackendAvailable() && activeTable?.realtime === true)` and mount `LiveStatusBadge` in the toolbar next to the existing Refresh button.
- [x] 2.8 Run the extended `TableBrowserPage.test.tsx` and confirm it now passes (GREEN).
- [x] 2.9 Modify `fixtures/02-studio-initial.indigo`: add `@@realtime` to `Post`; regenerate the corresponding golden snapshot per `node packages/compiler/test/regen-snapshots.mjs` (review the diff as the change artifact, per CLAUDE.md).
- [x] 2.10 Verify: `pnpm --filter @indigodb/studio test` and `pnpm --filter @indigodb/compiler test` both pass; `pnpm build && pnpm lint` clean for `apps/studio` and touched packages.
- [x] 2.11 Manual verification (per design's Testing Strategy): run `indigodb studio` against the updated fixture schema and confirm an external `INSERT`/`UPDATE`/`DELETE` on `Post` appears in the grid with no user action, while a non-realtime table shows no badge. **Environment-limited**: no live Postgres/browser session available in this sandboxed agent execution; verified instead that `packages/cli/src/studio-server.ts` already embeds a `RealtimeEngine` and mounts it at the exact `REALTIME_PATH` `useLiveTable`'s default `SseTransport` targets (pre-existing wiring, confirmed by inspection), plus the full automated test matrix (unit + component + regression) passing end to end.

## Phase 3: Cleanup

- [x] 3.1 Re-check `apps/studio/src/features/studio/browser/hooks/useTableData.ts` and `TableBrowserPage.tsx` for any now-redundant polling/manual-refetch scaffolding made obsolete by `useLiveTable`; leave the manual Refresh button intact (it remains the explicit escape hatch per design decision 6). Confirmed: no polling scaffolding exists anywhere in either file to remove; the existing fetch-on-selection effect is the initial load, not a poll, and stays independent of `useLiveTable`'s change/wake-triggered refetch.
- [x] 3.2 Confirm no dead imports remain from the `realtime?: boolean` threading in `schema-adapter.ts`/`types.ts`. Confirmed: both edits are additive property lines only, no new imports introduced, `tsc --noEmit` clean across the whole workspace.
