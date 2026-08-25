# Design: `findMany().live()` typed client for `@@allow` models

Verified live against `main` @ `c019bc3`: `client/src/realtime.ts:103-117` (`handleFrame` drops every
non-`change` frame), `:142-172` (refcounted per-table channel, `ChannelListener`), `client/src/client.ts:16-22`
(`RealtimeOptions` — `url` only), `:133-145` (`$realtime` lazy manager), `:281-289` (`$authSession`),
`:291-296` (`$disconnect`), `client/src/promise.ts:80-133` (`IndigoPromise` is **lazy and single-use** —
`__claim`/`settle` memoize; a second use throws `OPERATION_REUSED`), `client/src/delegate.ts:673-679`
(`findMany<A>(args): IndigoPromise<Payload<Row,Rel,A>[]>` via `defer`), `client/src/realtime-delegate.ts:64-107`
(`subscribe`; `event.pk` dereferenced unconditionally — the known slice-4 defect), `realtime/src/engine.ts:191-223`
(**SSE `handleRequest` takes no handle**), `:285-376` (`handleLogRequest` status ladder), `:378-393`
(`dispatch` wake branch), `realtime/src/handle.ts:23-73` (`HandlePayload {v,t,u,exp}`, base64url JSON payload
segment — **decodable without the secret**; `node:crypto` lives here), `realtime/src/protocol.ts:76-82`
(`RealtimeWakeEvent`), `migrator` RLS goldens (`allow-new-table/expected.json:19`), `generator/src/client.ts:249,374,405-417,446,452,495-497`.

## Technical Approach

```
.live(handlers?)  ── sync return: {rows: [], status:"connecting", unsubscribe}
   │
   ├─(1) $handle(table) ─── cache hit? ──no──▶ getHandle(table) ──▶ decode {t,u,exp}
   │                                                (retry once, then status:"error")
   ├─(2) bootstrap:  runScoped(u, d => d.findMany(args))   ← RLS-scoped, fresh op
   ├─(3) manager.subscribe(table, {onWake, onEvent, onResync, onError})
   └─(4) wake ▶ fixed 50ms trailing window ▶ tick() ▶ runScoped(...findMany(args)) ▶ onData(rows)
                          (single in-flight + dirty flag)
```

**Correction to the proposal (blocking, mechanism-level).** The proposal's flow mints a handle and then
never sends it anywhere: the refetch is a local `findMany`, SSE needs no handle (`engine.ts:191`), and the
log endpoint is out of scope. Worse, a plain `findMany` on an `@@allow` model runs with `app.user_id` unset,
so `NULLIF(current_setting('app.user_id', true),'')::integer = "ownerId"` is `NULL` → **zero rows, always**.
This design makes the handle load-bearing instead: the client decodes its payload (`u`, `exp`, `t`) and runs
every snapshot/refetch through `$authSession`. Identity and expiry are the handle's job here; the HMAC
remains the *server* endpoint's job.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Where identity comes from | Decode the handle payload segment client-side (`base64url` → JSON, ~10 lines in `live.ts`) for `u`/`exp`/`t`; every snapshot and refetch runs inside `$authSession({userId: u})` | plain `findMany` (proposal); a `userId` option; calling `.live()` inside `$auth` | Plain `findMany` returns **zero rows** under RLS (goldens above). `$auth`'s scope is one transaction — a long-lived query cannot hold it open. The client MUST NOT import `handle.ts` (it pulls `node:crypto`; `protocol.ts` is type-only by contract) and cannot verify the HMAC anyway: it has no secret and the token came from its own app |
| 2 | `.live()` placement | `findMany(args).live(handlers?)` — `LiveModelDelegate` overrides `findMany` and returns `IndigoPromise<Payload<Row,Rel,A>[]> & { live(...): LiveQuery<Payload<Row,Rel,A>> }` (property attached to the `defer` result) | `.live()` on the shared `IndigoPromise`; `delegate.live(args, handlers)` | `IndigoPromise` is shared by every op — `.count().live()` would type-check. The chained form threads `A` for free, so `select`/`include` narrowing lands on `LiveQuery`'s rows with **no new arg type** (proposal decision 7). **`.live()` must never await the promise it hangs off**: `IndigoPromise` is single-use, so a reused op throws `OPERATION_REUSED` on the second refetch. Each refetch builds a fresh op from the captured `args` |
| 3 | Return shape | `LiveQuery<Row> { readonly rows: Row[]; readonly status: LiveStatus; unsubscribe(): Unsubscribe-style teardown }` returned **synchronously**, handlers passed to `.live()` | `Promise<LiveQuery>`; async iterator; callback-only | Firebase `onSnapshot` ergonomics + this codebase's handler-object precedent (`SubscribeHandlers`). Synchronous return is required for React `useEffect` cleanup: teardown must exist before the bootstrap resolves. `rows` as a getter lets a store read state without mirroring it |
| 4 | Debounce shape | **Fixed 50ms window armed by the FIRST wake of a burst**, never re-armed by later wakes | trailing debounce that resets the timer on each wake (the proposal's wording) | A resetting timer **starves** under sustained writes >20/s — the stream never refetches at all. First-wake arming still collapses an N-write burst into one refetch and guarantees ≥1 refetch per 50ms. Timer gets `.unref?.()` (engine heartbeat precedent) so a pending debounce never holds Node open |
| 5 | Coalescing | `inFlight` + `dirty` flags: a wake during a refetch sets `dirty`; the `finally` re-runs `tick()` exactly once | queue of pending refetches | Unbounded queue amplifies the storm it exists to damp |
| 6 | Handle cache | `Map<table, {token,userId,expiresAtMs}>` **plus a `Map<table, Promise>` in-flight map**, on `IndigoClientBase`; exposed as `protected $handle(table, {refresh})`; cleared in `$disconnect` | cache only; cache in `live.ts` | Without the in-flight map, two `.live()` calls in the same tick both miss and call `getHandle` **twice** — violating the "exactly once" criterion. Placement in `client.ts` matches `$realtime`'s lazy-thunk precedent and keeps the cache client-wide, not per-delegate |
| 7 | Generation gate | New `LiveModelDelegate extends RealtimeModelDelegate`, emitted only when `table.realtime && table.allow?.length`; `.live()` absent elsewhere at the type level | one class, runtime `throw` for non-qualifying models | The generator already selects the delegate class per table (`client.ts:374/408/446`) and `realtime-delegate.ts`'s header states the convention: "a compile-time error rather than a runtime one" |
| 8 | Wake plumbing | `TransportHandlers.onWake?` + `ChannelListener.onWake?` (both optional); `handleFrame` gains a `wake` branch; `change` frames stay byte-identical | replace `onEvent` with a tagged union | Optional additions keep `.subscribe()` and every existing listener untouched. `.live()` treats `onEvent` **and** `onWake` as the same trigger, so it stays correct if the gate ever widens |
| 9 | Resync | `onResync` forces one immediate `tick()` | ignore | `realtime.ts`'s header is explicit: events during a disconnect are lost. Without this, a reconnected `.live()` is silently stale forever — a defect the proposal does not mention |
| 10 | Notification policy | Notify on every successful refetch; no row diffing | deep/shallow equality suppression | Matches the "one write → one notification" criterion; `Payload` may nest `include` trees, so equality is neither cheap nor well-defined |

## Handle failure / retry state machine

| Trigger | Class | Action |
|---|---|---|
| Cache miss; `now >= exp - 5s` skew | expiry | Mint via `getHandle`; on success continue |
| Token unusable: no `.`, bad base64url/JSON, `v !== 1`, `t !== table`, empty `u`, non-finite or already-past `exp` | **verified handle failure** | Re-mint once with `{refresh:true}` |
| `getHandle` rejects | provider failure | Retry **once** immediately; second failure → `status:"error"`, `onError`, release the SSE refcount (terminal) |
| `getHandle` absent on `RealtimeOptions` | config | Throw a named error at `.live()` time naming the exact option, mirroring the `INDIGO_REALTIME_URL` message |
| Refetch (SQL) rejects | transport | `onError`, rows and `status` unchanged; the next wake retries |
| SSE `onError` | transport | Forward to `onError`; `SseTransport` already reconnects with backoff; **no re-mint** |

Log-endpoint statuses are unreachable in this slice (no request carries the handle) but are pinned here as
the forward contract: `401` is the **only** handle-invalid signal → re-mint; `404`/`400` are configuration
or caller bugs → `onError`, no re-mint; `405`/`5xx`/network → transport → retry, never re-mint.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/live.ts` | Create | `LiveQuery`/`LiveStatus`/`LiveHandlers`, payload decoder, debounce+coalesce loop, failure machine |
| `packages/client/src/realtime.ts` | Modify | `handleFrame` `wake` branch; `onWake?` on `TransportHandlers` + `ChannelListener`; manager fan-out |
| `packages/client/src/realtime-delegate.ts` | Modify | `LiveModelDelegate extends RealtimeModelDelegate` with the `findMany` override; `subscribe()` untouched |
| `packages/client/src/client.ts` | Modify | `RealtimeOptions.getHandle`; `handleCache`/`handleInflight`; `protected $handle`; `$disconnect` clears both |
| `packages/client/src/index.ts` | Modify | Export `LiveModelDelegate` + live types |
| `packages/generator/src/client.ts` | Modify | `hasLive` import flag; `LiveModelDelegate` at the three per-table sites (374/408/446); emit the `runScoped` closure |
| `packages/client/test/live.mjs`, `packages/generator/test/live-emit.mjs` | Create | New harness (config rule: no test infra outside `@indigodb/compiler`) |

## Interfaces

```ts
// packages/client/src/live.ts
export type LiveStatus = "connecting" | "live" | "error";
export interface LiveHandlers<Row> {
  onData?: (rows: Row[]) => void;
  onStatus?: (status: LiveStatus) => void;
  onError?: (error: Error) => void;
}
export interface LiveQuery<Row> {
  readonly rows: Row[];              // [] until the first snapshot settles
  readonly status: LiveStatus;
  unsubscribe(): void;               // idempotent; safe before bootstrap resolves
}
export const LIVE_DEBOUNCE_MS = 50;  // internal constant, not a caller option

// packages/client/src/client.ts
export interface RealtimeOptions { url?: string; getHandle?: (table: string) => Promise<string>; }

// generator emission, in the IndigoClient constructor (only site that can build delegates)
const runScoped = <T,>(userId: string, model: string, run: (d: any) => Promise<T>) =>
  this.$authSession({ userId }, (exec) => run(__delegates(exec, this.$realtime).byModel[model]));
```

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | `handleFrame`: `wake` parsed, `change` byte-identical, unknown names still dropped, malformed JSON skipped | fake stream, no network |
| Unit | Debounce: N wakes in one window → 1 refetch; **sustained wakes still refetch** (decision 4 RED test); wake during in-flight → exactly 1 follow-up | fake timers + fake transport |
| Unit | Handle cache: two concurrent `.live()` → `getHandle` once; past `exp` → one re-mint; malformed token → one re-mint; two rejects → `status:"error"` + `onError`; `onError` absent never throws | stub `getHandle` counter |
| Unit | Refetch builds a **fresh** `IndigoPromise` (no `OPERATION_REUSED` on the 2nd wake) — decision 2 RED test | counting fake executor |
| Unit | `unsubscribe()` before bootstrap resolves emits nothing; last `.live()` on a table closes the channel | refcount assertion |
| Unit | `onResync` forces one refetch (decision 9 RED test) | fake transport reconnect |
| Emission | `.live()` present for `@@realtime`+`@@allow`, absent for `@@realtime`-only; non-qualifying output byte-identical to today | `generateClient` over hand-built `ResolvedSchema` |
| Integration | Snapshot equals `findMany` under `$auth` for the same identity; two identities see disjoint rows | optional, real PG, non-`BYPASSRLS` role |

## Threat Matrix

Shell/subprocess/VCS-PR/executable-classification rows: `N/A`.

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Identity spoofing via the handle payload | Yes | `u` is used only as `$authSession`'s bound `set_config` value; RLS re-evaluates server-side per refetch. A forged local payload can only *narrow* what the app's own DB role already grants | Payload with `u` = `"1' OR '1'='1"` yields zero extra rows (bound parameter) |
| Table confusion | Yes | `t !== table` is a verified handle failure → re-mint, never a query under another table's claim | Handle minted for `Post` used by `Comment.live()` → re-mint, then error |
| Secret handling | Yes | The client never holds `INDIGODB_REALTIME_SECRET`; no HMAC code reaches the browser bundle; `@indigodb/realtime` stays type-only imports | Import graph assertion: `live.ts` pulls no runtime symbol from `@indigodb/realtime` |
| Resource amplification | Yes | One SSE connection per table (existing refcount); at most one in-flight refetch per live query; 50ms floor | Sustained-wake test asserts bounded refetch count |
| Error oracle | Yes | `onError` receives client-side errors only; DB error text already normalized by `withDatabaseErrors` | — |

## Migration / Rollout

Code-only. No DDL, no server, `crates/`, or WASM change (the diff must contain none). `getHandle` is an
additive optional field; generated output for every non-qualifying model stays byte-identical. Rollback is
the proposal's four steps plus reverting the `LiveModelDelegate` class. `400-line budget risk: Medium`
(~330–400 lines incl. the new harness). `Chained PRs recommended: No`. `Decision needed before apply: Yes`
— decision 1 changes the proposal's stated mechanism and the `client-live-queries` spec must state the
`$authSession`-scoped refetch, not a bare `findMany`.

## Open Questions

- [ ] **Blocking-ish**: decision 1 (handle payload decoded client-side, refetch under `$authSession`) is a
      mechanism change versus the finalized proposal. `sdd-spec` must encode it, or the implementation ships
      a live query that returns zero rows for every `@@allow` model.
- [ ] Non-blocking: `.live()` called inside a `$transaction`/`$auth` callback hits `$withSession`'s nesting
      guard. Proposed: surface it via `onError` + `status:"error"` with a named message rather than throwing;
      confirm during apply.
