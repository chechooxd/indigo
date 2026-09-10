# Realtime Live Endpoint Specification

## Purpose

Defines the cacheable `GET ?handle&offset` read path over `_indigo_realtime_log`: route
contract, `id`-based cursor semantics, opaque signed handles binding table + identity claim,
`app.user_id` binding to RLS, table-scoped-only limitation, fixed page size, sealed-vs-head
cache-control rules, and the SSE wake-up scoping that makes the `@@allow`+`@@realtime` guard
removal safe.

## Requirements

### Requirement: `GET ?handle&offset` returns a paginated log slice

`RealtimeEngine` MUST expose a `GET` route branch, published on both hosts via `attach()`,
accepting `handle` and `offset` query parameters and returning
`{events: RealtimeEvent[], offset: <next-id>, hasMore: boolean}`. Rows MUST be selected with
`WHERE table_name = <handle's table> AND id > <offset> ORDER BY id LIMIT <fixed page size>`.

#### Scenario: Page of events returned in cursor order

- GIVEN a valid handle for table `Order` and `offset=100`
- WHEN `GET ?handle=<token>&offset=100` is requested
- THEN the response contains events for `Order` with `id > 100`, ordered ascending by `id`,
  and a `offset` field usable as the next request's cursor

#### Scenario: `hasMore` reflects whether the page was filled

- GIVEN fewer rows remain than the fixed page size
- WHEN the page is served
- THEN `hasMore` is `false`; a full page sets `hasMore` to `true`

### Requirement: `offset` is the log's `id` column, not `lsn`

The cursor MUST be `_indigo_realtime_log.id` (bigserial). `lsn` MUST NOT be used as the cursor,
because multiple rows share one commit LSN. This relies on the log's arrival order matching
commit order, guaranteed by the replication slot being exclusive to one writer.

#### Scenario: Cursor advances past a multi-row commit

- GIVEN a single transaction wrote three log rows sharing one `lsn` but three distinct `id`s
- WHEN a client pages through with `offset`
- THEN each row is returned exactly once, and the next `offset` is the highest `id` seen

### Requirement: Every request requires a valid signed handle, uniformly

The endpoint MUST require `handle` on every request, including for tables with no `@@allow`
rules. There MUST be no code path that serves rows for a table name supplied outside the
handle's signed payload, and no branch that treats protected and public tables differently at
request time.

#### Scenario: Public model still requires a handle

- GIVEN a table with no `@@allow` block
- WHEN `GET` is requested with `offset` but no `handle`
- THEN the request is rejected and no rows are returned

#### Scenario: Table name cannot be supplied outside the handle

- GIVEN a valid handle minted for table `Order`
- WHEN the request additionally supplies a different table via any query parameter
- THEN only `Order` rows are ever considered; no parameter overrides the handle's bound table

### Requirement: Handle payload, signing, and verification

A handle MUST be `base64url(payload) "." base64url(HMAC-SHA256(payload, secret))`, where
`payload = {v: 1, t: <table>, u: <identity claim>, exp: <unix timestamp>}`. Verification MUST
use a timing-safe comparison. The secret MUST be read from `INDIGODB_REALTIME_SECRET`. Minting
MUST be exposed as `mintHandle({table, userId, ttl}, secret)`; verification as
`verifyHandle(token, secret)`. The endpoint MUST NOT trust any identity claim supplied outside
the verified signature.

Handle provisioning to the generated client is pinned to an **app-supplied `getHandle`
callback** (`IndigoClientOptions.realtime.getHandle: (table) => Promise<string>`), not to any
IndigoDB-owned HTTP minting route. The app calls `mintHandle` itself, server-side, after its
own authentication, and returns the resulting token string to the client via `getHandle`.
IndigoDB MUST NOT expose any HTTP route that mints a handle on the app's behalf; doing so would
require IndigoDB to authenticate the caller, which is explicitly out of scope — `$auth` already
draws this line, and `getHandle` preserves it.
(Previously: this requirement described only the server-side mint/verify contract, with no
stated position on how a client obtains a handle at all — no client consumer existed yet.)

#### Scenario: Minted handle round-trips

- GIVEN `mintHandle({table: "Order", userId: "u1", ttl: 3600}, secret)`
- WHEN the resulting token is passed to `verifyHandle(token, secret)`
- THEN verification succeeds and yields `{table: "Order", userId: "u1"}`

#### Scenario: Identity comes only from the verified handle

- GIVEN a valid handle minted for `userId: "u1"`
- WHEN the request is processed
- THEN `app.user_id` is set to `"u1"` from the verified payload, regardless of any other
  identity-shaped value present in the request

#### Scenario: The client never mints a handle directly

- GIVEN a generated client with `realtime.getHandle` configured to call `mintHandle` on the
  app's own backend
- WHEN a `.live()` query needs a handle
- THEN the client calls the app-supplied `getHandle(table)` function and uses its resolved
  token verbatim; the client package itself never calls `mintHandle` or any minting HTTP route

### Requirement: Signature, version, and expiry failures are a uniform opaque 401

Any handle that fails signature verification, carries an unrecognized `v`, or has `exp` in the
past MUST be rejected with `401` and no response body detail distinguishing the failure reason.
The endpoint MUST NOT leak whether the table name, claim, or signature was the specific cause.

#### Scenario: Tampered payload rejected

- GIVEN a valid handle whose payload is altered (e.g. `u` changed to a different user) without
  re-signing
- WHEN the request is made
- THEN the response is `401` and no events are returned

#### Scenario: Tampered signature rejected

- GIVEN a valid handle whose signature bytes are altered
- WHEN the request is made
- THEN the response is `401`, indistinguishable from a payload-tamper `401`

#### Scenario: Unknown version rejected

- GIVEN a handle payload with `v: 2` (unsupported), correctly signed
- WHEN the request is made
- THEN the response is `401`

#### Scenario: Expired handle rejected

- GIVEN a handle whose `exp` is in the past, with a valid signature
- WHEN the request is made
- THEN the response is `401`, and no rows for the handle's table are returned

### Requirement: Handle expiry is mandatory

`mintHandle` MUST require an expiry; a handle with no `exp` MUST NOT be mintable. Default `ttl`
MUST be approximately one hour when not specified at mint.

#### Scenario: Mint without ttl uses the default

- GIVEN `mintHandle({table: "Order", userId: "u1"}, secret)` with no `ttl`
- WHEN the token is decoded
- THEN its `exp` is approximately one hour from mint time

### Requirement: Identity is bound to RLS via `app.user_id`

On a verified request, the endpoint MUST set `app.user_id` from the handle's claim via
`set_config('app.user_id', $1, true)` before querying the log, so `_indigo_realtime_log`'s
existing RLS policy performs the row filtering.

#### Scenario: Two identities on the same table see different rows

- GIVEN two valid handles for the same table but different `userId` claims, and log rows whose
  `buckets` scope them to each respective user
- WHEN both callers request the same `offset`
- THEN each receives only the rows its identity's RLS policy permits

### Requirement: Table-scoped handles only (v1)

A handle MUST bind to exactly one table and MUST NOT encode an arbitrary `where` predicate.
Clients receive all bucket-visible rows for the bound table and MUST narrow further
client-side.

#### Scenario: No predicate parameter is honored

- GIVEN a valid handle for table `Order`
- WHEN the request supplies any additional filter-shaped query parameter
- THEN the response is unaffected by that parameter; only RLS-permitted `Order` rows are
  considered

### Requirement: Page size is server-fixed

The endpoint MUST use a fixed, server-defined page size for `LIMIT`. The endpoint MUST NOT
accept a client-supplied page-size parameter.

#### Scenario: Client-supplied limit is ignored

- GIVEN a request that includes a limit-shaped query parameter
- WHEN the request is processed
- THEN the number of returned events is capped at the server-fixed page size regardless of
  that parameter's value

### Requirement: Sealed pages are cached long-lived and immutable; head-of-log pages are never cached

A response whose events array reached the fixed page size (`hasMore: true`, i.e. `LIMIT` was
filled) MUST be sealed and immutable: it MUST be served with
`Cache-Control: public, max-age=31536000, immutable`. A response that did not fill `LIMIT`
(including an empty page) MUST be served with `Cache-Control: no-store`.

#### Scenario: Sealed page gets an immutable long-lived TTL

- GIVEN a request whose result fills the fixed page size
- WHEN the response is served
- THEN `Cache-Control` is `public, max-age=31536000, immutable`

#### Scenario: Head-of-log page is never cached

- GIVEN a request at the current tail of the log, returning fewer events than the page size
  (including zero)
- WHEN the response is served
- THEN `Cache-Control` is `no-store`

#### Scenario: Re-requesting a sealed page returns byte-identical content

- GIVEN a previously sealed page for `(handle, offset)`
- WHEN the same `(handle, offset)` is requested again
- THEN the response body is byte-identical to the first response

#### Scenario: An empty page is never served as cacheable (inverted-TTL regression guard)

- GIVEN the log currently has no rows past `offset` for the handle's table
- WHEN `GET ?handle&offset` is requested
- THEN the response contains zero events, `hasMore: false`, and `Cache-Control: no-store` —
  never a cacheable directive, even though the request otherwise succeeded

### Requirement: SSE dispatch is scoped to a data-free wake-up signal for every model, `@@allow` or not

`RealtimeEngine.handleRequest`'s `GET <REALTIME_PATH>?tables=...` route performs zero
authentication and applies the configured CORS origin allowlist (`realtime-origin-allowlist`,
closed by default) instead of an unconditional `access-control-allow-origin: "*"` — any origin
still not on that allowlist cannot open it, and with no allowlist configured, no origin can.
Because of that, `RealtimeEngine.dispatch()` MUST send every SSE subscriber a frame containing
only `{table, op, lsn, seq}` — never `pk`, `new`, or `old` — for ANY table, `@@allow` or not.
Scoping only `@@allow`-protected models (as an earlier version of this requirement did) left every
`@@realtime` model without `@@allow` on full-payload SSE, an unauthenticated, cross-origin-
readable leak of live row data; fail-closed dispatch is now unconditional, not predicated on
`ResolvedTable.allow`. Row data reaches a remote consumer only through the handle-authenticated
`GET <REALTIME_LOG_PATH>?handle&offset` route (`handleLogRequest`), which verifies a signed
handle and binds `app.user_id` for RLS scoping before returning any row. In-process listeners
(an app embedding `RealtimeEngine` in the same process, as the Studio does) are not on the wire
and are unaffected: they still receive the complete `RealtimeEvent`, including projected
`new`/`old`.

This wake frame is now a **client-observable trigger contract**: the generated client's
`.live()` (see `client-live-queries`) treats `event: wake` as the sole signal to refetch via
`findMany`, and MUST NOT rely on the wake frame carrying any row data. The frame shape and its
data-free guarantee are therefore load-bearing for a real consumer, not only an internal
implementation detail.
(Previously: this requirement described the route as setting an unconditional
`access-control-allow-origin: "*"`, so any origin could open it regardless of authentication. CORS
is now configuration-driven via the origin allowlist, defaulting closed; the wake-only,
fail-closed dispatch contract itself is unchanged.)

#### Scenario: `@@allow` model wake-up frame carries no row data

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and `@@realtime`
- WHEN a row changes on that model
- THEN the dispatched SSE frame contains only `table`, `op`, and `lsn` — `pk`, `new`, and `old`
  are all absent

#### Scenario: `pk` is dropped even though it could disambiguate the row

- GIVEN a model with a composite primary key where one key field is itself sensitive
  (e.g. `ownerId` inside the key)
- WHEN a row changes and the wake-up frame is dispatched
- THEN `pk` is absent from the frame; clients determine what changed by re-fetching from
  `findMany`, not by key

#### Scenario: Create-only `@@allow` model still gets wake-up-only SSE

- GIVEN a model with `@@allow(create, true)` and `@@realtime`, and no `read` rule anywhere in
  its `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is still the scoped `{table, op, lsn}` shape, not a full payload
  — because `ResolvedTable.allow !== undefined` for this model, even though `computeBuckets`
  would independently deny all reads via RLS

#### Scenario: Non-`@@allow` realtime model also gets wake-up-only SSE

- GIVEN a `@@realtime` model with no `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is the scoped `{table, op, lsn, seq}` shape, regardless of the
  configured CORS origin allowlist — the SSE route is unauthenticated regardless of `@@allow`, so
  it never carries `pk`, `new`, or `old` for any model

#### Scenario: A generated `.live()` query observes the wake frame as its refetch trigger

- GIVEN a generated client for a model with `@@realtime` and `@@allow`, with an active
  `.live()` query on that model
- WHEN the model's row changes and the scoped `{table, op, lsn}` frame is dispatched
- THEN `.live()` receives `event: wake` as the trigger to schedule a debounced `findMany`
  refetch, using only `table` and `op` to decide to refetch — never reading `pk`/`new`/`old`
  from the frame, since none are present
### Requirement: Guard removal and SSE scoping ship together

A deployment MUST NOT lift the `@@realtime` + `@@allow` compiler guard without also shipping
the SSE wake-up scoping in the same change. The endpoint's RLS-enforced read path and the
SSE payload scoping are jointly what makes the combination safe; either alone reopens the leak
the guard existed to prevent.

#### Scenario: No configuration permits full-payload SSE for an `@@allow` model

- GIVEN any model with both `@@realtime` and `@@allow`
- WHEN SSE dispatches an event for that model
- THEN the frame is always the scoped `{table, op, lsn}` shape; there is no flag, option, or
  code path that restores `pk`/`new`/`old` for such a model

### Requirement: Daemon startup preflight requires the signing secret

The `indigodb realtime` daemon MUST refuse to start when any resolved model is both
`@@realtime` and `@@allow` and `INDIGODB_REALTIME_SECRET` is not set.

#### Scenario: Daemon refuses to start without the secret

- GIVEN a schema with a model carrying both `@@realtime` and `@@allow`, and
  `INDIGODB_REALTIME_SECRET` unset
- WHEN the daemon starts
- THEN startup fails with a diagnostic naming the missing environment variable

#### Scenario: Daemon starts normally when no model needs the secret

- GIVEN a schema with no model combining `@@realtime` and `@@allow`, and
  `INDIGODB_REALTIME_SECRET` unset
- WHEN the daemon starts
- THEN startup succeeds

### Requirement: Realtime routes return 503 when the source never started, instead of serving as if live

A host that continues running despite a rejected `RealtimeEngine.start()` (per
`realtime-source-contract`'s non-fatal operator behavior for a host process
such as `indigodb studio`) MUST NOT serve `REALTIME_PATH` (the SSE
subscription route) or `REALTIME_LOG_PATH` (the `GET ?handle&offset` route)
as if the source were live. Both routes MUST respond `503` with a fixed,
non-leaking error body when the realtime source is unavailable for that
process. This closes the gap where `RealtimeEngine.handleRequest` writes
`200` plus a `ready` SSE frame unconditionally, without consulting whether
the engine actually started — a response shape a client cannot distinguish
from a genuinely live stream.

#### Scenario: SSE subscription returns 503 when the source never started

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running (per its own non-fatal policy)
- WHEN a client requests `GET <REALTIME_PATH>?tables=...`
- THEN the response is `503`, not `200`, and no `ready` SSE frame is written

#### Scenario: Log page route returns 503 when the source never started

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running
- WHEN a client requests `GET <REALTIME_LOG_PATH>?handle=...&offset=...`
- THEN the response is `503`, not a paginated log slice

#### Scenario: Non-realtime routes remain unaffected while realtime routes 503

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running, serving both realtime and non-realtime routes (e.g. schema, table,
  and query endpoints)
- WHEN a client requests a non-realtime route
- THEN that route responds exactly as it would with a healthy realtime
  source — this degraded state is scoped to `REALTIME_PATH` and
  `REALTIME_LOG_PATH` only

### Requirement: In-process listeners and `handleLogRequest` forward stored bodies verbatim and never re-widen

For a table with `@@realtime(columns: [...])`, `RealtimeEngine.dispatch()` MUST hand its
in-process `listeners` the `RealtimeEvent`'s `new`/`old` exactly as received from `WalSource`
(already projected) — it MUST NOT re-read or re-derive a wider payload; SSE dispatch never
carries `new`/`old` at all (see the wake-only dispatch requirement above), so this projection
guarantee applies to the in-process listener path and to `handleLogRequest`, not to a live SSE
frame. `handleLogRequest` MUST map `_indigo_realtime_log` rows to `RealtimeEvent`s verbatim,
applying no filtering of its own. Because `handleLogRequest` filters nothing and the log itself
stores only the projected view (`realtime-shape-log`), a replay page is structurally guaranteed
to be exactly as narrow as what an in-process listener saw for the same row: a narrow stored row
cannot produce a wider page, since nothing widens it in between. This is the normative
guarantee; a DB-gated test exercising `GET ?handle&offset` end-to-end is confirmation of it, not
the sole proof. There MUST be no code path, option, or flag that restores a projected-out column
at dispatch (in-process) or replay time.

This requirement is independent of, and stacks with, the existing `@@allow` row-level
scoping on `handleLogRequest`'s buckets: a model may have neither, either, or both of `@@allow`
row filtering and `@@realtime(columns: [...])` column projection active at once.

#### Scenario: In-process listener payload matches the projected log row

- GIVEN a model with `@@realtime(columns: [id, status])` and a `passwordHash` field, and
  an in-process listener registered on `RealtimeEngine`
- WHEN a row change is dispatched
- THEN the listener's `new`/`old` contain only `id` and `status` — identical to what was
  written to `_indigo_realtime_log`

#### Scenario: Replay page is exactly as narrow as the in-process payload (structural guarantee; DB-gated test confirms it)

- GIVEN a model with `@@realtime(columns: [id, status])`, and `handleLogRequest`
  mapping stored log rows to `RealtimeEvent`s with no filtering step of its own
- WHEN a client pages through `GET ?handle&offset` covering that row's change
- THEN the returned event's `new`/`old` values contain only `id` and `status`,
  matching what an in-process listener received at dispatch time — guaranteed by the
  stored row already being narrow, not by any narrowing performed at replay time;
  a `log.mjs`/`endpoint.mjs` DB-gated test that exercises this end-to-end confirms
  the guarantee but is not required for the guarantee to hold

#### Scenario: Column projection and `@@allow` row scoping compose

- GIVEN a model with both `@@allow(read, auth.userId == this.ownerId)` and
  `@@realtime(columns: [id, status])`, where `ownerId` is excluded from `columns`
- WHEN a row change is dispatched
- THEN row-level access is still governed by `buckets` (computed from the full row,
  per `realtime-wal-source`), and the frame's `new`/`old` — for subscribers who pass
  the row-level check — contain only `id` and `status`

### Requirement: `subscribe()`'s row handlers are dormant over SSE; re-enabling them needs handle authentication, not `@@allow`

The generated client's `RealtimeModelDelegate.subscribe()` row handlers (`onInsert`, `onUpdate`,
`onDelete`, `onChange`) receive row data ONLY when fed from an in-process `RealtimeEvent`
listener (e.g. `RealtimeEngine`'s `on("change")`, as the Studio uses it same-process). Fed from
the unauthenticated SSE transport, they MUST NOT fire at all: `dispatch()` never emits `event:
change` over SSE, so `subscribe()`'s SSE-backed handlers have nothing to receive `new`/`old`
from, for any model. This is the deliberate current contract, not a bug or a temporary gap;
re-enabling remote push over SSE requires authenticating `REALTIME_PATH` itself, not widening
`@@allow` — `@@allow` governs row-level read access, not transport authentication, and cannot
close the unauthenticated-origin problem that made dispatch fail-closed in the first place. Row
data for a remote consumer remains reachable only via the handle-authenticated `GET
<REALTIME_LOG_PATH>?handle&offset` route. Column projection (`@@realtime(columns: [...])`) still
narrows `new`/`old` for whichever path a consumer uses to receive row data — the in-process
listener or the authenticated log route — exactly as before this change.

#### Scenario: `subscribe()`'s row handlers do not fire over SSE, for any model

- GIVEN a generated client subscribed to a `@@realtime` model, `@@allow` or not
- WHEN a row changes on that model and the SSE transport dispatches the resulting
  `event: wake` frame
- THEN `onInsert`/`onUpdate`/`onDelete`/`onChange` do not fire from that frame — the
  frame carries no `new`/`old` for `subscribe()` to read

#### Scenario: In-process listener still receives the projected payload

- GIVEN an app embedding `RealtimeEngine` in the same process (e.g. the Studio) and
  registering an `on("change")` listener for a model with `@@realtime(columns: [id, status])`
- WHEN a row changes on that model
- THEN the listener receives the full `RealtimeEvent`, with `new`/`old` narrowed to
  `id` and `status` by column projection — unaffected by SSE's fail-closed dispatch,
  since the listener is not on the wire
