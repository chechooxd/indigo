# Delta for Realtime Live Endpoint

## MODIFIED Requirements

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
