# Proposal: Frontend realtime SDK

## Intent

IndigoDB has a browser-safe realtime client and nobody can find it. `packages/client/package.json:14-17`
already declares the `./realtime` export subpath; its closure (`realtime.ts` + `live.ts` +
`@indigodb/realtime/protocol`) imports nothing Node-only. But `packages/client/README.md` contains
**zero** occurrences of the word "browser" and says "Usable in NestJS, Express, or plain Node";
`packages/generator/src/client.ts:280` emits only the bare `"@indigodb/client"` specifier and
`generateClient()` has no target/environment concept at all. A frontend developer reaching for the
root entry hits three Node-only value imports — `pg` (`adapters/pg.ts:13`) and `node:async_hooks`
(`client.ts:10`, `context.ts:17`, reached through `delegate.ts:38`, so `ModelDelegate` alone drags
Node in) — and concludes IndigoDB has no frontend story.

The only working prior art is `apps/studio/.../hooks/useLiveTable.ts` (173 lines), which is
dev-tool quality: no auth, no terminal error state or manual retry (a failed fetch is silently
swallowed, keeping stale rows), no SSR guard (`window.location.origin` touched unguarded), no
connection sharing across instances, StrictMode double-open, and a fetcher hardcoded to a
Studio-only endpoint. It deliberately bypasses `RealtimeConnectionManager` because that manager's
refcounting swallows the first `onOpen` — the `connecting → live` edge the hook needs.

This change ships the documented browser story, a framework-agnostic subscription primitive, a
thin React binding, and the honest deployment guidance the SSE route now requires.

**Strategy is fixed** (Judgment Day dual blind review, owner-accepted, Engram #915): the ORM stays
server-side, realtime is a **notification** channel, data flows through the app's own
authenticated backend. This proposal implements strategy A and does not reopen it.

## What this does NOT give you

Stated plainly, because the gap is the first thing a new user hits. **You cannot query IndigoDB
from the browser.** Someone arriving from Firebase or Supabase expecting
`db.users.findMany()` in a React component will not get that here, now or under this change. As of
`9798f9c` the SSE route is **wake-only for every table**: no row data ever crosses it, and
`.subscribe()`'s `onInsert`/`onUpdate`/`onDelete` are dormant for every realtime model. A browser
receives *"table X changed"* and nothing more. Every row must be refetched through the
application's own authenticated API, which the application writes. What IndigoDB supplies is the
invalidation signal, not the data path.

## Scope

### In Scope
- `createLiveSubscription()` — framework-agnostic, browser-safe wake subscription exported from
  `@indigodb/client/realtime`. Returns status; never fetches, never holds rows.
- `RealtimeConnectionManager` open-state fix: `ChannelListener` gains `onOpen(reconnected)`, and a
  listener joining an already-open channel is replayed the current channel state.
- `@indigodb/react` — one new package, one hook (`useLiveTable`), built on `useSyncExternalStore`.
- Configurable SSE origin allowlist on `RealtimeEngine` (replacing the unconditional
  `access-control-allow-origin: "*"` at `packages/realtime/src/engine.ts:243`).
- Documentation: `packages/client/README.md` browser section, a worked TanStack Query recipe, and
  the non-goals above stated in the docs, not only here.
- Generator target awareness: `generateClient()` learns an environment concept and the emitted
  header points browser consumers at `@indigodb/client/realtime`.
- Studio's `useLiveTable` re-based onto the shipped primitive (first real consumer; deletes the
  bypass).

### Out of Scope — non-goals, named deliberately
- **A general-purpose HTTP data/query API.** Not now, not as a follow-up implied by this change.
- **End-user authentication or a handle-minting HTTP route.** The codebase refuses this by explicit
  design (`packages/client/src/client.ts:29-30`).
- **Making the generated ORM client run in a browser.** The root entry stays Node-only; that is
  correct, not a packaging bug.
- **Promoting Studio dev-server routes** (`/api/query`, `/api/tables/:name`, `/api/rows/*`) to
  production use. Both judges named this the single most likely way the project goes wrong: no
  per-user identity, no `app.user_id` binding, no RLS scoping, and `/api/query` accepts raw SQL.
- Bindings for Vue, Svelte, Solid, or Angular. Deferred until a user asks (see Decision 2).
- Suspense integration, and any SDK-owned cache, fetcher, or store.

## Capabilities

### New Capabilities
- `realtime-live-subscription`: framework-agnostic `createLiveSubscription()` in
  `@indigodb/client/realtime` — status machine, wake debounce/coalesce, injected invalidation
  callback, explicit `retry()`, SSR-inert until started.
- `react-live-bindings`: `@indigodb/react`'s `useLiveTable` hook — `useSyncExternalStore` over the
  primitive, StrictMode-safe, no data ownership.
- `realtime-origin-allowlist`: `RealtimeEngine` CORS origin allowlist, defaulting closed for
  configured deployments.
- `client-browser-usage-docs`: the `@indigodb/client` README states the browser entry, the
  wake-only contract, and the non-goals above.

### Modified Capabilities
- `client-live-queries`: `ChannelListener` gains `onOpen(reconnected)`; a late listener on an open
  channel is replayed its state instead of waiting for the next reconnect.
- `realtime-live-endpoint`: the SSE route's CORS response headers become configuration-driven.
- `studio-live-view`: Studio's hook is re-based onto the shipped primitive; observable behavior
  (debounce window, transient-error semantics, inert `null` status) is preserved.

## Decisions this proposal settles

**1 — Slicing: one change record, two milestones, seven stacked PRs.** Splitting into two SDD
changes would duplicate the strategy context and let the docs milestone ship without a consumer
proving the API. M1 (slices 1–4) is releasable on its own: hardened SSE, fixed manager, agnostic
primitive, docs. M2 (slices 5–7) adds the React package, generator awareness, and the Studio
re-base. **Gate M2 on M1 landing**, and treat the Studio re-base as the acceptance test for the
React binding rather than a cleanup afterthought.

**2 — Package identity: exactly one new package, `@indigodb/react`.** The framework-agnostic core
goes into the **existing** `@indigodb/client/realtime` entry, not a new `@indigodb/live-core`. That
entry is already declared, already browser-clean, already where a frontend reader is being sent by
the new docs; a third package would be surface area with no subscriber. `@indigodb/react` exists
only because `useSyncExternalStore` wiring done wrong (subscribe identity, snapshot stability) is
the exact class of bug a solo maintainer should write once. It must stay small — one hook, no
fetcher, no cache, no provider. Other frameworks get an adapter when someone asks; the agnostic
primitive means that adapter is ~40 lines, so deferring costs nothing.

**3 — The primitive is a subscription, not a hook; the hook is the adapter.** Under strategy A the
SDK cannot fetch, so a hook that returns rows would be lying about who owns the data. The contract:

```ts
createLiveSubscription({ table, transport, onWake, debounceMs })
  → { getStatus(), subscribe(cb), retry(), close() }
```

It returns **status only, never rows**. `onWake` is the app's invalidation callback —
`queryClient.invalidateQueries({ queryKey })` for TanStack Query, `mutate(key)` for SWR. That is
how it composes instead of competing: IndigoDB owns the signal, the app's existing cache owns the
data, and there is no second source of truth to reconcile. React's `useLiveTable(table, { onWake })`
returns `{ status, error, retry }` via `useSyncExternalStore`. Debounce keeps `useLiveTable.ts`'s
first-wake-armed fixed window (deliberate anti-starvation) and in-flight coalescing, both now
configurable.

Because the SDK never fetches, four of the prior art's gaps evaporate rather than needing fixes:
stale-rows-on-failed-fetch, abort-on-unmount, Suspense, and the hardcoded Studio endpoint are all
the app's concern, correctly.

**4 — Connection sharing: fix the manager and use it.** Keeping per-instance transports means N
hook instances on one table open N SSE connections — exactly the problem the manager exists to
solve, and worse in a real app than in Studio's single-table browser. The swallowed first `onOpen`
is a genuine defect, not a design choice: `subscribe()` returns early on `!reconnected`
(`realtime.ts:198-201`), and separately, a listener joining an already-open channel never learns it
is live at all. Both are fixed by storing channel state and replaying it on subscribe.
**Tradeoff:** this touches a class `.live()` already depends on. Mitigated by making the change
purely additive — a new optional `onOpen` handler plus stored state; `onResync` semantics are
untouched — and by landing it as its own slice, green, before anything is built on it.

**5 — v1 vs deferred, stated rather than left silent.**

| Concern | v1 | Rationale |
|---|---|---|
| SSR safety | **In** | Never touch `window` at module or render time; subscription is inert until started client-side. A crash on `next build` makes the SDK unusable, not degraded. |
| StrictMode double-invoke | **In** | The refcounted manager makes double subscribe/unsubscribe correct and cheap. This is the fix, not extra work. |
| Terminal error + manual `retry()` | **In** | The prior art's silent-swallow is its worst behavior; transient auto-recovery stays, but a caller can observe and act. |
| Abort-on-unmount | **N/A** | The SDK never issues a fetch. |
| Suspense | **Deferred** | Status is not a promise. Suspense belongs to the app's data library, which already has it. |
| Non-React bindings | **Deferred** | See Decision 2. |

**6 — SSE authentication: honest position.** The route is unauthenticated with wildcard CORS.
Post-`9798f9c` it leaks only table names and change cadence — tolerable for the CLI daemon behind
an operator's own proxy. **The SDK's existence raises the bar**: publishing a browser SDK is an
invitation for arbitrary origins to connect, and shipping docs that say "point your browser here"
at a wildcard-CORS route is indefensible. So v1 adds a configurable origin allowlist and documents
proxying the route through the app's own backend as the recommended deployment. It does **not** add
end-user auth to the SSE route — that is the handle-minting non-goal.

## Delivery slicing (auto-chain, stacked-to-main, 800-line budget)

| # | Slice | Milestone | Depends on | Independently valuable |
|---|---|---|---|---|
| 1 | `realtime-origin-allowlist` — engine CORS config | M1 | — | Yes: hardens the daemon today |
| 2 | `RealtimeConnectionManager` open-state fix | M1 | — | Yes: fixes a live defect in `.live()` |
| 3 | `createLiveSubscription()` in `@indigodb/client/realtime` | M1 | 2 | Yes: usable from any framework |
| 4 | Docs — README browser section, TanStack recipe, non-goals | M1 | 3 | Yes: the discoverability fix |
| 5 | `@indigodb/react` package + `useLiveTable` | M2 | 3 | Yes |
| 6 | Generator target awareness + emitted browser pointer | M2 | 3 | Yes |
| 7 | Studio `useLiveTable` re-based onto the SDK | M2 | 5 | Yes: deletes 173 lines of bypass |

Slices 1 and 2 are parallel. Slice 3 gates 4, 5, 6.

## Review Workload Forecast

Calibrated against landed actuals: single-subsystem slices run **42–48 code lines/task**;
package-boundary-crossing slices ran **63–73**. Strict TDD roughly doubles implementation.

| # | Tasks | Scope | Code | Tests | Total | Risk |
|---|---|---|---|---|---|---|
| 1 | 2 | crosses (`realtime` + CLI/Studio callers) @ 68 | ~136 | ~136 | **~272** | Low |
| 2 | 3 | confined (`packages/client`) @ 45 | ~135 | ~135 | **~270** | Low |
| 3 | 4 | confined (`packages/client`) @ 45 | ~180 | ~200 | **~380** | Medium |
| 4 | 2 | docs, prose-dominant | ~250 | 0 | **~250** | Low |
| 5 | 4 | crosses (new package) @ 68 + ~60 scaffolding | ~332 | ~290 | **~620** | Medium |
| 6 | 3 | crosses (`generator` + `client`) @ 68 | ~204 | ~204 | **~408** | Medium |
| 7 | 3 | confined (`apps/studio`) @ 45, net deletion | ~135 | ~120 | **~255** | Low |

Total ≈ **2,455 lines** across 7 stacked PRs; largest slice ~620.

```
Decision needed before apply: No
Chained PRs recommended: Yes
400-line budget risk: High
```
(High against the 400-line default; every slice is under this session's cached **800**-line budget.
Slice 5 is the one to watch — if package scaffolding runs over, split the hook from the package
setup.)

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/realtime/src/engine.ts` | Modified | CORS origin allowlist replacing hardcoded `*` (`:243`) |
| `packages/client/src/realtime.ts` | Modified | `ChannelListener.onOpen`, channel state replay, `createLiveSubscription()` |
| `packages/client/package.json` | Modified | `./realtime` subpath already declared; test script additions only |
| `packages/client/README.md` | Modified | Browser section, wake-only contract, non-goals, TanStack recipe |
| `packages/react/**` | New | `@indigodb/react` — one hook over `useSyncExternalStore` |
| `packages/generator/src/client.ts` | Modified | Target/environment concept; browser pointer in emitted header (`:266`, `:280`) |
| `apps/studio/.../hooks/useLiveTable.ts` | Modified | Re-based onto the primitive; bypass removed |

## Repo constraints this change must respect

- ESM-only pnpm + Turborepo; a cross-package type change needs the dependency rebuilt first.
- Test suites import compiled `dist/`, not `src/` — mutation evidence MUST rebuild
  (`pnpm --filter <pkg> build`) or a mutation silently appears not to bite.
- `pnpm clean && pnpm build` does **not** purge stale `dist/`; use `--force`.
- **Strict TDD on.** Every requirement needs a test proven to fail by an actual mutation, sitting
  **on** the boundary it defends.
- Studio lint is `tsc -b --noEmit`; the `-b` is load-bearing.
- No CI. `.githooks/pre-push` runs build/lint/test; `pnpm ci:local` for a clean-clone check.
- A new package needs `package-tarball-allowlists` treatment (`files: ["dist"]`, pack-contents
  guard) to match the existing packages.
- `@indigodb/client/realtime` must stay value-import-clean: `@indigodb/realtime/protocol` only,
  never the root `@indigodb/realtime` entry.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Manager fix regresses `.live()`, which already depends on it | Med | Purely additive handler + state replay; own slice, landed green, `test/live.mjs` unchanged |
| A browser-safety regression sneaks a Node import into `./realtime` | Med | Extend `test/realtime-entry.mjs`'s closure assertion to `@indigodb/react`'s dependency graph |
| `@indigodb/react` grows a fetcher/cache under user pressure | Med | Non-goal recorded in the package README and spec; the primitive returns no rows by type |
| Users read the docs and still expect browser queries | High | "What this does NOT give you" ships in the README, not only in this proposal |
| Origin allowlist breaks existing daemon/Studio users | Med | Default preserves current behavior for loopback/Studio; opt-in tightening, documented |
| Generator target concept over-designed for one flag | Med | Slice 6 is last and independently revertible; ship the narrowest env discriminator |
| SDK invites public SSE exposure the route is not built for | Med | Deployment guidance recommends proxying through the app's backend; no end-user auth added |

## Rollback Plan

Each slice is a separate stacked PR; rollback is `git revert` of that merge commit, newest first.
Slices 3–7 are purely additive to published surface, so reverting them leaves `.live()` and the
Studio browser working exactly as today. Slice 7 reverts to the existing 173-line hook, which is
retained in history and independent of the SDK. Slice 2's revert restores the swallowed-`onOpen`
behavior — safe, since only new code depends on the fix. Slice 1's revert restores wildcard CORS.
Reverting the whole change leaves `packages/client/package.json:14-17`'s `./realtime` subpath
intact, because it already exists on `main`.

## Dependencies

- `realtime-live-endpoint`'s fail-closed wake-only fix — **done**, landed at `9798f9c`. The
  wake-only contract is the premise of the whole subscription design.
- Engram #915 (strategy A, accepted) and #912 (SSE row leak, fixed).

## Success Criteria

- [ ] A frontend developer reading `packages/client/README.md` learns, without reading source, that
      the browser entry is `@indigodb/client/realtime`, that it delivers wake notifications only,
      and that queries must go through their own backend.
- [ ] `createLiveSubscription()` works unchanged in React, in a plain-DOM page, and imported under
      Node SSR without touching `window` — proven by test.
- [ ] N hook instances on the same table open exactly **one** SSE connection, and an instance
      mounting onto an already-open channel reports `live` without waiting for a reconnect.
- [ ] A React app wires the SDK to TanStack Query in ≤10 lines and refetches on wake, with the SDK
      holding no rows.
- [ ] Under StrictMode, mount/unmount/remount leaves zero leaked connections and zero duplicate
      refetches.
- [ ] A failed connection surfaces an observable error state and a working `retry()`; it is never
      silently swallowed.
- [ ] Studio's live table browser runs on the shipped primitive with no behavior change, and the
      `RealtimeConnectionManager` bypass comment is deleted because it is no longer true.
- [ ] Every slice is independently green (`pnpm build && pnpm lint && pnpm test`) and under 800
      review lines.
- [ ] Every requirement's test has a recorded mutation that made it fail, run against rebuilt
      `dist/`.

## Proposal question round — RESOLVED

Answered by the owner and the orchestrator on 2026-09-04. These decisions are binding on
`sdd-spec`, `sdd-design` and `sdd-tasks`; the assumptions they replace are superseded.

1. **Milestone gating — M2 proceeds automatically after M1.** The Studio re-base stands as the
   binding's acceptance test rather than as follow-up cleanup, so the binding is never published
   without a real in-repo consumer exercising it.

2. **CORS default — CLOSED, not preserve-then-document.** The proposal's assumption was made to
   avoid breaking current cross-origin daemon users. There are none: every package is `0.0.1` and
   nothing has ever been published. Preserving a permissive default for a hypothetical consumer,
   while publishing a browser SDK that points at a wildcard-CORS route, trades a real future
   guarantee for no present benefit. The allowlist defaults closed; opening it is an explicit
   operator action.

3. **`@indigodb/react` ships as a published package, not a copy-paste recipe.** Correct
   `useSyncExternalStore` usage under SSR and StrictMode is precisely the subtle part a consumer
   would get wrong on their own, and shipping the hard part pre-solved is the SDK's reason to
   exist. The maintenance commitment is accepted deliberately.

4. **Generator target awareness (slice 6) is DROPPED.** Under strategy A the generated client is
   server code by design — emitting the Node-only root entry is correct, not a defect to paper
   over. A clarifying comment in the emitted header is sufficient; an environment discriminator on
   `generateClient()` is not warranted. This removes ~408 forecast lines and one slice, leaving
   six slices totalling roughly 2,047 lines. Re-number the remaining slices in `sdd-tasks`.
