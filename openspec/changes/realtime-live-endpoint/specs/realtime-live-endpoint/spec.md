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

#### Scenario: Minted handle round-trips

- GIVEN `mintHandle({table: "Order", userId: "u1", ttl: 3600}, secret)`
- WHEN the resulting token is passed to `verifyHandle(token, secret)`
- THEN verification succeeds and yields `{table: "Order", userId: "u1"}`

#### Scenario: Identity comes only from the verified handle

- GIVEN a valid handle minted for `userId: "u1"`
- WHEN the request is processed
- THEN `app.user_id` is set to `"u1"` from the verified payload, regardless of any other
  identity-shaped value present in the request

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

### Requirement: SSE dispatch is scoped to a data-free wake-up signal for `@@allow`-protected models

For a model carrying an `@@allow` block at all (`ResolvedTable.allow !== undefined`), regardless
of whether that block includes a `read` rule, `RealtimeEngine.dispatch()` MUST send an SSE frame
containing only `{table, op, lsn}` — no `pk`, `new`, or `old`. This is because `computeBuckets`
returns `[]` (deny-all) for an `@@allow` block with no `read` rule, and the real table's RLS
denies every read without a matching policy; scoping only on the presence of a `read` rule would
leave such a model on full-payload SSE while its `GET ?handle&offset` path denies all reads,
reopening the leak the guard exists to prevent. Models without `@@allow` MUST continue to receive
today's full-payload SSE frames, byte-identical to prior behavior.

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
  `GET ?handle&offset`, not by key

#### Scenario: Create-only `@@allow` model still gets wake-up-only SSE

- GIVEN a model with `@@allow(create, true)` and `@@realtime`, and no `read` rule anywhere in
  its `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is still the scoped `{table, op, lsn}` shape, not a full payload
  — because `ResolvedTable.allow !== undefined` for this model, even though `computeBuckets`
  would independently deny all reads via RLS

#### Scenario: Non-`@@allow` realtime model is unaffected

- GIVEN a `@@realtime` model with no `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is byte-identical to the frame shape emitted before this change
  (`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`, `lsn`, `seq` as applicable)

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
