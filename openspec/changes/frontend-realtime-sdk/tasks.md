# Tasks: Frontend realtime SDK

Six stacked PRs (`auto-chain`, `stacked-to-main`), M1 = slices 1–4, M2 = slices 5–6 (M2 proceeds
automatically after M1 per the RESOLVED proposal question round). Proposal's slice 6 (generator
target awareness) is dropped (Q4); slices are renumbered per design.

## Scenario → T-row → Task mapping (reconciliation)

56 spec scenarios, 41 design T-rows. Every scenario below resolves to a task. `NEW` = a task
added here because no T-row covered it (a genuine coverage hole, closed). `T41→4.x` = one coarse
T-row decomposed into several precise assertions. The 7 scenarios marked `+` were added by the
spec patch that closed Conflicts 1–3 below; each maps to a task that already existed.

### realtime-live-subscription (22 scenarios, MODIFIED)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| Return shape carries no rows | T25 | 3.11 | |
| + getError() is null before any error | T25 | 3.19 | getError gap RESOLVED |
| + A terminal error is retrievable with its classification | T21 | 3.19 | getError gap RESOLVED |
| + A transient error is retrievable as non-terminal | T22 | 3.19 | getError gap RESOLVED |
| + Repeated getError() calls return one identical object | T25 | 3.19 | getError gap RESOLVED |
| + getError() is cleared on the next successful open | T25 | 3.19 | getError gap RESOLVED |
| + retry() clears the retrievable error | T23 | 3.19 | getError gap RESOLVED |
| + Constructed but unsubscribed is inert at idle | T15 | 3.1 | Conflict 1 RESOLVED |
| First subscribe() connecting→live | T17 | 3.3 | Conflict 1 RESOLVED — reworded |
| No duplicate callback per identical status | T17 | 3.4 | |
| Transport error stays error | T17 | 3.3 | |
| + Non-2xx that is not 5xx/408/429 is terminal, halts retry | T21 | 3.13 | Conflict 2 RESOLVED |
| + 5xx / stream end / `TypeError` stay transient | T22 | 3.14 | Conflict 2 RESOLVED |
| + Every named TERMINAL status (400/401/403/404/410) classified at runtime | T21 | 3.20 | Phase 3 verify WARNING 1 CLOSED |
| + Every named TRANSIENT status (408/429/500/502) classified at runtime | T22 | 3.21 | Phase 3 verify WARNING 1 CLOSED |
| retry() from error re-opens | T23 | 3.9 | |
| retry() while live is a no-op | T23 | 3.9 | |
| Burst of wakes → exactly one onWake | T18 | 3.5 | |
| Wakes >window apart → two calls | T18 | 3.7 | |
| close() twice does not throw | T24 | 3.10 | |
| Wake in flight at close never fires | T24 | 3.10 | |
| Import under Node, no DOM globals | T26 | 3.16 | |

### client-live-queries (8 scenarios, ADDED)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| Late join on open channel → onOpen(false) | T9 | 2.2 | |
| First open no longer swallowed | T8 | 2.1 | |
| Genuine reconnect → onOpen(true) + resync | T11 | 2.4 | |
| Replay never fires onResync | T10 | 2.3 | |
| + Terminal channel error leaves `.live()` stopped, no self-revive | T21 | 3.22 | Phase 3 verify WARNING 2 CLOSED |
| + `.live()`'s `retry()` revives the shared channel, resumes snapshot-then-tail | T23 | 3.23 | Phase 3 verify WARNING 2 CLOSED |
| + `.live()`'s `retry()` is a no-op when healthy and after `unsubscribe()` | T23 | 3.24 | Phase 3 verify WARNING 2 CLOSED |
| + An auto-recovered transient error clears `retry()`'s gate | T22 | 3.25 | Phase 3 verify WARNING 2 CLOSED |

### react-live-bindings (6 scenarios)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| Return shape has no data field | **NEW** | 5b.1 | coverage hole — no T-row, closed |
| Re-render ×3 → no second subscription | T32 | 5b.2 | |
| SSR render does not throw | T29/T30 | 5b.3 | |
| StrictMode leaves one connection | T31 | 5b.4 | |
| Terminal error observable + retry() recovers | T36 | 5b.8 | |
| Unmounting sole consumer closes subscription | **NEW** | 5b.9 | coverage hole — no T-row, closed |

### realtime-origin-allowlist (9 scenarios, MODIFIED)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| No config → no wildcard header | T4 | 1.1 | |
| No config → any origin not granted | T4 | 1.1 | |
| + Originless request served even unconfigured | T1 | 1.2 | Conflict 3 RESOLVED |
| Listed origin granted, exact echo | T3 | 1.3 | |
| Non-listed origin rejected | T2 | 1.4 | |
| + Prefix/suffix confusion not granted | T2 | 1.4 | Conflict 3 RESOLVED — threat-matrix case |
| Both routes honor same allowlist | T5 | 1.5 | |
| + `OPTIONS` from allowed origin ⇒ 204, exact echo | T6 | 1.6 | Conflict 3 RESOLVED |
| + `OPTIONS` from rejected origin ⇒ 403, both paths | T6 | 1.6 | Conflict 3 RESOLVED |

### client-browser-usage-docs (4 scenarios)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| Names `@indigodb/client/realtime` | T41 | 4.1 | T41 decomposed |
| States wake-only, no row data | T41 | 4.2 | T41 decomposed |
| States the query non-goal | T41 | 4.3 | T41 decomposed |
| TanStack recipe wires onWake→invalidateQueries | **NEW** (T41 too coarse) | 4.4 | coverage hole — closed |

### realtime-live-endpoint (5 scenarios, MODIFIED)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| `@@allow` model: no row data | — | 1.13 | pre-existing, landed `9798f9c`; regression only |
| `pk` dropped from composite key | — | 1.13 | pre-existing; regression only |
| Create-only `@@allow` still wake-only | — | 1.13 | pre-existing; regression only |
| Non-`@@allow` model wake-only **regardless of CORS allowlist** | **NEW** | 1.10/1.11 | coverage hole — closed; only clause actually new to this change |
| `.live()` observes wake as refetch trigger | — | 2.8/2.9 | pre-existing; `test/live.mjs` unmodified is the proof |

### studio-live-view (2 scenarios, ADDED)
| Scenario | T-row | Task | Note |
|---|---|---|---|
| Join already-open channel → live immediately | **NEW** | 6.2 | coverage hole — T39/T40 were too generic, closed |
| Debounce/coalescing unchanged post-rebase | T39 | 6.1 | |

**Result: 0 unresolved scenarios, 5 coverage holes found and closed with new tasks (5b.1, 5b.9,
4.4, 1.10/1.11, 6.2), 3 spec/design tensions found and now RESOLVED in the specs below (0 new
tasks needed — all 7 added scenarios map to tasks that already existed), and 13 T-rows
kept as design-mandated scaffolding with no spec scenario** (T1, T6, T7, T12, T13, T14, T15/T16,
T19, T20, T21–23, T27, T28, T37/T38 — all real, load-bearing behavior; none invented, none dropped).

## Conflicts found

All three were found by `sdd-tasks` and are now **RESOLVED in the specs**, not deferred. `sdd-tasks`
had recommended a follow-up patch; the owner closed them immediately instead, because deferring the
same class of spec silence has already recurred across two consecutive phases in this repo (see the
standing-obligation block in `openspec/changes/studio-erd-designer/tasks.md`). No task was added,
renumbered, or removed: every scenario written maps to a task that already existed.

1. **Status vocabulary — spec (3 states) vs design (5 states). RESOLVED.** Spec's status
   Requirement named `connecting → live → error`; its scenario read status "immediately" after
   construction as `"connecting"`. Design's interface is `idle|connecting|live|error|closed`, and
   D4 requires the primitive be inert (`"idle"`, zero connects) until `subscribe()`. *How closed:*
   `specs/realtime-live-subscription/spec.md`'s status Requirement now states all five states and
   the inert-until-`subscribe()` rule; the "immediately" scenario now reads "immediately after the
   first `subscribe()`" (the only point a caller can observe `"connecting"` under a lazy start), and
   a new inert-`"idle"`/zero-connections scenario was added against the existing task 3.1.
2. **`realtime-live-subscription` spec had no terminal/transient Requirement at all. RESOLVED.**
   D6 requires the classification and `react-live-bindings`'s spec already assumed a terminal error
   exists, so the "404 retries forever" defect the proposal names was unspecified at the layer that
   owns it. *How closed:* a new Requirement in the same spec states D6's rule verbatim in contract
   form — terminal = any non-2xx that is not 5xx/408/429 and the retry loop stops; a `fetch`
   `TypeError` stays transient because CORS rejection and offline are indistinguishable in a
   browser; `retry()` is channel-level and a no-op unless status is `"error"` — with two scenarios
   mapped to the existing tasks 3.13 and 3.14. No behavior beyond D6 was invented.
3. **`realtime-origin-allowlist` spec was silent on the no-`Origin`-header and `OPTIONS` cases.
   RESOLVED.** Both are load-bearing for the CLI daemon, curl, and Studio's same-origin browser —
   the feature's single most important compatibility guarantee was unwritten. *How closed:*
   `specs/realtime-origin-allowlist/spec.md` gains a Requirement that an originless request is
   always allowed (mapped to existing task 1.2), a Requirement that `OPTIONS` preflight returns
   `204` when allowed and `403` otherwise on both paths (task 1.6), and the threat matrix's
   prefix/suffix-confusion negative case as a scenario under the exact-match Requirement (task 1.4).

## Confirmations (known reconciliation items)

- `realtime-live-endpoint`'s "regardless of the configured CORS origin allowlist" wording is
  accurate against D7: the allowlist gates connection admission; dispatch payload scoping
  (`{table,op,lsn,seq}`, no `pk`/`new`/`old`) is a separate, unconditional path untouched by D7.
  Tasks 1.10/1.11 add the missing test tying the two together (zero T-row covered this pairing).
- `client-browser-usage-docs`'s content-assertion scenarios ARE legitimate automated tests —
  written as plain-Node scripts (`packages/client/test/readme-contract.mjs`, tasks 4.1–4.4),
  matching every other package's plain-Node suite convention. T41 alone under-covered scenario 4;
  decomposed.
- `studio-live-view` correctly has no MODIFIED block: task 6.1's RED test proves the *existing*
  suite's assertions still bite unchanged post-rebase — the additive/behavior-preserving claim is
  proven, not assumed for free.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2,097 (design) + ~30 (hole-closing tasks) ≈ **2,130** |
| 400-line budget risk | High (vs. the 400-line default; every slice fits this session's 800-line budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 → PR 5a → PR 5b → PR 6 (5a/5b only if slice 5 scaffolding overruns) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High
```

Calibration: single-subsystem slices ran 42–48 code lines/task; package-boundary-crossing slices
ran 63–73; strict TDD roughly doubles implementation. **Slice 5 is the named budget risk (~620
lines)** — pre-authorized contingency split into 5a (package skeleton + build/pack/browser-safety
guards, ~150) and 5b (the hook, ~470). Use 5a/5b only if scaffolding overruns during 5a.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Origin allowlist: engine + CLI/Studio wiring | 1 | `node packages/realtime/test/origin-allowlist.mjs` | Real `node:http` listener, no DB (per T1–T6) | `git revert`; restores wildcard CORS |
| 2 | Manager open-state fix + replay | 2 | `node packages/client/test/realtime-manager.mjs` | Fake transport, no network | `git revert`; restores swallowed `onOpen`, safe (only new code depends on fix) |
| 3 | `createLiveSubscription` + terminal classification | 3 | `node packages/client/test/live-subscription.mjs` | Fake transport + fake timers | `git revert`; purely additive, `live.ts` untouched |
| 4 | Docs: README browser section + TanStack recipe | 4 | `node packages/client/test/readme-contract.mjs` | N/A — prose/content assertions only | `git revert`; docs-only |
| 5a | `@indigodb/react` skeleton + guards | 5a | `pnpm --filter @indigodb/react test` | vitest + jsdom (new scaffolding) | `git revert`; new package, zero external consumers |
| 5b | `useLiveTable` hook | 5b | `pnpm --filter @indigodb/react test` | vitest + jsdom + `@testing-library/react`, StrictMode | `git revert`; new package, zero external consumers |
| 6 | Studio re-base | 6 | `pnpm --filter @indigodb/studio test` | vitest (existing Studio harness) | `git revert`; restores the 173-line bypass, retained in history |

## Phase 1 — Slice 1: Origin allowlist (engine + CLI/Studio wiring) [PR 1/6, M1]

- [x] 1.1 RED `packages/realtime/test/origin-allowlist.mjs`: unconfigured engine + any `Origin` ⇒ 403, no CORS header (T2/T4). Mutation: default `allowedOrigins ?? []` → `?? ["*"]`; 403 assertion must fail.
- [x] 1.2 RED same file: no `Origin` header ⇒ 200 + `text/event-stream` regardless of config (T1). Mutation: remove the no-origin early-allow branch; status assertion must fail.
- [x] 1.3 RED same file: configured `["https://app.example.com"]` + matching Origin ⇒ exact echo, `vary: origin`, never `*` (T3). Mutation: hardcode `"*"`; exact-string assertion must fail.
- [x] 1.4 RED same file: mismatched Origin ⇒ 403, no CORS header, incl. prefix/suffix negative case from the threat matrix (T2). Mutation: use `.startsWith()` instead of exact equality; suffix-attack case must fail.
- [x] 1.5 RED same file: `handleLogRequest` obeys the identical gate (T5). Mutation: skip the gate in `handleLogRequest` only; that route's assertion must fail while `handleRequest` still passes.
- [x] 1.6 RED same file: `OPTIONS` ⇒ 204 allowed / 403 rejected on both paths (T6). Mutation: return 200 instead of 204; status-code assertion must fail.
- [x] 1.7 GREEN `packages/realtime/src/engine.ts`: implement `allowedOrigins`, gate in `handleRequest`+`handleLogRequest`, `OPTIONS` handling, replace `"*"` at `:243`. Make 1.1–1.6 pass.
- [x] 1.8 RED CLI arg/env test: `--allow-origin` (repeatable) + `INDIGODB_REALTIME_ALLOWED_ORIGINS` merge into one array (T7). Mutation: overwrite instead of merge; array-contents assertion must fail.
- [x] 1.9 GREEN `packages/cli/src/index.ts`, `packages/cli/src/studio-server.ts`: wire flag/env to the engine. Make 1.8 pass.
- [x] 1.10 RED `packages/realtime/test/origin-allowlist.mjs`: dispatched wake frame (`{table,op,lsn,seq}`, no `pk`/`new`/`old`) is unchanged for an allowed-origin request — closes the `realtime-live-endpoint` MODIFIED-scenario gap. Mutation: leak `new`/`old` when origin is allowed; payload-shape assertion must fail.
- [x] 1.11 GREEN: confirm 1.10 passes with no `dispatch()` change — this is a regression proof, not new production code.
- [x] 1.12 Regression: run the existing realtime dispatch/wake-only suite (landed `9798f9c`) unmodified — `realtime-live-endpoint` scenarios 1–3/5 must stay green with zero new tasks. NOTE: `dispatch.mjs`'s fake `IncomingMessage` needed one added field (`headers: {}`) since `handleRequest` now reads `req.headers.origin` — no assertion touched; see apply-progress deviations.
- [x] 1.13 Verify: `pnpm --filter @indigodb/realtime build && pnpm --filter @indigodb/realtime test`; `pnpm --filter @indigodb/cli test`; `pnpm lint` clean.

## Phase 2 — Slice 2: RealtimeConnectionManager open-state fix (D1) [PR 2/6, M1] — parallel with Phase 1

- [x] 2.1 RED `packages/client/test/realtime-manager.mjs`: first `onOpen(false)` reaches all listeners (T8). Mutation: restore `if (!reconnected) return;`; listener call-count assertion must fail.
- [x] 2.2 RED same file: subscribing to an already-open channel replays `onOpen(false)` synchronously before `subscribe()` returns (T9). Mutation: skip replay on subscribe; timing/count assertion must fail.
- [x] 2.3 RED same file: replay never invokes `onResync` (T10). Mutation: fire `onResync` during replay; resync-count assertion must fail.
- [x] 2.4 RED same file: a genuine reconnect fires `onOpen(true)` and exactly one `onResync` per listener (T11). Mutation: fire `onResync` on every open, not just `reconnected===true`; count assertion must fail.
- [x] 2.5 RED same file: a listener joining an `"error"` channel is replayed the stored `Error` instance, same identity (T12). Mutation: construct a new `Error` on replay; identity assertion must fail.
- [x] 2.6 RED same file: refcount unchanged — one `connect` for N listeners, `close` only on the last unsubscribe (T13). Mutation: call `connect` per listener; count assertion must fail.
- [x] 2.7 GREEN `packages/client/src/realtime.ts`: add `TableChannel.state/everOpened/lastError`, `ChannelListener.onOpen`, subscribe-time replay. Make 2.1–2.6 pass.
- [x] 2.8 Regression: run `packages/client/test/live.mjs` **unmodified** — must stay green (T14). Verification-only, no code change.
- [x] 2.9 Verify: `pnpm --filter @indigodb/client build && pnpm --filter @indigodb/client test`; confirm `live.mjs` has a zero-line diff.

## Phase 3 — Slice 3: createLiveSubscription + terminal classification (D2/D3/D6) [PR 3/6, M1] — depends on Phase 2

- [x] 3.1 RED `packages/client/test/live-subscription.mjs`: constructing without subscribing ⇒ zero `connect` calls, `getStatus()` is `"idle"` (T15). See Conflict 1 — implements design's 5-state contract.
- [x] 3.2 RED same file: first `subscribe()` opens, last `unsubscribe` closes (T16). Mutation: open on construction; connect-count assertion must fail.
- [x] 3.3 RED same file: full sequence `idle→connecting→live`, `live⇄error` (T17). Mutation: skip the `"connecting"` interim state; sequence assertion must fail.
- [x] 3.4 RED same file: subscribed callback fires once per transition, not for a repeated identical status. Mutation: call listeners unconditionally on every transport event; call-count assertion must fail.
- [x] 3.5 RED same file: burst of 5 wakes in one window ⇒ exactly one `onWake`, timed to the first wake (T18). Mutation: re-arm the timer per wake; timing/count assertion must fail.
- [x] 3.6 RED same file: sustained wakes every `debounceMs/2` still deliver on schedule, never starved (T19). Mutation: same re-arm bug; delivery-timing assertion must fail.
- [x] 3.7 RED same file: wakes >`debounceMs` apart ⇒ two separate `onWake` calls. Mutation: coalesce across windows; call-count assertion must fail.
- [x] 3.8 RED same file: `debounceMs: 0` delivers every wake immediately (T20 — real interface behavior, not in the spec's Requirement text; kept as scaffolding). Mutation: floor to 1ms instead of the documented bypass; timing assertion must fail.
- [x] 3.9 RED same file: `retry()` from `"error"` re-opens (`connecting→live`); no-op while `"live"`/`"connecting"` (T23). Mutation: allow reopen while `"live"`; connect-count assertion must fail.
- [x] 3.10 RED same file: `close()` twice does not throw; a pending timer at close-time never fires `onWake`; `retry()` after `close()` is a no-op (T24). Mutation: clear the timer but still fire the pending `onWake`; call-count assertion must fail.
- [x] 3.11 RED same file: return shape is exactly `{getStatus,subscribe,retry,close}`, `onWake` arity 0, no `rows` field; `tsc --noEmit` fixture rejects a `rows` property (T25). Mutation: add `getRows()`; key-enumeration assertion must fail.
- [x] 3.12 GREEN `packages/client/src/realtime.ts`: implement `createLiveSubscription`, `createWakeDebouncer`. Make 3.1–3.11 pass.
- [x] 3.13 RED same file: a 404/401 response classifies `terminal:true` and stops the retry loop (T21 — **spec gap**, see Conflict 2). Mutation: classify 404 as transient; "no second attempt" assertion must fail.
- [x] 3.14 RED same file: 5xx / stream-end / `TypeError` classify `terminal:false`, keep retrying (T22). Mutation: classify 5xx as terminal; retry-occurred assertion must fail.
- [x] 3.15 GREEN `packages/client/src/realtime.ts`: `SseTransport` terminal/transient classification, `TransportHandlers.onTerminal`. Make 3.13–3.14 pass.
- [x] 3.16 RED `packages/client/test/realtime-entry.mjs` (extend): bare-Node import with no DOM globals doesn't throw, opens no connection (T26); `browserTransport()` throws a named error when `typeof window === "undefined"` (T27 — D5 scaffolding, no spec scenario); closure stays free of `pg`/`node:async_hooks` (T28, existing scan, unchanged). Mutation: reference `window.location` at module scope; import must throw.
- [x] 3.17 GREEN: export `browserTransport`, keep the entry side-effect-free. Make 3.16 pass.
- [x] 3.18 Verify: `pnpm --filter @indigodb/client build && pnpm --filter @indigodb/client test`; rerun `live.mjs` — still green, untouched by this slice.
- [x] 3.19 RED/GREEN: `getError()` on the returned primitive — `LiveSubscriptionError {message, terminal, cause}`,
      a referentially stable identity while unchanged, cleared on the next successful open and by `retry()`,
      with `terminal` reflecting D6. Closes the spec/design contradiction where the spec fixed the return
      shape at four keys while design.md:255 and D4's hook both require `getError()` (a `useSyncExternalStore`
      snapshot must be a pull, so the hook cannot read the error from `subscribe(cb)`'s push callback).
      Mutations: (a) rebuild the snapshot on every read — fails the referential-identity check only;
      (b) make `clearError()` a no-op — fails both the clear-on-open and clear-on-retry checks;
      (c) leave `onTerminal` setting `rawErrorTerminal = false` — fails the terminal-classification check.

- [x] 3.20 RED `packages/client/test/live-subscription.mjs`: every status D6 NAMES terminal (400/401/403/410, plus 404) classifies terminal exactly once and makes no further connect attempt, driven against the real `SseTransport` over a mocked `fetch` that dispatches on the URL path (one shared backoff wait for the whole matrix). Closes Phase 3 verify WARNING 1 — the classifier was runtime-proven at 404 only, the rest by code inspection. Mutation: classify `401` transient; the terminal-count assertion fails on `401` alone.
- [x] 3.21 RED same file: every status D6 NAMES transient (408/429/502, plus 500) never classifies terminal and makes a further connect attempt after its backoff. Mutations: (a) drop `status === 429` from `isTransientHttpStatus` — the `429` stay-transient assertion fails; (b) drop `status === 408` — the `408` assertion fails. Both are the exact off-by-one the WARNING named.
- [x] 3.22 RED `packages/client/test/live.mjs` (ADDITIVE — no existing assertion touched): a `.live()` query on a REAL `RealtimeConnectionManager` over a fake transport, driven to a terminal channel error, makes no further connect attempt and no further refetch on its own. Closes the untested half of Phase 3 verify WARNING 2. Mutation: none needed in isolation — this is the GIVEN state 3.23 recovers from; its own assertion is the connect/refetch counter.
- [x] 3.23 GREEN `packages/client/src/live.ts` + `packages/client/src/realtime-delegate.ts`: `LiveQuery` gains `retry()`, delegating to the SAME `RealtimeConnectionManager.reviveChannel(table)` path `createLiveSubscription.retry()` uses, wired in as a new `LiveDeps.revive` dep (a dep, not an import — `realtime.ts` already imports `LIVE_DEBOUNCE_MS` from `live.ts`, so a value import back would close design.md D2's cycle). The revived open forces exactly one immediate refetch, then normal debounced tailing. Mutations: (a) revived open skips the refetch — the "exactly one immediate refetch" assertion fails; (b) `retry()` stops calling `deps.revive()` — the stale-close assertion fails.
- [x] 3.24 RED same file: `retry()` on a healthy channel closes/opens nothing, and is a no-op after `unsubscribe()`. Mutation: drop `retry()`'s error gate (revive unconditionally); the healthy-channel no-op assertion fails.
- [x] 3.25 RED same file: an error the transport never classified terminal, followed by its own backoff reconnect, lowers the error latch so a later `retry()` is a no-op. Mutations: (a) drop the error gate — this check's no-op assertion fails; (b) stop latching the error in `onError` — 3.23's stale-close assertion fails.

## Phase 4 — Slice 4: Docs (README, TanStack recipe, non-goals) [PR 4/6, M1] — depends on Phase 3

- [x] 4.1 RED `packages/client/test/readme-contract.mjs` (new): literal string `@indigodb/client/realtime` in a browser-usage section. Mutation: keep the string but rename/move the heading out of that section; scoping assertion must fail.
- [x] 4.2 RED same file: browser section states wake-only/no-row-data explicitly. Mutation: omit the required phrase; string-match assertion must fail.
- [x] 4.3 RED same file: browser section states the query non-goal and "own backend". Mutation: omit the "own backend" clause; assertion must fail.
- [x] 4.4 RED same file: TanStack recipe calls `createLiveSubscription` with `onWake` invoking `queryClient.invalidateQueries` — closes the coverage hole where T41 alone couldn't prove this scenario. Mutation: recipe calls `refetch()` instead; code-sample assertion must fail.
- [x] 4.5 GREEN `packages/client/README.md`: write the browser section, wake-only contract, non-goals, worked TanStack recipe. Make 4.1–4.4 pass.
- [x] 4.6 Verify: `node packages/client/test/readme-contract.mjs`; `pnpm --filter @indigodb/client test`.

## Phase 5a — Slice 5a: `@indigodb/react` skeleton + guards (D8) [PR 5a/6, M2] — depends on Phase 3

- [ ] 5a.1 Create `packages/react/package.json` (`@indigodb/react@0.0.1`, ESM, `peerDependencies:{react:">=18.0.0"}`, `files:["dist"]`), `tsconfig.json`, `src/index.ts` stub.
- [ ] 5a.2 Scaffold vitest + jsdom + `@testing-library/react` devDependencies, `vitest.config.ts` — first such renderer setup outside `apps/studio`; own verification step, not folded into 5b.
- [ ] 5a.3 RED `packages/react/test/browser-safety.mjs`: reachable-specifier scan, `FORBIDDEN=["pg", /^node:/]`, over `packages/react`'s import graph (T37). Mutation: value-import root `@indigodb/realtime` instead of `/protocol`; scan must fail.
- [ ] 5a.4 GREEN: `src/index.ts` imports only `@indigodb/client/realtime`. Make 5a.3 pass.
- [ ] 5a.5 Verify: `scripts/check-pack-contents.mjs` against `packages/react` — packs only `dist`, ships `main` (T38). No script change.
- [ ] 5a.6 Verify: `pnpm --filter @indigodb/react build && pnpm --filter @indigodb/react lint && pnpm --filter @indigodb/react test` green with an empty/stub hook.

## Phase 5b — Slice 5b: `useLiveTable` hook (D4/D5) [PR 5b/6, M2] — depends on Phase 5a

- [ ] 5b.1 RED `packages/react/test/use-live-table.test.tsx`: return shape is exactly `{status,error,retry}` — closes coverage hole (react-live-bindings scenario 1, no T-row). Mutation: add a `rows` field; key-enumeration assertion must fail.
- [ ] 5b.2 RED same file: re-rendering 3× with unchanged props keeps exactly one active `createLiveSubscription` (T32). Mutation: recreate on every render; call-count assertion must fail.
- [ ] 5b.3 RED same file: `renderToString` with `window` deleted completes without throwing, opens no connection, reports `"idle"` (T29/T30). Mutation: read `window.location.origin` at hook top level; render must throw.
- [ ] 5b.4 RED same file: StrictMode mount→unmount→remount leaves exactly one open connection (T31). Mutation: skip cleanup on the discarded double-invoked instance; connect/close balance assertion must fail.
- [ ] 5b.5 RED same file: N=3 hook instances on one table ⇒ exactly one `connect` (T33). Mutation: don't share the manager's channel per instance; connect-count assertion must fail.
- [ ] 5b.6 RED same file: a second instance mounting after the first is `"live"` reports `"live"` immediately, 0 extra connects (T34). Mutation: ignore the Phase 2 replay path; status assertion must fail.
- [ ] 5b.7 RED same file: `enabled:false` / `table:null` ⇒ `"idle"`, 0 connects (T35). Mutation: still construct the subscription when disabled; connect-count assertion must fail.
- [ ] 5b.8 RED same file: terminal error surfaces via `error`+`status:"error"`; `retry()` invokes the primitive's `retry()` and recovers to `"live"` (T36). Mutation: swallow the error; non-null `error` assertion must fail.
- [ ] 5b.9 RED same file: unmounting the sole consumer closes the underlying SSE connection — closes coverage hole (react-live-bindings scenario 6, no T-row). Mutation: skip calling the returned unsubscribe on unmount; close-call assertion must fail.
- [ ] 5b.10 GREEN `packages/react/src/use-live-table.ts`: implement `useLiveTable` per D4 (`useMemo` + latest-ref `onWake` + two `useSyncExternalStore` calls + `getServerSnapshot`). Make 5b.1–5b.9 pass.
- [ ] 5b.11 Verify: `pnpm --filter @indigodb/react build && pnpm --filter @indigodb/react test`; `pnpm build && pnpm lint` at the root to confirm no cross-package type drift.

## Phase 6 — Slice 6: Studio `useLiveTable` re-base [PR 6/6, M2] — depends on Phase 5b

- [ ] 6.1 RED existing Studio hook suite, re-pointed: debounce/coalescing/transient-error/inert-`null` assertions still pass against the re-based hook (T39). Mutation: revert one call site to the old inline transport; an existing assertion must fail, proving the suite still bites post-rebase.
- [ ] 6.2 RED same suite: selecting a table another consumer already holds open reports `"live"` immediately, no reconnect wait — closes coverage hole (studio-live-view scenario 1, T39/T40 were too generic). Mutation: bypass the shared manager for this path; status assertion must fail.
- [ ] 6.3 RED same suite: exactly one connection opens for the Table Browser; the bypass rationale comment is gone from source (T40). Mutation: reintroduce a private transport; connect-count assertion fails and the bypass-comment grep assertion fails.
- [ ] 6.4 GREEN `apps/studio/.../hooks/useLiveTable.ts`: re-base onto `@indigodb/react`'s `useLiveTable`; delete the bypass comment and the private-transport code path. Make 6.1–6.3 pass.
- [ ] 6.5 Verify: `pnpm --filter @indigodb/studio test` (vitest) and `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`, `-b` load-bearing) both green.

## Standing obligation (carried forward)

Any future IndigoDB capability crossing the Node/browser boundary must:
1. State explicitly, in both spec and README, what data class it does NOT expose (mirroring
   "status only, never rows") — silence invites scope creep (this proposal's own risk table).
2. Extend the existing reachable-specifier scan (`FORBIDDEN=["pg", /^node:/]`) rather than
   hand-rolling a new one — this is the second occurrence (`realtime-entry.mjs`, then
   `packages/react/test/browser-safety.mjs`); a third occurrence should extract a shared helper.
3. Scaffold its own `vitest.config.ts` + devDependencies if it needs a real DOM renderer, as
   `packages/react` does here — never assume `apps/studio`'s Vitest setup is reachable or shared.
4. Prove `packages/client/test/live.mjs` passes **unmodified** for any `RealtimeConnectionManager`
   or `SseTransport` change — that file is the load-bearing regression fence for `.live()`.
