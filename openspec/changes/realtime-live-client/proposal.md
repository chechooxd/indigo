# Proposal: `findMany().live()` typed client for `@@allow` models

Change: `realtime-live-client` (Road to 1.0, Phase 4). Slice 5 — final piece of the realtime epic. Exploration: Engram #743; decisions: Engram `sdd/realtime-live-client/decisions`.

## Intent

Slice 4 shipped the full server side: SSE now emits `event: wake` (`{table, op, lsn?, seq}`, no row data) for any model carrying `@@allow`, and the real data path is `GET ?handle&offset` (`RealtimeEngine.handleLogRequest`), which re-checks RLS per request via `set_config('app.user_id', ...)`.

The client never learned any of it. `packages/client/src/realtime.ts`'s `handleFrame` only reacts to `event: change` and silently drops `wake`. `RealtimeModelDelegate.subscribe()` (`realtime-delegate.ts`) dereferences `event.pk` unconditionally, so it is structurally unusable for `@@allow` models. Net effect: RLS-protected realtime is fully implemented server-side and **completely unreachable from the generated client** — the epic's headline feature has no consumer surface.

This slice closes that: a `.live()` query that stays current by itself, with the app supplying identity exactly once.

## Scope

### In Scope

- **`client.model.findMany(args).live(handlers?)`** on `RealtimeModelDelegate` — returns a live-query object exposing the current materialized `Row[]`, a change listener, a `status` (`connecting | live | error`), and teardown (`Unsubscribe`).
- **Generated only for `@@realtime` models that also carry `@@allow`** (`packages/generator/src/client.ts`, alongside the existing `table.realtime` branch at lines 249/374/408) — the exactly-blocked case.
- **Initial snapshot via a normal `findMany(args)`** through the existing RLS-scoped executor. The shape log has no retention guarantee back to table creation, so it cannot be the snapshot source; it is a change *detector*, never a source of record.
- **Debounced full refetch on `event: wake`**: `realtime.ts` learns the `wake` frame, `live` coalesces a burst into one re-run of the same `findMany(args)` using a **fixed 50ms trailing window** (an internal constant, not a caller option in v1). `RealtimeConnectionManager`'s existing per-table refcounted subscription is reused as-is.
- **`.live()` takes the `findMany(args)` shape verbatim** — `include` / `select` / `orderBy` / `take` and anything else `findMany` supports, unchanged. `.live()` re-runs that exact query; no argument subsetting, no additional type surface.
- **`realtime: { getHandle: (table) => Promise<string> }` on `IndigoClientOptions`** (`packages/client/src/client.ts:16`, `RealtimeOptions`). The app mints server-side with `mintHandle` from `@indigodb/realtime` after its own auth and returns the token string. Same division `$auth` already draws: IndigoDB consumes a claim, never authenticates.
- **Per-table handle cache** inside the client: a handle is minted once per table and reused by every `.live()` on that table until its `exp` passes or a request verifiably fails with it, at which point it is re-minted through `getHandle`. Never one `getHandle` call per `.live()`.
- **Handle failure/expiry policy**: retry `getHandle` once; if the retry also fails, report through an optional `onError` handler and move to `status: "error"`. Never throw into the app's event loop, never fail silently.
- `.subscribe()` stays generated and unchanged; `.live()` is purely additive.

### Out of Scope — deferred

- **`.live()` for `@@realtime` models without `@@allow`.** They still receive full `event: change` frames and could apply pushed rows with no refetch at all — a genuinely different internal strategy. Separate slice.
- **Incremental / log-driven reconciliation.** No client-side `where`/`orderBy` evaluation lands here; handles are table-scoped only (slice 4's v1 limitation), so the log cannot answer arbitrary predicates anyway.
- **`.subscribe()`'s wake-frame bug for `@@allow` models** — a *pre-existing* defect from slice 4, recorded as a known issue, deliberately not fixed here.
- **Any new server-side handle-minting HTTP route.** It would reintroduce the identity question `$auth` already answers. No `packages/realtime`, `crates/`, or WASM change in this slice.
- Log pruning/retention (still the standing operational follow-up) and Studio surfacing.

## Capabilities

### New Capabilities

- `client-live-queries`: the `.live()` contract — return shape and `status` lifecycle, snapshot-then-tail bootstrap, wake-triggered debounced refetch (fixed 50ms trailing window) and burst coalescing, verbatim `findMany(args)` pass-through, handle-provider contract with per-table caching until `exp`/verified failure and one-retry-then-`onError` semantics, teardown/refcount behavior, and the `@@allow`-only generation rule.

### Modified Capabilities

- `realtime-live-endpoint`: gains its first client consumer — the wake frame becomes a client-observable trigger contract, and handle provisioning is pinned to an app-supplied `getHandle` callback rather than an IndigoDB-owned route.

## Approach

Single PR, no server or WASM change; `packages/client` + `packages/generator` only.

**Wake handling** lands in `packages/client/src/realtime.ts`: `handleFrame` stops ignoring non-`change` event names and fans `wake` frames to table listeners as a distinct signal. `RealtimeConnectionManager`'s refcounted one-connection-per-table model is unchanged, so N `.live()` calls on one table share one SSE connection.

**The live query** lands next to `RealtimeModelDelegate` (`packages/client/src/realtime-delegate.ts`, with the debounce/lifecycle loop factored into its own module). Flow: resolve the table's handle from the client-held per-table cache (calling `getHandle(table)` only on a miss, past `exp`, or after a verified failure) → bootstrap with `findMany(args)` → subscribe to the table's wake stream → on each wake, arm the fixed 50ms trailing timer; when it fires, re-run the same `findMany(args)` and publish the new array. Refetches never overlap: a wake during an in-flight refetch marks the result dirty and schedules exactly one follow-up.

**Handle plumbing** goes through `IndigoClientOptions.realtime` in `packages/client/src/client.ts`, next to the existing `url` / `INDIGO_REALTIME_URL` resolution, and is handed to the delegates the same way `$realtime` already is (`packages/generator/src/client.ts:398/413`).

**Generation** gates `.live()` on `table.realtime && table.allow?.length` so the method exists only where the wake-path is the actual contract — the type system, not documentation, tells the caller which bucket their model is in.

Tests follow the established split: emission assertions in `packages/generator/test/`, runtime behavior in `packages/client/test/` with a fake transport (the `SseTransport` seam already supports injection).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/client/src/realtime.ts` | Modified | `handleFrame` learns `event: wake`; wake fan-out to table listeners |
| `packages/client/src/realtime-delegate.ts` | Modified | `.live()` on `RealtimeModelDelegate`; `.subscribe()` untouched |
| `packages/client/src/live.ts` | New | live-query object, debounce/coalesce loop, status lifecycle, `onError` |
| `packages/client/src/client.ts` | Modified | `RealtimeOptions.getHandle` + per-table handle cache + provider plumbing to delegates |
| `packages/client/src/index.ts` | Modified | export the new live-query and handler types |
| `packages/generator/src/client.ts` | Modified | emit `.live()` only for `@@realtime` + `@@allow` tables |
| `packages/realtime/`, `crates/`, `packages/compiler/wasm/` | Unchanged | no server or compiler change |
| `packages/client/test/`, `packages/generator/test/` | New | runtime + emission coverage |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Refetch storm under write bursts | High | Fixed 50ms trailing debounce, single in-flight refetch, dirty-flag follow-up; the constant is a one-line change if evidence demands it |
| Handle expires mid-session, stream goes quietly stale | Med | One re-mint retry, then `status: "error"` + `onError`; never a silent no-op |
| App forgets `getHandle` → `.live()` unusable at runtime | Med | Fail fast with a named error naming the exact option, mirroring today's `INDIGO_REALTIME_URL` message |
| Full refetch is heavier than a delta apply | Med | Accepted for slice 1; incremental reconciliation is the documented follow-up |
| Two realtime APIs (`.live()` / `.subscribe()`) confuse callers | Med | `.live()` generated only where `.subscribe()` is already broken; documented, nothing deprecated yet |
| `.subscribe()` stays broken for `@@allow` models | Known | Pre-existing slice-4 defect, explicitly out of scope, recorded as a known issue |
| Leaked SSE subscription on unmount | Med | Teardown decrements the existing refcount; covered by a test |
| 400-line budget | Med | ~200–350 lines forecast; single PR, `sdd-tasks` re-forecasts against the guard |

## Rollback Plan

1. Revert the `.live()` emission branch in `packages/generator/src/client.ts` — generated clients return to today's output byte-for-byte.
2. Delete `packages/client/src/live.ts` and the `.live()` method on `RealtimeModelDelegate`; `.subscribe()` never moved.
3. Revert `handleFrame`'s wake branch — `wake` returns to being silently ignored, exactly today's behavior.
4. Drop `RealtimeOptions.getHandle` — additive optional field, no consumer can depend on it. Code-only: no DDL, no migration, no server change, no WASM rebuild.

## Dependencies

- `main` @ `c019bc3` (slices 1–4 archived).
- `mintHandle` exported from `@indigodb/realtime` — already shipped, app-side usage only.
- No new npm dependency; no Rust toolchain needed.

## Success Criteria

- [ ] `findMany(args).live()` on an `@@allow` + `@@realtime` model yields the same rows a plain `findMany(args)` would, before any event arrives
- [ ] A committed write on that table produces exactly one refetch and one listener notification for the caller
- [ ] A burst of N writes inside the 50ms debounce window produces exactly one refetch, not N
- [ ] Two `.live()` calls on the same table trigger `getHandle` exactly once; a third after the handle's `exp` triggers exactly one re-mint
- [ ] `.live()` accepts the same `args` object `findMany` accepts (`include`/`select`/`orderBy`/`take`) and its refetch preserves them
- [ ] A wake arriving during an in-flight refetch produces exactly one additional refetch afterwards
- [ ] `getHandle` failing once then succeeding keeps the query live; failing twice moves `status` to `error` and invokes `onError`
- [ ] `onError` being absent never throws into the host app
- [ ] Teardown closes the SSE subscription; the last `.live()` on a table releases the shared connection
- [ ] `.live()` is emitted for `@@allow` + `@@realtime` models and absent for `@@realtime`-only models
- [ ] Generated output for non-`@@allow` `@@realtime` models and `.subscribe()`'s behavior are byte-identical to today
- [ ] `pnpm build`, `lint`, `test` green; no `crates/` or WASM change in the diff

## Open Questions

### Resolved (user, 2026-08-25)

1. **Handle provisioning** — approach A/C: an app-supplied `getHandle(table) => Promise<string>` callback on the client. The app already authenticates and mints server-side with `mintHandle`. **Rejected:** an IndigoDB-owned HTTP minting route, which would reopen the identity problem `$auth` already solves.
2. **Scope** — `@@allow`-protected models only. `@@realtime`-without-`@@allow` still gets full-payload `event: change` and could apply pushes directly with no refetch; that is separate work, explicitly deferred.
3. **Refetch strategy** — debounced full `findMany()` refetch on `event: wake`. Incremental log-driven reconciliation is genuinely harder given the endpoint's table-only handle scope (no arbitrary `where` evaluation) and is out of scope.
4. **Handle failure/expiry mid-session** — retry `getHandle` once; if that fails too, surface via optional `onError`. Never throw silently, never crash the host app when `onError` is absent.
5. **`.live()` vs `.subscribe()`** — they coexist. `.subscribe()` is unchanged for existing consumers; its brokenness for `@@allow` models under wake-only SSE is a pre-existing slice-4 bug, noted as a known issue, not fixed here. Nothing is deprecated yet.

6. **Debounce window value and configurability** — a **fixed 50ms trailing debounce** for v1, **not caller-configurable**. A knob invites per-call-site tuning before any real workload evidence exists; if bursts prove pathological, widening one constant is a one-line follow-up. **Rejected:** exposing a `debounceMs` option on `.live()` or on `RealtimeOptions`.
7. **Does `.live()` accept `include`/`select`/`orderBy`/`take` unchanged?** — **yes, verbatim.** `.live()` re-runs the *same* `findMany(args)`, so whatever `findMany` supports is supported by construction. No argument subsetting, no filtered arg type, no new type surface.
8. **Is the handle cached across `.live()` calls on the same table?** — **yes: cached per table inside the client** until `exp` or a verified failure, then re-minted via `getHandle`. Not re-fetched per `.live()` call — that would multiply the app's auth round-trips for no benefit, since the token is table-scoped by design.

### Still open

None. All 8 questions are resolved; the proposal is ready for `sdd-spec` / `sdd-design`.
