# Proposal: Studio Table Browser live view over the embedded realtime stream

Change: `studio-live-view` (Road to 1.0, Phase 5 — "Studio as proof", epic "The live view"). Slice 1. Exploration: Engram #753; decisions: Engram `sdd/studio-live-view/decisions`.

## Intent

Phase 4 shipped the whole realtime stack — WAL source, shape log, `GET ?handle&offset`, `.live()` — and `packages/cli/src/studio-server.ts:302-338` already starts a `RealtimeEngine` **in-process** and mounts `REALTIME_PATH` whenever any model is `@@realtime`. (The roadmap's "Studio starts the realtime engine in its own process" is stale; it is already embedded.)

The Studio UI consumes none of it. `TableBrowserPage.tsx:57-82` fetches rows exactly once per table selection and otherwise only on a manual Refresh button. So IndigoDB's headline differentiator is fully built, running on the same port the developer already has open, and **invisible in the one tool built to demonstrate it**. This slice makes the Table Browser's grid update by itself when the database changes.

## Scope

### In Scope

- **Live refresh of the Table Browser's currently-selected table.** Subscribe to the already-running, already-unauthenticated SSE stream at `REALTIME_PATH` for that one table; on any frame, re-run the existing `fetchTableRows(name)` (`apps/studio/src/lib/api.ts:56`) and replace the grid's records through the existing `updateTableRecords` store action.
- **Both frame kinds trigger the same refetch.** `SseTransport` fans `event: change` to `onEvent` and `event: wake` to `onWake` (`packages/client/src/realtime.ts:121-143`); the Studio treats either as "this table changed, refetch". No payload is ever read off the frame.
- **Reuse `@indigodb/client`'s `SseTransport`** — explicitly browser-safe (`fetch()` streaming, no `EventSource`, `@indigodb/realtime` imported type-only) with reconnect/backoff already implemented. This requires a **new browser-safe subpath export** on `packages/client/package.json` (see Approach) so the Studio never pulls `pg` into its Vite bundle.
- **Debounced, coalesced refetch** reusing `.live()`'s established fixed 50ms trailing window (`LIVE_DEBOUNCE_MS`, already exported from `packages/client/src/live.ts`). Single in-flight refetch; a frame arriving mid-flight schedules exactly one follow-up.
- **A `connecting | live | error` status indicator** in the Table Browser toolbar, using `.live()`'s `LiveStatus` vocabulary. Shown only for realtime-eligible tables with a connected backend.
- **`realtime: boolean` threaded onto the Studio's `Table` view model** — `apps/studio/src/lib/schema-adapter.ts:70-88` currently drops `ResolvedTable.realtime`, so the UI cannot tell which tables are live-eligible. `redactSchema` (`studio-server.ts:161`) already preserves the field over `/api/schema`.
- **One `@@realtime` fixture/test model** proves the loop end to end; the rest of the browser is unchanged.
- **Inert in the sample-data path.** With no backend (`isBackendAvailable() === false`, standalone `pnpm dev`), no stream is opened and no indicator is shown — a hidden no-op, never an error.

### Out of Scope — deferred

- **`.live()` and the `@@allow`/RLS/handle trust boundary — permanently, not just for slice 1.** Studio already runs on the developer's own privileged, unscoped connection string (`/api/tables/:name` does a plain `SELECT`, no `set_config('app.user_id', ...)`). `.live()` is Node-only (`IndigoClientBase` owns a `pg.Pool` + `node:async_hooks`), is generated only for `@@realtime` **and** `@@allow` models, and demands an app-supplied `getHandle`. Forcing it here would need a fabricated identity and would silently exclude every model without `@@allow`. Studio's live view stays outside that boundary by design.
- **ERD live indicators** (pulsing nodes, etc.) — a different rendering surface (`src/features/erd/`, custom canvas/SVG). Separate slice.
- **Row-level diffing** (insert/update/delete applied incrementally). Full refetch + full grid re-render is the strategy, matching what `.live()` itself does.
- **Presence / broadcast / cursors**, live SQL console results, live ERD schema reload, and any write-back path.
- **Any change to `packages/realtime`, `crates/`, or the WASM artifact.** No server route is added or modified.

## Capabilities

### New Capabilities

- `studio-live-view`: the Table Browser live-refresh contract — subscription scoped to the active realtime table, `change`/`wake` both mapped to a debounced full refetch, single-in-flight + coalescing behavior, `connecting | live | error` status lifecycle, subscription teardown on table switch/unmount, realtime-eligibility gating, and the no-backend inert path.

### Modified Capabilities

- `client-live-queries`: `SseTransport`/`RealtimeConnectionManager` gain a documented browser-safe entry point (`@indigodb/client/realtime`) that is guaranteed free of `pg` and `node:async_hooks` — a packaging contract, not a behavior change to `.live()`.
- `studio-ui-honesty`: live-view affordances MUST be hidden (not disabled-with-a-lie, not erroring) when no backend is connected or the table is not `@@realtime`, matching the existing Refresh-button precedent.

## Approach

Single PR, frontend + one packaging change; no server, compiler, or WASM work.

**Packaging.** `@indigodb/client`'s only export condition today is `.` → `dist/index.js`, which re-exports `IndigoClientBase` (`pg`, `node:async_hooks`) and the driver adapters. Adding a `"./realtime"` subpath mapping to `dist/realtime.js` gives the Studio the transport without the Node surface, and makes the browser-safety promise in `realtime.ts`'s header an enforceable package boundary instead of a comment. `apps/studio` adds `@indigodb/client: workspace:*`.

**Subscription.** A new `useLiveTable(tableName, enabled)` hook next to `hooks/useTableData.ts`. It constructs `new SseTransport(window.location.origin, REALTIME_PATH)` (path constant imported type-safely from `@indigodb/realtime`, or inlined as `/api/realtime` if the type-only boundary makes that import awkward), subscribes to exactly the active table, and tears down on table change/unmount. Note the naming already lines up: the SSE `tables` param and `RealtimeEvent.table` carry **model** names (`engine.ts:139-141`), `/api/tables/:name` accepts model or `dbName` (`studio-server.ts:342`), and the Studio's `Table.name` is the model name.

**Refresh.** On `onEvent`/`onWake`, arm the 50ms trailing timer; on fire, `await fetchTableRows(name)` and hand the rows to `updateTableRecords`. This is the same call the existing Refresh button makes, so live and manual refresh converge on one code path.

**Status.** `onOpen` → `live`, `onOpen(reconnected: true)` → `live` (rows refetched, closing the LISTEN/NOTIFY replay gap), `onError` → `error`; `connecting` until the first open.

`apps/studio` already has vitest + Testing Library (`TableBrowserPage.test.tsx`, `useTableData.test.tsx`), so tests go there with an injected fake transport — the `RealtimeTransport` interface is already the seam.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/client/package.json` | Modified | additive `"./realtime"` subpath export (browser-safe) |
| `apps/studio/package.json` | Modified | `@indigodb/client: workspace:*` |
| `apps/studio/src/features/studio/browser/hooks/useLiveTable.ts` | New | subscribe, debounce, coalesce, status |
| `apps/studio/src/features/studio/browser/TableBrowserPage.tsx` | Modified | wire the hook to the active table + status indicator |
| `apps/studio/src/lib/schema-adapter.ts` | Modified | thread `realtime` onto the `Table` view model |
| `apps/studio/src/types.ts` | Modified | `Table.realtime?: boolean` |
| `apps/studio/src/lib/api.ts` | Unchanged | `fetchTableRows` reused as-is |
| `packages/cli/src/studio-server.ts` | Unchanged | `REALTIME_PATH` already mounted |
| `packages/realtime/`, `crates/`, `packages/compiler/wasm/` | Unchanged | no server or compiler change |
| `apps/studio/src/features/studio/browser/__tests__/` | New/Modified | live-refresh, teardown, offline-inert coverage |
| `fixtures/*.indigo` | Modified | one `@@realtime` model for the demo/test path |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Root `@indigodb/client` import drags `pg` into the Vite bundle | High | The `"./realtime"` subpath is a scoped prerequisite of this slice; a test asserts the Studio bundle has no `pg` import |
| Refetch storm under write bursts | High | Fixed 50ms trailing debounce, single in-flight, dirty-flag follow-up — same constant `.live()` uses |
| `/api/tables/:name` is a full `LIMIT 100` select; refetch-all is heavy for large tables | Med | Accepted for slice 1 and demoably correct; row-level diffing is the documented follow-up |
| A test model carrying `@@allow` has RLS enabled, so Studio's unscoped `SELECT` could return zero rows | Med | Slice 1 targets a `@@realtime`-only model (no `@@allow`); recorded as a known constraint of Studio's out-of-boundary posture |
| No `@@realtime` model ⇒ no engine ⇒ `REALTIME_PATH` 404s | Med | Gate the subscription on `Table.realtime` (the reason schema-adapter must carry it); nothing subscribes otherwise |
| Leaked SSE connection on table switch/unmount | Med | Explicit teardown, covered by a test |
| Sample-data fallback path errors instead of no-op | Med | Subscription gated on `isBackendAvailable()`; a test asserts silence offline |
| 400-line budget | Low–Med | ~200–300 lines forecast; `sdd-tasks` re-forecasts against the guard |

## Rollback Plan

1. Revert the `useLiveTable` hook and its wiring in `TableBrowserPage.tsx` — the Table Browser returns to fetch-once + manual Refresh, byte-for-byte.
2. Revert `schema-adapter.ts` / `types.ts` — `Table.realtime` is an additive optional field with no other consumer.
3. Drop `@indigodb/client` from `apps/studio`'s dependencies.
4. Drop the `"./realtime"` subpath from `packages/client/package.json` — purely additive; the `.` entry is untouched, so no existing consumer can break.

Code-only and frontend-only: no DDL, no migration, no server route, no WASM rebuild, no generated-client change.

## Dependencies

- `main` @ `c019bc3` (realtime slices 1–5 archived).
- The embedded `RealtimeEngine` in `studio-server.ts` — already shipped, unchanged.
- No new npm dependency; no Rust toolchain needed.

## Success Criteria

- [ ] With `indigodb studio` connected and a `@@realtime` table selected, an external `INSERT` makes the row appear in the grid with no user action
- [ ] `UPDATE` and `DELETE` on that table are reflected the same way, through the same refetch
- [ ] A burst of N writes inside the 50ms window produces exactly one refetch, not N
- [ ] A frame arriving during an in-flight refetch produces exactly one additional refetch afterwards
- [ ] Both `event: change` (no `@@allow`) and `event: wake` (`@@allow`) trigger the refetch; no frame field is read
- [ ] Switching the active table closes the previous subscription and opens exactly one for the new table
- [ ] Unmounting the Table Browser closes the subscription
- [ ] Selecting a non-`@@realtime` table opens no subscription and shows no live indicator
- [ ] With no backend (`pnpm dev`, sample data), no subscription is opened, no indicator renders, and nothing errors
- [ ] The status indicator reads `connecting` before first open, `live` after, `error` on transport failure; a reconnect returns to `live` and refetches
- [ ] The Studio's production bundle contains no `pg` / `node:async_hooks` import
- [ ] `pnpm build`, `lint`, `test` green; no diff under `packages/realtime/`, `crates/`, or `packages/compiler/wasm/`

## Open Questions

### Resolved (user, 2026-08-25) — all eight

1. **Auth boundary** — Studio's live view is **permanently outside** the `@@allow`/RLS/handle trust boundary. Studio already holds full, privileged, unscoped DB access; its live view matches that rather than simulating a restricted end-user view. **Rejected:** `.live()` (Node-only, requires `@@allow` + app auth). Reuse `SseTransport` directly.
2. **Scope** — Table Browser only. ERD live indicators are a separate future slice (different rendering technology).
3. **Test model scope** — one `@@realtime` test model, not the whole data browser retrofitted at once.
4. **Update strategy** — full refetch + full grid re-render on any change event. **Rejected:** insert/update/delete diffing; row-level diffing is future work if evidence demands it.

5. **Browser-safe import path for `SseTransport`** — add an additive `"./realtime"` subpath export to `packages/client/package.json`, mapping to `dist/realtime.js` and re-exporting `SseTransport` plus the other browser-safe pieces. The Studio imports from `@indigodb/client/realtime` and never pulls `pg` / `node:async_hooks` into its Vite bundle. It is a few lines, purely additive (the `.` entry is untouched, so no existing consumer can break), and turns `realtime.ts`'s "works in the browser" header comment into an enforced package boundary. **Rejected:** deep-importing `@indigodb/client/dist/realtime.js` (reaches past the package contract); reimplementing an SSE reader inside the Studio (duplicates tested reconnect/backoff/frame-parsing logic).
6. **Debounce policy** — reuse `.live()`'s existing fixed 50ms trailing window (`LIVE_DEBOUNCE_MS`, already exported from `packages/client/src/live.ts`) as the refetch trigger. **Rejected:** a per-frame refetch (a single `INSERT ... SELECT` of 500 rows would trigger 500 full-table refetches) and a second, Studio-local timing policy. Not caller-configurable, matching the `client-live-queries` precedent.
7. **Fixture model choice** — the demo/test model is `@@realtime`-only, with **no** `@@allow`. An `@@allow` model has RLS enabled on the real table, and Studio's `/api/tables/:name` never calls `set_config('app.user_id', ...)`, so the grid would show zero rows unless the Studio role is the table owner or `BYPASSRLS` — a confusing failure for the very slice meant to prove the feature. This is exactly the boundary decision 1 defers permanently.
8. **`REALTIME_PATH` in the browser** — re-export `REALTIME_PATH` and the related path constants from the new `@indigodb/client/realtime` entry point alongside `SseTransport`, so one browser-safe entry carries both. **Rejected:** importing from `@indigodb/realtime` directly (the same package exports `RealtimeEngine`, which imports `pg`) and locally re-declaring the string in the Studio (silent drift if the path ever changes).

### Still open

None. Questions 1–8 are closed; the proposal is ready for `sdd-spec` and `sdd-design`.
