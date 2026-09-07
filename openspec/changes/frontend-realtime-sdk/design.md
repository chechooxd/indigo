# Design: Frontend realtime SDK

## Technical Approach

Strategy A (Engram #915) is binding: the ORM stays server-side, the SSE route is wake-only
(#912, landed `9798f9c`), and the SDK ships **the signal, never the data**. Three layers, from
the bottom up:

1. `RealtimeEngine` gains a default-closed origin allowlist so a browser SDK is not pointed at a
   wildcard-CORS route.
2. `RealtimeConnectionManager` (`packages/client/src/realtime.ts`) gets a real channel-state model
   so one connection per table can serve N late-joining subscribers, each told it is live.
3. `createLiveSubscription()` — framework-agnostic, status-only, SSR-inert — lands in the existing
   `@indigodb/client/realtime` entry, and `@indigodb/react`'s `useLiveTable` is a thin
   `useSyncExternalStore` adapter over it. Studio's 173-line hook is re-based onto it as the
   binding's acceptance test.

No new import edge crosses into Node-only code: `@indigodb/client/realtime` keeps its
`@indigodb/realtime/protocol`-only value-import rule, and `@indigodb/react` imports **only** that
subpath.

## Architecture Decisions

### D1 — Corrected `RealtimeConnectionManager` open-state model

**Choice.** `TableChannel` stores `state: "connecting" | "live" | "error"`, `everOpened: boolean`
and `lastError: Error | null`. `ChannelListener` gains an **optional** `onOpen?(reconnected: boolean)`.

- Transport `onOpen(reconnected)` no longer returns early. It sets `state = "live"`,
  `everOpened = true`, `lastError = null`, then over a snapshot copy of the listener set calls
  `l.onOpen?.(reconnected)` and — **only when `reconnected === true`** — `l.onResync?.()`.
  The `if (!reconnected) return;` at `realtime.ts:198-201` is replaced by that inner guard, so
  `onResync`'s trigger condition is bit-for-bit what it is today.
- Transport `onError` sets `state = "error"`, `lastError = error`, fans out unchanged.
- **Replay on subscribe**: `subscribe()` adds the listener to the set *first*, then reads a
  snapshot of `state`/`lastError` taken before any callback runs and replays synchronously:
  `state === "live"` → `listener.onOpen?.(false)`; `state === "error"` → `listener.onError?.(lastError)`;
  `state === "connecting"` → nothing. Replay **never** calls `onResync`.

`reconnected: false` on replay is deliberate: it means "you are live and there is no gap to fill".
A late joiner has fetched nothing yet, so its own bootstrap covers it; firing `onResync` would
inject a spurious refetch into `.live()`.

**Alternatives rejected.** (a) Always fire `onOpen(true)` on replay — pushes a phantom resync into
`.live()`. (b) A separate `onLive()` callback — a second name for the same edge. (c) Fixing it in
`SseTransport` — the defect is the manager's missing state, not the transport's.

**What must not move** (`.live()` at `live.ts:361-370` already depends on this class): `onResync`
fires only on a true reconnect; refcounted open-on-first / close-on-last; the channel key is the
table name; `close()` semantics. `.live()` supplies no `onOpen`, so it observes zero behavior
change — `test/live.mjs` must stay green **unmodified**.

### D2 — `createLiveSubscription` vs `createLiveQuery`: separate, with one shared 8-line helper

**Choice.** Keep them separate. `createLiveSubscription` lives in `realtime.ts` and gets its own
`createWakeDebouncer(debounceMs)` internal helper; `live.ts:286-298` keeps its inline copy.

**Rationale.** The overlap is smaller than it looks. `createLiveQuery`'s state machine is
`inFlight`/`dirty` coalescing, handle minting with one retry, and row storage — all of which exist
*only because it fetches*. `createLiveSubscription` has no in-flight concept at all: `onWake` is a
synchronous app callback and the app owns the fetch, so coalescing is the app's cache's job. What
genuinely repeats is the ~8-line leading-edge-armed timer. Layering `live.ts` on the new primitive
would create an **import cycle**: `realtime.ts:27` already imports `LIVE_DEBOUNCE_MS` from
`./live.js`, so a `live.ts → realtime.ts` value import closes the loop. Breaking that would mean
moving `LIVE_DEBOUNCE_MS`/`LiveStatus` into a third module and re-exporting — churn inside the
exact class D1 is trying to keep untouched.

**Deferred, named:** extracting a shared debouncer module. Revisit when a third consumer appears.

### D3 — Debounce semantics: keep first-wake-armed, make the window configurable

**Choice.** Unchanged semantics: the first wake arms a fixed `debounceMs` timer; later wakes in the
same window are dropped, never re-arm it. `debounceMs` defaults to `LIVE_DEBOUNCE_MS` (50);
`debounceMs <= 0` disables the timer and delivers every wake immediately.

**Rationale.** A trailing debounce that re-arms on each frame starves the consumer outright under
sustained writes — the exact bug the existing comments call out. Leading-edge arming guarantees
*at most one* `onWake` per window and *at least one* per window while writes continue. Studio and
`.live()` both already ship this behavior; changing it would silently alter both.

### D4 — React binding: `useSyncExternalStore` over a lazily-started primitive

```ts
function useLiveTable(
  table: string | null | undefined,
  options: { transport: RealtimeTransport; onWake?: () => void; debounceMs?: number; enabled?: boolean },
): { status: LiveSubscriptionStatus; error: LiveSubscriptionError | null; retry: () => void };
```

- **Store.** `const sub = useMemo(() => createLiveSubscription({ table, transport, debounceMs, onWake: (...a) => onWakeRef.current?.(...a) }), [table, transport, debounceMs, enabled])`.
  `onWake` goes through a latest-ref, so a fresh inline closure per render never re-subscribes.
- **`subscribe`.** `useCallback((cb) => sub.subscribe(cb), [sub])` — identity changes only when the
  subscription itself does. The primitive is **inert until `subscribe()`**: the first subscriber
  opens the channel, the last one closes it. React's own subscribe callback is therefore the
  connection lifecycle, which is why nothing runs during render or on the server.
- **`getSnapshot`.** Two `useSyncExternalStore` calls against the same stable `subscribe`:
  `sub.getStatus` (a **string** union) and `sub.getError` (a stable `Error` identity or `null`).
  Snapshots are primitives/stable references, so there is no cached-object identity to get wrong
  and `getSnapshot` never allocates.
- **Tearing.** All hook instances on one table read state derived from the *same* channel via the
  manager, and React re-reads every snapshot before commit; a mid-render transition re-renders
  rather than committing mixed state.
- **StrictMode.** Double-invoked `useMemo` may build a second primitive, but an unsubscribed
  primitive is inert — no connection, no timer — so the discarded one leaks nothing.
  Double subscribe/unsubscribe is absorbed by the manager's refcount (1→0→1 reopens the channel);
  that is correct, not a leak, and no wake is duplicated.
- **Return.** `{ status, error, retry }`. `retry` is `useCallback(() => sub.retry(), [sub])`.
  The hook returns a fresh object per render (render output, not a snapshot) — intentional.
- `enabled: false` or `table == null` → the primitive is never created; the hook returns
  `{ status: "idle", error: null, retry: noop }`.

**Alternative rejected.** A `useEffect` + `useState` hook (Studio's current shape): it re-introduces
StrictMode double-open, cannot be read consistently by concurrent renders, and hardcodes the
"first paint is `connecting`" lie on the server.

### D5 — SSR

`getServerSnapshot` is `() => "idle"` for status and `() => null` for error. Hard rules:

- Neither `@indigodb/client/realtime` nor `@indigodb/react` touches `window`, `document`,
  `location`, or `fetch` at module scope, at construction, or during render.
- `createLiveSubscription` takes an **explicit** `transport`. There is no origin-inferring default;
  `useLiveTable.ts:94`'s unguarded `new SseTransport(window.location.origin, …)` is not reproduced.
  A `browserTransport(path?)` convenience helper is exported that reads `window.location.origin`
  and throws a named error when `typeof window === "undefined"` — it is never called at module scope.
- Consequence: server render commits `idle`, hydration subscribes, first client transition is
  `connecting`. No hydration text mismatch because the transition happens after commit.

### D6 — Terminal error and `retry()`

**Classification** (added to `SseTransport`, surfaced through the manager):

| Condition | Class |
|---|---|
| `fetch` rejects (`TypeError`: offline, DNS, **and CORS — indistinguishable**), stream ends, HTTP 5xx / 408 / 429 | transient — backoff continues |
| Any other non-2xx (400, 401, 403, 404, 410, …) | **terminal** — the retry loop stops |

`TransportHandlers` gains optional `onTerminal?(error)`. On terminal the loop returns instead of
sleeping — today a 404 retries forever, which is a defect, not a contract. `.live()` and Studio do
not supply `onTerminal`; they simply stop retrying a hopeless URL.

**Status machine**: `idle → connecting → live`; `live ⇄ error` (transient, auto-recovers);
`error → error` with `getError()!.terminal === true` (no auto-recovery); `close() → closed`.
`getError()` returns `LiveSubscriptionError { message, terminal, cause }`, cleared on the next
successful open.

**`retry()`**: no-op unless the current status is `error`. It clears `lastError`, releases and
re-acquires the channel (resetting `SseTransport`'s backoff to 1s), and sets `connecting`.
It is a no-op after `close()`. Because the channel is shared, `retry()` is **channel-level**: it
revives every listener on that table. Per-listener retry isolation is **deferred**.

### D7 — SSE origin allowlist

```ts
interface RealtimeEngineOptions {
  /** Exact origins (`scheme://host[:port]`) permitted to read the SSE and log routes.
   *  Omitted or empty ⇒ CLOSED: no cross-origin browser access at all. */
  allowedOrigins?: string[];
}
```

- **Default closed** (proposal Q2, binding). Nothing has ever been published; there is no
  cross-origin user to preserve.
- **No `Origin` header ⇒ allowed.** curl, the CLI daemon behind an operator proxy, a same-origin
  browser GET, and the recommended "proxy through your own backend" deployment all land here.
  This is exactly why **Studio's embedded engine keeps working unchanged**: its hook connects to
  its own origin.
- **Present and allowed** ⇒ `access-control-allow-origin: <that exact origin>` (never `*`) plus
  `vary: origin`. Never `access-control-allow-credentials`.
- **Present and not allowed** ⇒ `403` with `content-type: text/plain`, body
  `realtime: origin not allowed`, **no** CORS header. The browser sees an opaque network failure
  (hence the CORS row in D6); the 403 exists for operators reading logs and for curl.
- Matching is exact string equality on the lowercase-normalized serialized origin. No wildcards,
  no regex, no suffix matching — **deferred** until asked.
- The check lives inside `handleRequest` **and** `handleLogRequest`, not in `attach()`. `attach()`
  only routes, and neither the CLI daemon nor the Studio server calls it (`engine.ts:248-256`), so
  putting the gate in the handlers is the only placement that covers all three hosts.
- `OPTIONS` on either path returns `204` with the same headers when allowed, `403` otherwise.
- Operator surface: `indigodb realtime --allow-origin <origin>` (repeatable) and
  `INDIGODB_REALTIME_ALLOWED_ORIGINS` (comma-separated), merged.

### D8 — `@indigodb/react` package boundaries

| Aspect | Decision |
|---|---|
| Location / name | `packages/react`, `@indigodb/react`, `0.0.1`, ESM, `type: module` |
| Dependency | `@indigodb/client: workspace:*`, imported **only** as `@indigodb/client/realtime` |
| React | `peerDependencies: { react: ">=18.0.0" }` + devDependency; never a hard dep |
| Exports | `main`/`types` `./dist/index.js` / `.d.ts`; single `"."` export, `files: ["dist"]` |
| Scripts | `build: tsc`, `lint: tsc --noEmit`, `test: vitest run && node test/browser-safety.mjs` |
| Pack guard | `scripts/check-pack-contents.mjs` auto-discovers `packages/*`; `files: ["dist"]` + a packed `main` satisfies it with **zero script changes**. Do not mark the package `private` |

The workspace dep pulls `pg` into a consumer's `node_modules` (transitively, via
`@indigodb/client`'s root). That is an install-graph cost, not a bundle cost: only the `./realtime`
subpath is ever imported, so no bundler ever reaches `pg`. Splitting a third `@indigodb/live-core`
package to avoid it is rejected by proposal decision 2.

Browser-safety is guarded by `packages/react/test/browser-safety.mjs`, reusing
`packages/client/test/realtime-entry.mjs`'s static reachable-specifier scan with
`FORBIDDEN = ["pg", /^node:/]`. It lives in `packages/react` rather than extending the client's
test, because the dependency direction runs react → client and a test must not reach forward.

## Data Flow

    Postgres WAL ─→ RealtimeEngine ──(origin allowlist, D7)──→ SSE `wake` frame
                                                                    │
                                        SseTransport (backoff + terminal class, D6)
                                                                    │
                                RealtimeConnectionManager  ← one channel per table (D1)
                                       │ state: connecting|live|error, replayed on subscribe
                                       ▼
                            createLiveSubscription (status only, debounce D3)
                               │                                   │
                     getStatus/getError                        onWake()
                               │                                   │
                    useSyncExternalStore (D4)          app cache: queryClient.invalidateQueries
                               ▼                                   │
                     { status, error, retry }              app's own authenticated API ──→ rows

Rows never traverse the left column. The SDK holds no data.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/realtime/src/engine.ts` | Modify | `allowedOrigins` option; origin gate + `OPTIONS` in `handleRequest`/`handleLogRequest`; replaces `*` at `:234` |
| `packages/realtime/test/origin-allowlist.mjs` | Create | Origin gate cases over a real `node:http` listener, no DB |
| `packages/cli/src/index.ts` | Modify | `--allow-origin` (repeatable) + env, forwarded to the engine |
| `packages/cli/src/studio-server.ts` | Modify | Forward the same option to the embedded engine |
| `packages/client/src/realtime.ts` | Modify | D1 channel state + replay, `ChannelListener.onOpen`, `onTerminal` classification, `createLiveSubscription`, `createWakeDebouncer`, `browserTransport` |
| `packages/client/test/realtime-manager.mjs` | Create | D1 state machine + replay against a fake transport |
| `packages/client/test/live-subscription.mjs` | Create | Primitive: status machine, debounce, terminal, `retry`, `close` |
| `packages/client/test/realtime-entry.mjs` | Modify | Add: importing the entry under bare Node (no DOM globals) has no side effects |
| `packages/client/README.md` | Modify | Browser section, wake-only contract, non-goals, TanStack recipe |
| `packages/react/**` | Create | `@indigodb/react`: `src/index.ts`, `src/use-live-table.ts`, package/tsconfig, tests |
| `apps/studio/.../hooks/useLiveTable.ts` | Modify | Re-based on `useLiveTable` from `@indigodb/react`; bypass comment deleted |

## Interfaces / Contracts

```ts
// @indigodb/client/realtime
export type LiveSubscriptionStatus = "idle" | "connecting" | "live" | "error" | "closed";
export interface LiveSubscriptionError { message: string; terminal: boolean; cause?: unknown }

export interface LiveSubscriptionOptions {
  table: string;
  transport: RealtimeTransport;          // explicit — no window-derived default (D5)
  onWake?: () => void;                   // the app's invalidation callback; never receives rows
  debounceMs?: number;                   // default LIVE_DEBOUNCE_MS (50); <= 0 disables (D3)
  manager?: RealtimeConnectionManager;   // default: one per transport, module-cached
}

export interface LiveSubscription {
  getStatus(): LiveSubscriptionStatus;   // pure, allocation-free, safe pre-start
  getError(): LiveSubscriptionError | null;
  subscribe(onChange: () => void): Unsubscribe; // first call starts, last unsubscribe stops
  retry(): void;                         // no-op unless status === "error"
  close(): void;                         // idempotent; status becomes "closed"
}

export interface ChannelListener {       // ADDITIVE only
  onEvent: (event: RealtimeEvent) => void;
  onWake?: () => void;
  onOpen?: (reconnected: boolean) => void;   // NEW
  onResync?: () => void;                      // unchanged trigger condition
  onError?: (error: Error) => void;
}
```

## Testing Strategy

Strict TDD: every row below is a RED test proven to fail by a recorded mutation, run against
**rebuilt `dist/`** (`pnpm --filter <pkg> build` first — suites import `dist/`, not `src/`).

| # | Capability / scenario | Layer | Proof |
|---|---|---|---|
| T1 | No `Origin` header ⇒ subscription allowed | Integration | `origin-allowlist.mjs`: real `node:http` + fake source; assert 200 + `text/event-stream` |
| T2 | Unlisted `Origin` ⇒ 403, no CORS header | Integration | Assert status 403, body text, `access-control-allow-origin` absent |
| T3 | Listed `Origin` ⇒ echoed exactly, never `*`, with `vary: origin` | Integration | Assert header equals the request origin |
| T4 | Default (option omitted) is closed | Integration | Engine built with no `allowedOrigins`; any `Origin` ⇒ 403 |
| T5 | Log route obeys the same gate | Integration | Same three cases against `REALTIME_LOG_PATH` |
| T6 | `OPTIONS` preflight: 204 allowed / 403 rejected | Integration | Both paths |
| T7 | CLI `--allow-origin` + env merge into the option | Unit | Assert the parsed option array from the CLI arg/env parser |
| T8 | First `onOpen` reaches listeners (defect `realtime.ts:198-201`) | Unit | `realtime-manager.mjs`: fake transport fires `onOpen(false)`; listener's `onOpen` observed |
| T9 | Late subscriber on a `live` channel is replayed `onOpen(false)` synchronously | Unit | Subscribe after open; assert callback ran before `subscribe()` returned |
| T10 | Replay never fires `onResync` | Unit | Late subscriber records zero `onResync` calls |
| T11 | `onResync` still fires only on `reconnected === true` | Unit | `onOpen(false)` ⇒ 0 resyncs; `onOpen(true)` ⇒ 1 per listener |
| T12 | Late subscriber on an `error` channel is replayed the stored error | Unit | Assert same `Error` identity |
| T13 | Refcount unchanged: one connect for N listeners, close on last | Unit | Count fake-transport `connect`/`close` calls |
| T14 | `.live()` unaffected | Regression | `packages/client/test/live.mjs` passes **unmodified** |
| T15 | Primitive is inert before `subscribe()` | Unit | `live-subscription.mjs`: construct; assert zero `connect` calls, status `idle` |
| T16 | First subscribe opens, last unsubscribe closes | Unit | Transport call counts across 2 subscribers |
| T17 | Status machine `idle→connecting→live` and `live⇄error` | Unit | Drive the fake transport; assert the emitted status sequence |
| T18 | Debounce: burst of N wakes in one window ⇒ exactly one `onWake` | Unit | Fake timers/`setTimeout` control |
| T19 | Debounce never re-arms (anti-starvation) | Unit | Sustained wakes every `debounceMs/2` still deliver on schedule |
| T20 | `debounceMs: 0` delivers every wake immediately | Unit | Assert 1:1 wake count |
| T21 | Terminal HTTP (404/401) stops the retry loop, `terminal: true` | Unit | Fake fetch returning 404; assert no second attempt after backoff window |
| T22 | Transient (5xx / stream end / `TypeError`) keeps retrying, `terminal: false` | Unit | Assert reconnect attempt occurs |
| T23 | `retry()` clears the terminal error and reconnects; no-op when `live`/`closed` | Unit | Assert status + connect counts for each start state |
| T24 | `close()` is idempotent; post-`close` `retry()` is a no-op | Unit | Double-close, then retry |
| T25 | SDK never exposes rows | Unit + types | `onWake` arity is 0; no `rows` on `LiveSubscription`; `tsc --noEmit` typecheck fixture |
| T26 | Entry import is side-effect-free with no DOM globals | Unit | `realtime-entry.mjs`: import `dist/realtime.js` in bare Node; assert no throw |
| T27 | `browserTransport()` throws a named error server-side | Unit | Same file, `typeof window === "undefined"` |
| T28 | `./realtime` closure stays free of `pg`/`node:async_hooks` | Static | Existing `realtime-entry.mjs` scan, unchanged |
| T29 | Hook returns `idle` on the server; nothing touches `window` | Unit | `renderToString` under vitest with `window` deleted |
| T30 | `getServerSnapshot` used, no hydration mismatch | Unit | `renderToString` + `hydrateRoot`, assert no React error/warning |
| T31 | StrictMode mount/unmount/remount leaves zero leaked connections | Unit | `@testing-library/react` in `StrictMode`; fake-transport connect/close counts balance |
| T32 | A fresh inline `onWake` per render does not re-subscribe | Unit | Re-render with a new closure; assert connect count stays 1 |
| T33 | N hook instances on one table ⇒ exactly one connection | Unit | Render 3 hooks; assert 1 `connect` |
| T34 | An instance mounting on an already-open channel reports `live` without a reconnect | Unit | Mount second hook after first is `live`; assert `live` with 0 extra connects |
| T35 | `enabled: false` / `null` table ⇒ `idle`, no connection | Unit | Assert connect count 0 |
| T36 | Hook surfaces terminal error and a working `retry` | Unit | Drive fake transport to 404; assert `error.terminal`, click retry, status `connecting` |
| T37 | `@indigodb/react`'s graph imports no `node:`/`pg` module | Static | `packages/react/test/browser-safety.mjs` |
| T38 | `@indigodb/react` packs only `dist` and ships its `main` | Static | `scripts/check-pack-contents.mjs` (no script change) |
| T39 | Studio's live table behavior is preserved after the re-base | Regression | Existing Studio `useLiveTable` vitest suite, re-pointed at the new hook |
| T40 | Studio opens one connection and the bypass comment is gone | Regression + Static | Vitest connect count; grep assertion that the bypass rationale text is absent |
| T41 | README states the browser entry, wake-only contract, non-goals | Docs | `packages/client/test/readme-contract.mjs`: assert the required headings/phrases exist |

## Threat Matrix

The change adds an HTTP access-control boundary but no shell, subprocess, VCS, PR, or
executable-classification boundary.

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — no file classification or execution occurs | — | — |
| Git repository selection | N/A — no VCS automation | — | — |
| Commit state | N/A — no VCS automation | — | — |
| Push state | N/A — no VCS automation | — | — |
| PR commands | N/A — no PR automation | — | — |
| **HTTP origin admission** (addendum) | **Applicable** — D7 changes route access control | Exact-match allowlist, default closed, no wildcard/suffix matching, no credentials header, gate in both handlers not `attach()` | T1–T6; plus a negative case: `https://evil.example.com` prefixed/suffixed against a listed origin (`https://app.example.com.evil.com`) must be rejected |

## Migration / Rollout

Six stacked PRs onto `main` (`auto-chain`, `stacked-to-main`), all under the 800-line budget.
Slice 6 of the proposal (generator target awareness) is **dropped** (Q4, binding); the remaining
slices are renumbered here.

| # | Slice | Milestone | Depends on | Est. lines |
|---|---|---|---|---|
| 1 | Origin allowlist: engine + CLI/Studio wiring | M1 | — | ~272 |
| 2 | `RealtimeConnectionManager` open-state fix + replay (D1) | M1 | — | ~270 |
| 3 | `createLiveSubscription` + `SseTransport` terminal classification (D2/D3/D6) | M1 | 2 | ~430 |
| 4 | Docs: README browser section, TanStack recipe, non-goals | M1 | 3 | ~250 |
| 5 | `@indigodb/react` package + `useLiveTable` (D4/D5/D8) | M2 | 3 | ~620 |
| 6 | Studio `useLiveTable` re-based onto the SDK | M2 | 5 | ~255 |

Total ≈ **2,097 lines**. Slices 1 and 2 are parallel; 3 gates 4 and 5. M2 proceeds automatically
after M1 (Q1). Slice 5 is the one to watch: if package scaffolding runs over, split it into
`5a` (package skeleton + build/pack/browser-safety guards) and `5b` (the hook).

```
Decision needed before apply: No
Chained PRs recommended: Yes
400-line budget risk: High
```

Rollback is `git revert` of each merge commit, newest first. Every slice is additive to published
surface except slice 1 (reverts to wildcard CORS) and slice 2 (reverts to the swallowed `onOpen`,
safe because only new code depends on the fix).

## Open Questions

Explicitly deferred, not silently dropped:

- [ ] Extracting a shared debouncer between `live.ts` and `realtime.ts` — blocked by the
      `realtime.ts:27` import cycle (D2). Revisit on a third consumer.
- [ ] Per-listener `retry()` isolation. Today `retry()` is channel-level and revives every
      listener on that table (D6).
- [ ] CORS rejection is indistinguishable from offline in the browser, so it classifies as
      transient (D6). Mitigated by the engine's 403 in operator logs, not solved.
- [ ] Wildcard / suffix / regex origin matching and `access-control-allow-credentials` (D7).
- [ ] Non-React bindings and Suspense integration — deferred by proposal decision 2/5.
- [ ] `packages/react` adds `vitest` + `jsdom` + `@testing-library/react` devDependencies (the
      second such setup after `apps/studio`). Accepted: T29–T36 need a real renderer, and plain
      Node cannot exercise StrictMode or hydration.
