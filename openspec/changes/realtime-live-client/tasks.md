# Tasks: `findMany().live()` typed client for `@@allow` models

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~330-400 total (design's estimate; `packages/client` + `packages/generator` only, incl. new test harness) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | None — single slice |
| Delivery strategy | ask-on-risk |
| Chain strategy | N/A |

Decision needed before apply: Yes — design decision 1 amends the finalized proposal's mechanism:
both the initial snapshot and every refetch run inside `$authSession({userId: u})` derived from
the handle's locally-decoded claim, never a bare `findMany` (already applied to
`openspec/changes/realtime-live-client/specs/client-live-queries/spec.md` Requirement 3).
Chained PRs recommended: No
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|------------------|--------------------|
| 1 | `LiveQuery`/handle decode/cache/debounce/coalesce/failure machine in `packages/client`; `LiveModelDelegate` generation gate in `packages/generator`; new `live.mjs`/`live-emit.mjs` test files added to each package's existing suite chain | Single PR | `pnpm --filter @indigodb/client test` / `pnpm --filter @indigodb/generator test` | `packages/client/test/live.mjs` (fake stream/timers/transport, no network); `packages/generator/test/live-emit.mjs` (hand-built `ResolvedSchema` fixtures) | Revert the PR; `.live()` is purely additive (new export + generator gate), `.subscribe()` and every non-qualifying model's generated output are unchanged, no server/WASM/DDL touched |

## Pre-flight note on test scaffolding (verify before starting)

Design's File Changes table describes `packages/client/test/live.mjs` and
`packages/generator/test/live-emit.mjs` as "New harness (config rule: no test infra outside
`@indigodb/compiler`)". **This is not accurate against the current repo state** — both
`packages/client/package.json` and `packages/generator/package.json` already wire a chain of
plain-Node `.mjs` suites into their own `test` script (e.g. `client/test/auth.mjs`,
`client/test/client.mjs`, `generator/test/auth-emission.mjs`, `generator/test/relation-emission.mjs`),
run under Turbo's `test` task from the repo root. Tasks 12.x below therefore **add** `live.mjs`
and `live-emit.mjs` to the existing chains — no new scaffolding is stood up from scratch. Root
`CLAUDE.md`'s "the only suite is `@indigodb/compiler`'s regression harness" describes the
canonical/most-exercised suite, not the literal set of `test` scripts Turbo runs.

## Slice — `.live()` client + generator gate (single PR)

Satisfies (spec): `client-live-queries` Requirements 1-13 (generation gate, verbatim args,
`$authSession` scoping, plain-`findMany` snapshot, status lifecycle, debounce, coalescing,
mid-flight dirty flag, handle cache, handle-failure classification, retry-then-error,
teardown/refcount, `.subscribe()` unaffected); `realtime-live-endpoint`'s two MODIFIED
requirements (wake frame is a client-observable trigger; `getHandle` is the only provisioning
path, no IndigoDB-owned minting route).

Design ref: Engram #747 (`design.md`) — Technical Approach diagram, decisions 1-10, handle
failure/retry state machine, File Changes, Interfaces, Testing Strategy, Threat Matrix.

### 1. Handle payload decoder (`packages/client/src/live.ts`)

- [ ] 1.1 [RED] `packages/client/test/live.mjs`: `decodeHandlePayload(token)` — valid
  `base64url(JSON.stringify({v:1,t:"Order",u:"42",exp:<future>}))` (no signature segment needed
  by the decoder — it never checks the HMAC) round-trips to `{v:1,t:"Order",u:"42",exp:<future>}`;
  a token with no `.` separator, invalid base64url, invalid JSON, `v !== 1`, `t` mismatched
  against the caller's table, empty `u`, and a non-finite or already-past `exp` (with a 5s skew
  allowance) each classify as a **verified handle failure**, distinct from every other rejection
  reason.
- [ ] 1.2 [GREEN] `packages/client/src/live.ts`: implement `decodeHandlePayload` — split on the
  first `.`, `Buffer`/`atob`-safe base64url decode of the payload segment only, `JSON.parse`,
  validate `v`/`t`/`u`/`exp` per 1.1. ~10 local lines, no signature verification, no
  `node:crypto` import anywhere in this file.
- [ ] 1.3 [RED — threat: secret handling] `packages/client/test/live.mjs`: static import-graph
  assertion — `packages/client/src/live.ts`'s source contains no `import` of a runtime symbol
  from `@indigodb/realtime` (only type-only imports, if any, are permitted); confirm no
  `node:crypto` import appears anywhere in `live.ts`.
- [ ] 1.4 [GREEN] confirm `live.ts`'s only `@indigodb/realtime` imports (if needed for shared
  types like `RealtimeWakeEvent`) use `import type`, never a value import.

### 2. Handle cache + in-flight dedup (`packages/client/src/client.ts`)

- [ ] 2.1 [RED] `packages/client/test/live.mjs`: two `.live()` calls on the same table issued in
  the same tick, before either resolves, call the stubbed `getHandle` exactly once (in-flight
  map dedup).
- [ ] 2.2 [RED] a cached, unexpired handle is reused by a second `.live()` call on the same
  table — `getHandle` not called again.
- [ ] 2.3 [RED] a cached handle whose `exp` has passed (or is within the 5s skew window) triggers
  exactly one re-mint on the next `.live()` call for that table.
- [ ] 2.4 [GREEN] `packages/client/src/client.ts`: add `handleCache: Map<string,
  {token,userId,expiresAtMs}>` and `handleInflight: Map<string, Promise<...>>`; `protected
  $handle(table, {refresh}?)`; `RealtimeOptions.getHandle?: (table: string) => Promise<string>`;
  missing `getHandle` on `RealtimeOptions` throws a named error at `.live()` call time (mirrors
  the existing `INDIGO_REALTIME_URL` missing-config message shape).
- [ ] 2.5 [RED] `$disconnect()` clears both `handleCache` and `handleInflight`.
- [ ] 2.6 [GREEN] wire the clear into `$disconnect`.

### 3. Handle failure / retry state machine — reachable scope only

**Scope flag (read before implementing):** the spec's "Only a verified handle failure triggers a
re-mint" requirement (and its HTTP `401`/`5xx`/`404`/`400` scenarios) is defined entirely in
terms of responses from `GET ?handle&offset`. Design.md is explicit that **this PR's `.live()`
never calls that endpoint** — it bootstraps via `findMany` and tails via SSE `wake` only, and
design pins the HTTP-status classification as "unreachable in this slice ... pinned here as the
forward contract" for a later incremental-reconciliation slice. There is no code path in this
PR's scope that can produce or observe a `401`/`404`/`5xx`/`400` from that endpoint. Tasks below
implement the failure machine actually reachable from this PR's code, per design's own state
machine table (local decode validation + `getHandle` rejection), and MUST NOT fabricate a fake
HTTP call to the log endpoint solely to satisfy the spec's literal wording. Flag this mismatch
explicitly for `sdd-verify`/apply-time review — non-blocking, since design itself pins it
forward, but the spec text and this PR's actual code path disagree on what "verified handle
failure" is triggered by.

- [ ] 3.1 [RED] `packages/client/test/live.mjs`: a locally-undecodable/invalid token (per 1.1's
  cases) is treated as a verified handle failure — one re-mint via `getHandle({refresh:true})`;
  success resumes with no `onError`.
- [ ] 3.2 [RED] `getHandle` itself rejects (provider failure, distinct from a decode failure) —
  retried once immediately; a second rejection sets `status:"error"`, invokes `onError` if
  provided, and releases the query's SSE refcount (terminal — no further retry).
- [ ] 3.3 [RED] `onError` absent never throws into the host event loop on either failure path.
- [ ] 3.4 [GREEN] `packages/client/src/live.ts`: implement the retry-once-then-error state
  machine over exactly these two reachable triggers (decode-invalid token, `getHandle` reject);
  no branch keyed on an HTTP status code exists in this PR.

### 4. Bootstrap + refetch scoped via `$authSession`

- [ ] 4.1 [RED] `packages/client/test/live.mjs`: the initial `findMany(args)` snapshot runs
  inside `$authSession({userId: u})` using the cached/minted handle's decoded `u` claim (assert
  via a fake executor that observes the session-scoped call, not a bare `findMany`).
- [ ] 4.2 [RED — negative] a `findMany` issued outside `$authSession` scoping (simulated fake RLS
  predicate) returns zero rows regardless of table contents — locks in the spec's Requirement 3
  negative scenario as a regression guard.
- [ ] 4.3 [GREEN] `packages/client/src/live.ts` + generator-emitted `runScoped` closure
  (`packages/generator/src/client.ts`, Interfaces section): bootstrap runs
  `runScoped(u, model, d => d.findMany(args))`.

### 5. Debounce + coalesce

- [ ] 5.1 [RED] `packages/client/test/live.mjs` (fake timers): a single `wake` produces no
  synchronous refetch; the refetch fires once the fixed 50ms trailing window elapses.
- [ ] 5.2 [RED] N wakes inside one 50ms window collapse to exactly one refetch + one listener
  notification.
- [ ] 5.3 [RED — decision 4 regression guard] sustained wakes faster than the window (e.g. every
  10ms, >20/s) still produce at least one refetch per armed window — the timer is armed by the
  FIRST wake of a burst and is **never re-armed** by later wakes in the same burst; assert this
  against a naive "reset on each wake" implementation to prove it does not starve.
- [ ] 5.4 [RED] two wakes more than 50ms apart each trigger their own refetch.
- [ ] 5.5 [RED] a wake arriving while a refetch is in flight sets a dirty flag and schedules
  exactly one follow-up refetch after the in-flight one resolves — no second concurrent refetch.
- [ ] 5.6 [GREEN] `packages/client/src/live.ts`: implement the first-wake-armed fixed 50ms window,
  single in-flight guard + dirty flag, `LIVE_DEBOUNCE_MS = 50` internal constant (not a caller
  option); arm the timer with `.unref?.()` so a pending debounce never holds Node open.

### 6. Fresh op per refetch (no `OPERATION_REUSED`)

- [ ] 6.1 [RED] `packages/client/test/live.mjs`: a counting fake executor confirms each refetch
  builds a brand-new `IndigoPromise`-compatible op from the captured `args` — the second wake's
  refetch does not throw `OPERATION_REUSED`, proving the original bootstrap op is never reused or
  re-awaited.
- [ ] 6.2 [GREEN] `packages/client/src/live.ts`: build a fresh `findMany(args)` op per refetch,
  never referencing the bootstrap promise after it settles.

### 7. Reconnect / resync

- [ ] 7.1 [RED] `packages/client/test/live.mjs` (fake transport reconnect): `onResync` from the
  SSE transport forces exactly one immediate `$authSession`-scoped refetch, independent of the
  debounce window.
- [ ] 7.2 [GREEN] wire `onResync` in `live.ts`'s `manager.subscribe(...)` handlers.

### 8. `$authSession` nesting guard surfacing

- [ ] 8.1 [RED] `packages/client/test/live.mjs`: `.live()` invoked from inside an existing
  `$transaction`/`$auth` callback trips `$withSession`'s nesting guard; assert it surfaces via
  `onError` + `status:"error"` with a named, distinguishable message, and does **not** throw
  synchronously into the caller.
- [ ] 8.2 [GREEN] `packages/client/src/live.ts`: catch the nesting-guard error at the bootstrap
  call site and route it through the same failure-surfacing path as 3.4, rather than letting it
  propagate.

### 9. Wake plumbing (`packages/client/src/realtime.ts`)

- [ ] 9.1 [RED] `packages/client/test/live.mjs` (fake SSE stream): `handleFrame` parses a `wake`
  event distinctly from `change`; `change` frames remain byte-identical to today; an unknown
  event name is still silently dropped; a malformed JSON `wake` frame is skipped, not thrown.
- [ ] 9.2 [GREEN] `packages/client/src/realtime.ts`: add optional `onWake?` to
  `TransportHandlers` and `ChannelListener`; add the `wake` branch to `handleFrame`; fan out
  through the existing per-table `ChannelListener` manager.
- [ ] 9.3 [RED] the last `.live()`/`.subscribe()` subscriber on a table tearing down closes the
  shared SSE connection; a remaining subscriber (either kind) keeps it open.
- [ ] 9.4 [GREEN] wire `.live()`'s `unsubscribe()` through the existing refcounted
  `RealtimeConnectionManager` teardown path (`.subscribe()`'s path, unchanged).

### 10. `LiveQuery` return shape and status lifecycle

- [ ] 10.1 [RED] `.live()` returns synchronously — `{rows: [], status: "connecting",
  unsubscribe}` — before the bootstrap `findMany` resolves; `unsubscribe()` called before
  bootstrap resolves emits nothing and is idempotent (safe to call twice).
- [ ] 10.2 [RED] `status` transitions `"connecting"` → `"live"` once the snapshot resolves and
  the wake subscription is active; once `"error"`, `status` never reverts to `"live"` without a
  fresh `.live()` call.
- [ ] 10.3 [GREEN] `packages/client/src/live.ts`: implement `LiveStatus`, `LiveHandlers<Row>`,
  `LiveQuery<Row>` per design's Interfaces section; `rows` as a getter over live-updated internal
  state, notify listeners on every successful refetch (no row diffing/equality suppression).

### 11. Generator wiring (`packages/generator/src/client.ts`)

- [ ] 11.1 [RED] `packages/generator/test/live-emit.mjs`: a hand-built `ResolvedSchema` with a
  model carrying `table.realtime === true` AND a non-empty `table.allow` emits a
  `RealtimeModelDelegate`/`LiveModelDelegate` exposing `.live()`.
- [ ] 11.2 [RED] a model with `table.realtime === true` and no `@@allow` (or an empty `allow`)
  emits **no** `.live()` method at all — type-level omission, not a runtime throw — and the rest
  of that model's generated output is byte-identical to today's.
- [ ] 11.3 [GREEN] `packages/generator/src/client.ts`: add a `hasLive` gate
  (`table.realtime && table.allow?.length`) at the three existing per-table delegate-selection
  sites; emit `LiveModelDelegate extends RealtimeModelDelegate` (overriding `findMany`) only for
  qualifying models; emit the `runScoped` closure in the `IndigoClient` constructor per design's
  Interfaces section.
- [ ] 11.4 [RED] `.subscribe()`'s generated output is byte-identical for both qualifying and
  non-qualifying models, before and after this change — proves `.live()` is purely additive and
  the known `.subscribe()` wake-frame gap for `@@allow` models is unchanged, not silently fixed.
- [ ] 11.5 [GREEN] confirm 11.4 holds structurally once 11.3 lands (keep as its own standalone
  assertion per repo convention, not folded into 11.1-11.3).

### 12. Exports + test harness wiring

- [ ] 12.1 [GREEN] `packages/client/src/index.ts`: export `LiveModelDelegate`, `LiveQuery`,
  `LiveStatus`, `LiveHandlers`.
- [ ] 12.2 [GREEN] `packages/client/test/live.mjs`: assemble the suite (plain Node, no
  framework, mirroring `client.mjs`/`auth.mjs`'s `check()`/`assert()` style); append `&& node
  test/live.mjs` to `packages/client/package.json`'s existing `test` script chain.
- [ ] 12.3 [GREEN] `packages/generator/test/live-emit.mjs`: assemble the suite (mirrors
  `auth-emission.mjs`'s hand-built-`ResolvedSchema` style); append `&& node
  test/live-emit.mjs` to `packages/generator/package.json`'s existing `test` script chain.

### 13. Threat matrix

- [ ] 13.1 [RED — threat: identity spoofing via the handle payload] a decoded payload with
  `u = "1' OR '1'='1"` yields zero extra rows through `$authSession` — the value is bound as a
  parameter, never string-built into SQL/config.
- [ ] 13.2 [RED — threat: table confusion] a handle minted for `Post` used to construct
  `Comment.live()` fails the `t !== table` check (verified handle failure) → re-mint attempted,
  then `status:"error"` if the re-mint also mismatches.
- [ ] 13.3 [RED — threat: resource amplification] a sustained-wake test asserts a bounded refetch
  count: one SSE connection per table (existing refcount), at most one in-flight refetch per live
  query, and the 50ms floor from section 5 holds under load.
- [ ] 13.4 [GREEN] confirm 1.3/1.4's import-graph assertion doubles as this row's secret-handling
  guard — no additional code needed, cross-reference only.

### 14. Optional integration coverage (real Postgres)

- [ ] 14.1 [RED — real PG, optional, self-skips without `INDIGODB_TEST_DATABASE_URL`] snapshot
  from `.live()`'s bootstrap equals a standalone `findMany` run under `$auth` for the same
  identity; two different identities' live queries on the same table see disjoint row sets —
  mirrors `client/test/auth.mjs`'s PGlite harness pattern.

### 15. Verify + commit

- [ ] 15.1 [VERIFY] `pnpm --filter @indigodb/client build && pnpm --filter @indigodb/client lint
  && pnpm --filter @indigodb/client test`.
- [ ] 15.2 [VERIFY] `pnpm --filter @indigodb/generator build && pnpm --filter @indigodb/generator
  lint && pnpm --filter @indigodb/generator test`.
- [ ] 15.3 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide; no `crates/` touched
  this slice — no WASM rebuild, no snapshot regen, `cargo test` not required).
- [ ] 15.4 [COMMIT] `feat(client,generator): add findMany().live() for @@realtime+@@allow models`.

## Post-slice cleanup

- [ ] C1 Confirm the proposal's Success Criteria are demonstrably met by this slice's tests
  (generation gate, `$authSession`-scoped snapshot + refetch, debounce/coalesce incl. the
  sustained-write starvation guard, fresh-op-per-refetch, resync-forces-refetch, handle cache +
  in-flight dedup, retry-once-then-error over the reachable failure set, teardown/refcount,
  `.subscribe()` byte-identical, `pnpm build/lint/test` green).
- [ ] C2 Merge the 1 new full spec (`client-live-queries`) and the `realtime-live-endpoint` delta
  into `openspec/specs/` once this change archives.
- [ ] C3 **Flag for `sdd-verify`/apply-time review (non-blocking):** `client-live-queries`
  Requirement "Only a verified handle failure triggers a re-mint" is written entirely against
  `GET ?handle&offset` HTTP status codes (`401`/`5xx`/`404`/`400`), but this PR's `.live()` never
  calls that endpoint — design.md pins that classification as a forward contract for a later
  incremental-reconciliation slice, not this one. This PR implements only the locally-reachable
  failure machine (section 3). The spec text and this PR's actual code path do not match on that
  one requirement; reconcile spec wording (or explicitly scope it to a future slice) before or
  during the log-page-consuming follow-up work, rather than treating section 3 as non-compliant.
- [ ] C4 Log follow-up (non-blocking): `.subscribe()`'s pre-existing `event.pk` wake-frame defect
  for `@@allow` models remains unfixed, as documented in spec Requirement 13 — tracked separately,
  not reopened by this change.
- [ ] C5 Log follow-up (non-blocking): a future incremental-reconciliation slice that has
  `.live()` (or a related API) actually call `GET ?handle&offset` is the point where spec
  Requirement 10/11's HTTP-status-based verified/transport-failure classification becomes
  reachable and testable end-to-end.
