# Design: Studio Table Browser live view

## Technical Approach

Studio has no generated `IndigoClient`, so `.live()` is unreachable by construction: it is
Node-only (`IndigoClientBase` owns `pg` + `node:async_hooks`), is emitted only for `@@realtime`
+ `@@allow` models, and requires an app-supplied `getHandle`. The live subscription therefore
connects **one layer below `.live()`**: Studio imports the same browser-safe `SseTransport`
that `.live()` itself rides on, and re-implements only `createLiveQuery`'s ~40-line
debounce/coalesce/status core as a React hook, reusing its exported `LIVE_DEBOUNCE_MS` and
`LiveStatus` vocabulary. Structure mirrored, code not shared — `createLiveQuery`'s
`requireHandle`/`getHandle`/`runScoped` deps are mandatory and all three are meaningless here.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Live entry point | `SseTransport` via a new `@indigodb/client/realtime` subpath | `.live()`; a Studio-local SSE reader | `.live()` needs Node + `@@allow` + auth; a local reader duplicates tested frame parsing and backoff |
| 2 | `REALTIME_PATH` source | Add an additive `"./protocol"` export to `packages/realtime/package.json`; `src/realtime.ts` re-exports `REALTIME_PATH`/`REALTIME_LOG_PATH` from it, plus `LIVE_DEBOUNCE_MS`/`LiveStatus` from `./live.js` | deep-import `@indigodb/realtime/dist/protocol.js`; redeclare the string | An `exports` map **blocks** deep imports under NodeNext, so the subpath is required, not preferred. `protocol.ts` imports nothing — verified `pg`-free. `live.ts` also imports nothing |
| 3 | Entry file | Extend `src/realtime.ts` → mapping stays literally `dist/realtime.js` | a separate `src/browser.ts` | Matches the spec's named build; `index.ts` re-exports explicit named lists, so no duplicate-export conflict |
| 4 | Transport wrapper | `SseTransport` directly, **not** `RealtimeConnectionManager` | the manager | The manager swallows the first `onOpen` (it only fans out `onResync` on reconnect), which is exactly the `connecting → live` edge the spec requires; refcounting buys nothing for one subscriber |
| 5 | Debounce arming | First-frame-armed fixed 50ms window, never re-armed mid-burst (`live.ts:286-298`) | resetting the timer per frame | Resetting starves the grid under sustained writes. Observable outcome for the spec's burst scenario is identical: one refetch |
| 6 | **`error` recovery** | `error` is **transient and auto-recovering**, never terminal. `onError` → `error`; `SseTransport`'s own backoff (1s→30s) keeps retrying; `onOpen(reconnected)` → `error`/`connecting` → `live` + one immediate refetch bypassing the debounce. **No new retry control** | a manual "Retry" button; treating `error` as terminal like `createLiveQuery` does | The transport already owns retry; a manual retry would have to tear down and recreate it, restarting backoff and risking two connections. `createLiveQuery`'s terminal `error` guards *handle* failure, which does not exist here. The existing Refresh button is the manual escape hatch — adding a second one would violate `studio-ui-honesty` |
| 7 | Refetch failure | `fetchTableRows` returning `null` keeps the previous rows and does **not** set `error` or tear down | clearing the grid; erroring | `api.ts` fails soft by contract; mirrors `live.ts`'s "refetch rejects → rows/status unchanged". Data-fetch failure is not a subscription-lifecycle failure |
| 8 | Inert signalling | Hook returns `status: null` when inert; the badge renders only on non-`null` | a `disabled` badge | Encodes `studio-ui-honesty` in the type, not in JSX conditionals |

## Data Flow

    frame (change|wake)
        │  no field read
        ▼
    SseTransport ──onEvent/onWake──▶ scheduleRefetch ──50ms──▶ refetch
        │                              (armed-once)              │ inFlight/dirty
        ├──onOpen(false)──▶ status=live                          ▼
        ├──onOpen(true)───▶ status=live + immediate refetch   fetchTableRows(name)
        └──onError────────▶ status=error (transport keeps retrying)
                                                                 ▼
                                                      updateTableRecords → grid

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/realtime/package.json` | Modify | additive `"./protocol"` export → `dist/protocol.js` (types/constants only) |
| `packages/client/src/realtime.ts` | Modify | re-export block (decision 2); header note that value imports are `protocol`-only |
| `packages/client/package.json` | Modify | additive `"./realtime"` export (`types` before `import`) |
| `packages/client/test/realtime-entry.mjs` | Create | subpath resolves; `dist/realtime.js` graph has no `pg`/`node:async_hooks` |
| `apps/studio/package.json` | Modify | `@indigodb/client: workspace:*` |
| `apps/studio/src/features/studio/browser/hooks/useLiveTable.ts` | Create | subscription + debounce/coalesce/status state machine |
| `apps/studio/src/features/studio/browser/components/LiveStatusBadge.tsx` | Create | renders only for a non-`null` status |
| `.../browser/TableBrowserPage.tsx` | Modify | call the hook; mount the badge in the toolbar |
| `apps/studio/src/lib/schema-adapter.ts`, `src/types.ts` | Modify | thread `realtime?: boolean` onto `Table` |
| `apps/studio/src/features/studio/browser/__tests__/useLiveTable.test.tsx` | Create | fake transport + fake clock |
| `fixtures/02-studio-initial.indigo` | Modify | `@@realtime` on `Post`; regenerate that golden snapshot |

## Interfaces / Contracts

```ts
// apps/studio/.../hooks/useLiveTable.ts
export interface UseLiveTableDeps {           // test seam — all optional
  transport?: RealtimeTransport;              // default: new SseTransport(origin, REALTIME_PATH)
  fetchRows?: (name: string) => Promise<QueryResult | null>;
  debounceMs?: number;                        // default LIVE_DEBOUNCE_MS
}
/** `null` status ⇒ inert: no subscription, no indicator. */
export function useLiveTable(
  tableName: string | undefined,
  enabled: boolean,
  deps?: UseLiveTableDeps,
): { status: LiveStatus | null };
```

One `useEffect` keyed on `[tableName, enabled]`. `destroyed`/`inFlight`/`dirty`/`timer` are
closure locals (not state) so no frame causes a re-render; only `status` is React state.
`fetchRows` and `updateTableRecords` are held in refs so the effect never re-subscribes.
Cleanup sets `destroyed`, clears the timer, then calls the transport's unsubscribe — that one
cleanup satisfies both the table-switch and unmount teardown requirements.

Call site: `useLiveTable(activeTable?.name, isBackendAvailable() && activeTable?.realtime === true)`.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (`apps/studio`, vitest) | one-subscription-per-table, gating, burst coalescing, mid-flight follow-up, `connecting→live→error→live`, reconnect refetch, teardown, offline inert | `renderHook` + injected fake `RealtimeTransport` capturing handlers + `vi.useFakeTimers()` |
| Component | badge hidden for non-realtime / no-backend; visible and live otherwise | Testing Library over `TableBrowserPage` |
| Integration (`packages/client`, node) | `./realtime` resolves, exposes `SseTransport` + `REALTIME_PATH`; root `.` unchanged; no `pg` in the graph | `test/realtime-entry.mjs`, appended to the package `test` script |
| Manual | external `INSERT`/`UPDATE`/`DELETE` appear with no user action | `indigodb studio` against the fixture schema |

## Threat Matrix

N/A — no routing change (an existing, already-mounted path is consumed, none added or
modified), no shell, subprocess, VCS/PR automation, executable-file classification, or process
integration. Table names reach the wire only through `SseTransport`'s `URLSearchParams` and
`api.ts`'s `encodeURIComponent`, both pre-existing.

## Migration / Rollout

No migration. Reverting follows the proposal's four steps plus reverting decision 2's
`"./protocol"` export and the fixture/snapshot pair; every package change is purely additive.

## Open Questions

None. The `error` recovery timing flagged by `sdd-spec` is closed by decision 6.

## Notes

- The spec's burst scenario says frames "restart" the window; decision 5 arms once instead.
  The scenario's asserted outcome (exactly one refetch) holds identically — the wording is
  descriptive prose, not a distinct requirement.
- The proposal said "no change to `packages/realtime`". Decision 2 is a documented, minimal
  deviation: an `exports`-map line, zero source lines, forced by NodeNext deep-import blocking.
- The existing fetch-once-on-selection effect and a live refetch can both write the same rows;
  last write wins with identical data. Accepted.
