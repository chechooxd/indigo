# Client Live Queries Specification

## Purpose

Defines `findMany(args).live(handlers?)` on `RealtimeModelDelegate`: a self-refreshing query
that snapshots via `findMany`, then tails `event: wake` to stay current. Generated only for
`@@realtime` + `@@allow` models — the case `.subscribe()` cannot serve, since those models emit
data-free wake frames only. Both the initial snapshot and every refetch run inside
`$authSession`, scoped to the userId claim decoded locally from the handle's payload (readable
without the HMAC secret) — required because `@@allow` RLS policies deny all rows when
`app.user_id` is unset. Covers return shape and `status` lifecycle, snapshot-then-tail
bootstrap, debounced/coalesced refetch, verbatim `findMany(args)` pass-through, the `getHandle`
provider contract with per-table caching and retry-then-error handle-failure semantics, and
teardown/refcount behavior.

## Requirements

### Requirement: `.live()` is generated only for `@@realtime` + `@@allow` models

The generator MUST emit a `.live(handlers?)` method on `RealtimeModelDelegate` only for models
where `table.realtime` is true AND `table.allow` is non-empty. Generated output for
`@@realtime`-only models (no `@@allow`) and for non-`@@realtime` models MUST be byte-identical
to today's output — no `.live()` method present.

#### Scenario: `.live()` present on an `@@allow` + `@@realtime` model

- GIVEN a model with `@@realtime` and a non-empty `@@allow` block
- WHEN the client is generated
- THEN the emitted `RealtimeModelDelegate` for that model exposes a `.live()` method

#### Scenario: `.live()` absent on an `@@realtime`-only model

- GIVEN a model with `@@realtime` and no `@@allow` block
- WHEN the client is generated
- THEN no `.live()` method is emitted, and the rest of the generated output for that model is
  byte-identical to today's output

### Requirement: `.live()` accepts the `findMany(args)` shape verbatim

`.live(args?)` MUST accept exactly the argument shape `findMany` accepts for that model
(`where`/`include`/`select`/`orderBy`/`take`/etc.), with no subsetting and no separate argument
type. Every refetch MUST re-run that exact same `args` object against `findMany`.

#### Scenario: `.live()` preserves `include`/`orderBy`/`take` across refetch

- GIVEN `db.order.findMany({ where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 20, include: { items: true } }).live()`
- WHEN a refetch runs after a wake event
- THEN the refetch issues the identical `where`/`orderBy`/`take`/`include` shape as the initial
  snapshot query

### Requirement: Both the initial snapshot and every refetch run inside `$authSession` scoped to the handle's decoded claim

`.live()` MUST decode the identity claim from the handle it holds for the query's table
before running any read. The handle's payload segment is a base64url-encoded JSON object
(`{v, t, u, exp}`) that is readable locally without the HMAC secret — only signature
verification needs the secret, and `.live()` never verifies the signature itself (that already
happened server-side when the handle was minted/consumed by the app's own endpoint).

`.live()` MUST extract `u` (the userId claim) from the decoded payload and run BOTH the initial
snapshot `findMany(args)` AND every subsequent debounced refetch `findMany(args)` inside
`$authSession({ userId: u })` — never as a bare, unscoped `findMany`. This applies uniformly to
every refetch described elsewhere in this spec (debounced, coalesced, or post-dirty follow-up):
each one MUST re-enter `$authSession({ userId: u })` using the currently cached claim, re-minting
per the handle-failure requirements below if the claim is stale or invalid.

This requirement exists because `@@allow` models are protected by RLS policies of the form
`NULLIF(current_setting('app.user_id', true), '')::integer = "ownerId"`. `app.user_id` is set
only by `$authSession`; a bare `findMany` leaves it unset, so the policy evaluates to `NULL` and
every row is denied unconditionally — `.live()` would silently return an empty result set for
every `@@allow` model, snapshot and refetch alike, with no error signal.

Using the client's own decoded (unverified) claim to scope its own database connection does not
weaken RLS: the Postgres policy still re-evaluates server-side on every query against whatever
value `$authSession` actually sets. A tampered or self-inflicted-wrong `u` value can only narrow
what the client's own database role already has access to view — it cannot grant access beyond
what RLS independently permits, and it is never transmitted anywhere the server would trust it as
an authorization decision. The client already trusts itself enough to hold the `getHandle`
callback and its own database credentials in the first place.

#### Scenario: Snapshot and refetch both scope reads to the handle's claim via `$authSession`

- GIVEN `db.order.findMany(args).live()` on an `@@allow` + `@@realtime` model, with a cached
  handle whose decoded payload has `u: "42"`
- WHEN the initial snapshot runs, and later a wake event triggers a debounced refetch
- THEN both the initial `findMany(args)` and the refetch `findMany(args)` execute inside
  `$authSession({ userId: "42" })`, and both return only rows the RLS policy permits for user 42

#### Scenario: Without `$authSession` scoping, RLS denies all rows

- GIVEN a live query that (incorrectly) ran `findMany(args)` without wrapping it in
  `$authSession`, on a model whose `@@allow` policy checks
  `NULLIF(current_setting('app.user_id', true), '')::integer = "ownerId"`
- WHEN the query executes with `app.user_id` unset
- THEN the policy's `current_setting(...)` comparison evaluates `NULL`, and the query returns
  zero rows regardless of how many rows the underlying table actually contains

### Requirement: Initial snapshot is a plain `findMany`, never the log

`.live()` MUST bootstrap its initial `Row[]` via a normal `findMany(args)` call through the
existing RLS-scoped executor, run inside `$authSession` per the requirement above. It MUST NOT
attempt to reconstruct the initial snapshot from `GET ?handle&offset` log pages, since the log
has no retention guarantee back to table creation.

#### Scenario: Snapshot matches a plain `findMany` under the same identity before any event arrives

- GIVEN `db.order.findMany(args).live()` on an `@@allow` + `@@realtime` model, with decoded
  claim `u`
- WHEN no wake event has yet arrived
- THEN `.live()`'s current `Row[]` equals what `db.order.findMany(args)` would return standalone
  when run inside `$authSession({ userId: u })` for the same identity

### Requirement: `status` lifecycle reflects bootstrap, steady state, and failure

`.live()` MUST expose a `status` of `"connecting"` before the initial snapshot resolves,
`"live"` once the snapshot has resolved and the wake subscription is active, and `"error"`
once handle failure is exhausted (see the handle-failure requirement below). `status` MUST
never revert from `"error"` to `"live"` without caller-initiated teardown and a new `.live()`
call.

#### Scenario: Status transitions from connecting to live

- GIVEN a fresh `.live()` call
- WHEN the initial `findMany` snapshot resolves and the wake subscription is established
- THEN `status` transitions from `"connecting"` to `"live"`

### Requirement: A wake event schedules a fixed 50ms trailing debounce, not an immediate refetch

On receiving `event: wake` for the live query's table, `.live()` MUST arm a fixed 50ms
trailing timer rather than refetching immediately. The 50ms window MUST be an internal
constant; it MUST NOT be exposed as a caller-facing option on `.live()` or on
`RealtimeOptions` in this version.

#### Scenario: A single wake refetches after 50ms, not synchronously

- GIVEN a live query in `"live"` status
- WHEN one `event: wake` arrives for its table
- THEN no refetch occurs synchronously; a refetch occurs once the 50ms trailing window
  elapses with no further wake

### Requirement: A wake burst inside the debounce window coalesces to exactly one refetch

Multiple `event: wake` frames arriving for the same table faster than the 50ms trailing
window MUST collapse into exactly one `findMany` refetch and exactly one listener
notification — never one refetch per wake frame.

#### Scenario: N wakes inside 50ms produce one refetch

- GIVEN a live query in `"live"` status
- WHEN 5 `event: wake` frames arrive for its table within a 50ms span, each restarting the
  trailing window before it elapses
- THEN exactly one `findMany` refetch is issued once the window finally elapses with no
  further wake, and exactly one update is published to listeners

#### Scenario: Wakes separated by more than 50ms each trigger their own refetch

- GIVEN a live query in `"live"` status
- WHEN two `event: wake` frames arrive for its table more than 50ms apart
- THEN two separate refetches occur, one per wake

### Requirement: A wake during an in-flight refetch marks the result dirty for exactly one follow-up refetch

Refetches MUST NOT overlap. If a wake event arrives while a refetch triggered by an earlier
wake is still in flight, `.live()` MUST mark the result dirty and schedule exactly one
follow-up refetch after the in-flight one completes, rather than starting a second concurrent
refetch or dropping the new wake.

#### Scenario: Wake mid-flight produces one additional refetch afterward

- GIVEN a live query whose debounced refetch has started and not yet resolved
- WHEN another `event: wake` arrives for its table before that refetch resolves
- THEN no second concurrent refetch starts; exactly one additional refetch runs after the
  in-flight refetch completes

### Requirement: `getHandle` is cached per table and reused across `.live()` calls

The client MUST cache a minted handle per table, obtained by calling the app-supplied
`realtime.getHandle(table)` at most once per table per validity window. A second `.live()`
call on a table whose handle is already cached and unexpired MUST reuse the cached handle
without calling `getHandle` again.

#### Scenario: Two `.live()` calls on the same table share one `getHandle` call

- GIVEN no cached handle yet exists for table `Order`
- WHEN two separate `.live()` calls are made on `Order` before either handle expires
- THEN `getHandle("Order")` is called exactly once, and both live queries use the same
  minted handle

#### Scenario: A third `.live()` call after expiry triggers exactly one re-mint

- GIVEN a cached handle for table `Order` whose `exp` has passed
- WHEN a third `.live()` call is made on `Order`
- THEN `getHandle("Order")` is called exactly once to re-mint, and the new handle is cached
  for subsequent calls

### Requirement: Handle verification failures trigger re-mint; unverifiable transport failures do not

(Forward-looking contract, refined by incremental-reconciliation slices calling the log endpoint)

`.live()` MUST distinguish a verified handle failure from a transport failure when deciding
whether to invalidate the cached handle and re-mint via `getHandle`.

**In this slice**: handle validity is determined client-side by decoding the handle's payload
and checking structural constraints (`v`, `t`, `u`, `exp`). A decoded token that is malformed,
carries an unsupported `v`, references an unknown `t`, has an empty `u`, or has `exp` in the
past represents a **verified handle failure** — the client can definitively conclude the token
is broken without consulting the server. On a verified handle failure, `.live()` MUST invalidate
the cached handle for that table and re-mint via `getHandle`, per the retry-once-then-`onError`
policy below.

**Future incremental-reconciliation slices** (when `.live()` or a related API calls
`GET ?handle&offset`) will extend this classification: an HTTP `401` from the log endpoint will
also count as a verified handle failure (the endpoint's signature/version/expiry guard), while
other HTTP errors (5xx, 404, 400) and network-level failures will remain transport errors.

The following do **not** count as a verified handle failure in this slice and MUST NOT
invalidate the cached handle or trigger a re-mint:
- A `getHandle()` promise rejection (provider failure, not a property of the token itself) — see
  retry-once-then-`onError` below
- Any failure in the subsequent `findMany` or SSE subscription (transport failures unrelated to
  the handle).

On any transport failure or provider failure (distinct from token verification), `.live()` MUST
retry the same request using the same cached handle (subject to ordinary retry/backoff behavior)
rather than re-minting prematurely.

#### Scenario: Malformed handle payload triggers re-mint

- GIVEN a live query with a minted handle that contains a malformed base64url payload segment
- WHEN `.live()` attempts to decode the payload to extract the `u` claim
- THEN decoding fails (verified handle failure), the cached handle is invalidated, and
  `getHandle` is called to re-mint

#### Scenario: Out-of-date handle version triggers re-mint

- GIVEN a live query with a cached handle whose decoded `v` field is `2` (unsupported)
- WHEN `.live()` checks the handle's version
- THEN the version mismatch is a verified failure, the cached handle is invalidated, and
  `getHandle` is called to re-mint

#### Scenario: Expired handle triggers re-mint

- GIVEN a live query with a cached handle whose decoded `exp` is in the past
- WHEN the next refetch attempts to use that handle
- THEN the expiry is detected (verified failure), the cached handle is invalidated, and
  `getHandle` is called to re-mint

#### Scenario: `getHandle` rejection does not invalidate the handle

- GIVEN a live query with a cached handle for table `Order`
- WHEN `getHandle("Order")` is explicitly called and rejects with an error
- THEN the rejection is a provider failure, not a property of the cached token — see the
  retry-once-then-`onError` requirement for the retry strategy

### Requirement: Handle failure is retried once via `getHandle`, then surfaces as `onError` and `status: "error"`

On a verified handle failure (per the requirement above), `.live()` MUST call `getHandle`
exactly once to re-mint. If that re-mint succeeds, the live query MUST resume normally using
the new handle without invoking `onError`. If the re-mint call itself fails (rejects) or the
newly minted handle also fails verification, `.live()` MUST invoke the optional `onError`
handler, if provided, and set `status` to `"error"`. `.live()` MUST NOT throw into the host
application's event loop at any point in this flow, and MUST NOT retry silently forever.

#### Scenario: getHandle succeeds on retry, query stays live

- GIVEN a verified handle failure on table `Order`
- WHEN `getHandle("Order")` is called and resolves with a new valid handle
- THEN the live query resumes using the new handle, `status` remains `"live"`, and `onError`
  is not invoked

#### Scenario: getHandle fails twice, status becomes error

- GIVEN a verified handle failure on table `Order`, followed by a `getHandle("Order")` retry
  that also fails (rejects, or the newly minted handle also fails verification)
- WHEN the retry is exhausted
- THEN `status` becomes `"error"` and `onError`, if provided, is invoked with a description of
  the failure

#### Scenario: onError absent never throws into the host app

- GIVEN a live query with no `onError` handler provided and a handle-failure retry that is
  exhausted
- WHEN the failure occurs
- THEN `status` becomes `"error"` and no exception propagates into the host application's
  event loop

### Requirement: Teardown releases the shared per-table SSE subscription

Calling a live query's teardown (the returned `Unsubscribe`) MUST decrement the existing
per-table refcount on `RealtimeConnectionManager`. The underlying SSE connection MUST close
only when the last subscriber (across `.live()` and `.subscribe()`) on that table tears down.

#### Scenario: Last `.live()` on a table releases the shared connection

- GIVEN one `.live()` call is the sole subscriber to table `Order`'s SSE connection
- WHEN that live query's teardown is invoked
- THEN the shared SSE connection for `Order` is closed

#### Scenario: Teardown with other subscribers keeps the connection open

- GIVEN two subscribers (e.g. two `.live()` calls, or a `.live()` and a `.subscribe()`) share
  one table's SSE connection
- WHEN one subscriber tears down
- THEN the SSE connection remains open for the remaining subscriber

### Requirement: `.subscribe()` is unaffected; its `@@allow` wake-frame gap is a known, unfixed issue

`.live()` MUST be purely additive. `.subscribe()`'s generated output and runtime behavior MUST
remain byte-identical to today. `.subscribe()` dereferences per-row event fields (e.g. `pk`)
unconditionally and has no handling for `event: wake`; on `@@allow`-protected models it never
receives such fields at all under the wake-only SSE contract. This is a **pre-existing defect
from the prior realtime slice**, is NOT fixed by this change, and remains a known issue for
`@@allow` models — callers on such models MUST use `.live()` instead of `.subscribe()`.

#### Scenario: `.subscribe()` generated output is unchanged

- GIVEN any `@@realtime` model, with or without `@@allow`
- WHEN the client is generated
- THEN `.subscribe()`'s emitted code is byte-identical to the pre-change output

#### Scenario: `.subscribe()` on an `@@allow` model remains a known-broken path, not silently fixed

- GIVEN a model with `@@realtime` and `@@allow`
- WHEN a row changes and only a wake frame is dispatched (per `realtime-live-endpoint`)
- THEN `.subscribe()`'s per-row dispatch logic is unchanged and still does not handle `wake`
  frames — this remains a documented known issue, out of scope for this change

### Requirement: `@indigodb/client` exposes a browser-safe `./realtime` subpath free of `pg` and `node:async_hooks`

`packages/client/package.json` MUST declare an additive `"./realtime"` export subpath mapping
to a build (`dist/realtime.js`) that re-exports `SseTransport`, `RealtimeConnectionManager`,
and the realtime path constants (including `REALTIME_PATH`), and that transitively imports
neither `pg` nor `node:async_hooks`. The existing `.` entry point and its behavior MUST remain
unchanged; this subpath is purely additive.

#### Scenario: `./realtime` subpath resolves and is Node-surface-free

- GIVEN a consumer imports `@indigodb/client/realtime`
- WHEN the module graph reachable from that import is inspected
- THEN it exposes `SseTransport` and `REALTIME_PATH`, and contains no import of `pg` or
  `node:async_hooks`

#### Scenario: The root `.` entry point is unaffected

- GIVEN a consumer imports `@indigodb/client` (the root entry)
- WHEN the generated `IndigoClient` and `ModelDelegate` surface is inspected
- THEN its exports and behavior are byte-identical to before this subpath was added

#### Scenario: A bundler targeting the browser never pulls in `pg`

- GIVEN a frontend app imports only `@indigodb/client/realtime`
- WHEN its production bundle is built
- THEN the bundle contains no `pg` or `node:async_hooks` import
