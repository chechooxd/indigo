# Delta for Realtime WAL Source

## MODIFIED Requirements

### Requirement: `WalSource` implements the `RealtimeSource` contract

`WalSource` MUST implement `packages/realtime/src/protocol.ts`'s `RealtimeSource`
interface (`start(onEvent, onError)` / `stop()`) with no changes to that interface,
and MUST conform to the seam-level resolve/reject timing contract defined by
`realtime-source-contract`: `start()` resolves once Postgres acknowledges
`START_REPLICATION` (the stream is confirmed live), not when the replication
stream ends; `start()` rejects on a first-attempt connect failure, carrying the
underlying Postgres error; that settlement is scoped to the first connection
attempt `start()` itself issues and is never re-triggered by a later
`scheduleReconnect()`-driven attempt.
(Previously: this requirement was silent on resolve/reject timing — it required
only interface conformance, not settlement semantics. `start()` resolved only
when the replication stream ended, which meant it never settled on a healthy
stream.)

#### Scenario: Drop-in construction

- GIVEN a `ResolvedSchema` with at least one `@@realtime` model
- WHEN `new WalSource(resolvedSchema, connectionOptions)` is constructed
- THEN it exposes the same `start`/`stop` surface `PgNotifySource` exposes, with no
  interface changes

#### Scenario: `start()` resolves once the stream is confirmed live, not at stream end

- GIVEN `WalSource` is constructed against a replication slot that exists on a
  reachable Postgres
- WHEN `start(onEvent, onError)` is called and Postgres acknowledges
  `START_REPLICATION`
- THEN the returned promise resolves at that point, and specifically does not
  remain pending for the lifetime of the (open-ended) replication stream

#### Scenario: `start()` rejects on a missing replication slot

- GIVEN `WalSource` is configured to replicate from a slot that does not exist
- WHEN `start(onEvent, onError)` is called
- THEN the returned promise rejects, and the rejection's error is (or wraps)
  the underlying Postgres error reporting the missing slot

#### Scenario: `start()` rejects on an authentication failure

- GIVEN `WalSource` is configured with connection credentials Postgres rejects
- WHEN `start(onEvent, onError)` is called
- THEN the returned promise rejects, and the rejection's error is (or wraps)
  the underlying Postgres authentication error

#### Scenario: A later reconnect failure does not reject the already-settled `start()`

- GIVEN `start()` has already resolved because `START_REPLICATION` was
  acknowledged
- WHEN the connection is subsequently lost and a `scheduleReconnect()`-driven
  reconnect attempt itself fails
- THEN the already-resolved `start()` promise is not rejected by that failure;
  it is reported only via `onError`

#### Scenario: A later reconnect success does not re-resolve the already-settled `start()`

- GIVEN `start()` has already resolved because `START_REPLICATION` was
  acknowledged
- WHEN the connection is subsequently lost and a `scheduleReconnect()`-driven
  reconnect attempt succeeds in re-establishing the stream
- THEN the already-resolved `start()` promise is not resolved a second time —
  it has already settled exactly once — and event delivery simply resumes

#### Scenario: A reconnect success after a first-attempt rejection does not re-settle `start()`

- GIVEN `start()`'s first `connect()` attempt failed (e.g. on a missing slot)
  and its promise already rejected, and that same catch path scheduled a
  reconnect because the source was not stopped
- WHEN a later `scheduleReconnect()`-driven attempt subsequently succeeds and
  Postgres acknowledges `START_REPLICATION`
- THEN the already-rejected `start()` promise is not resolved by that later
  success — it has already settled exactly once, as a rejection — and event
  delivery simply begins from that point without ever re-settling `start()`

#### Scenario: `stop()` called before the stream goes live rejects `start()` and tears down the in-flight attempt

- GIVEN `start()` has been called and Postgres has not yet acknowledged
  `START_REPLICATION` for the first connection attempt
- WHEN `stop()` is called before that acknowledgment arrives
- THEN the `start()` promise rejects rather than remaining pending — a
  stopped source is not a live one — and the replication service and any
  log-writer connection opened by that in-flight attempt are closed, with
  neither remaining open once `stop()`'s promise resolves

#### Scenario: `start()` always settles, whichever exit path the first `connect()` takes

- GIVEN `start()`'s first `connect()` attempt can exit via an early
  `stopped` check, either supersession check, its catch block, or normal
  completion
- WHEN any one of those exit paths is taken before the stream is confirmed
  live
- THEN `start()`'s promise settles (resolves or rejects) through either that
  path's own settlement or a backstop that settles it once the attempt
  itself has settled — `start()` never remains pending indefinitely

## ADDED Requirements

### Requirement: `connect()`'s existing reconnect machinery is unchanged by this contract

Implementing the resolve/reject settlement described above MUST NOT alter the
behavior of `connect()`'s existing internals: the `subscribe()` await itself,
both supersession checks (the writer-connect race and the
post-`subscribe()` race against a concurrent `stop()`/newer `connect()`), the
orphaned-socket guard that closes a fully-subscribed but no-longer-referenced
replication socket, and `scheduleReconnect()`'s exponential-backoff policy.
The ready-deferred mechanism that resolves/rejects `start()` MUST be additive
wiring layered on top of this machinery, not a replacement for any part of it.

#### Scenario: Supersession and orphaned-socket guards still fire

- GIVEN a `connect()` attempt is superseded by a newer `connect()` call, or by
  a `stop()` that lands after `subscribe()` resolves but before this attempt's
  post-subscribe check runs
- WHEN that attempt reaches its supersession check
- THEN it closes the writer and/or replication service it opened and returns,
  exactly as before this capability was introduced

#### Scenario: Backoff policy is unchanged

- GIVEN `WalSource`'s connection is lost after a successful `start()`
- WHEN it schedules a reconnect
- THEN the retry delay follows the same exponential-backoff policy (1s
  initial, capped at 30s) used before this capability was introduced

### Requirement: New readiness-timing coverage runs without a database

Unit tests covering `start()`'s resolve timing, reject timing, and
first-attempt-only settlement scoping MUST run in a default checkout with
`INDIGODB_TEST_DATABASE_URL` unset, using a fake/injected transport in the
same style `packages/realtime/test/dispatch.mjs` uses for its fake source —
not a real Postgres connection.

#### Scenario: Readiness tests pass without `INDIGODB_TEST_DATABASE_URL`

- GIVEN a default checkout with `INDIGODB_TEST_DATABASE_URL` unset
- WHEN `packages/realtime/test/wal-source.mjs` runs
- THEN the tests covering `start()`'s resolve timing, reject timing, and
  first-attempt-only settlement scoping execute and pass, without connecting
  to a real Postgres

#### Scenario: DB-gated suites that previously hung no longer hang at `start()`

- GIVEN `INDIGODB_TEST_DATABASE_URL` is set to a reachable Postgres with
  logical replication enabled
- WHEN `packages/realtime/test/parity.mjs`, `resume.mjs`, or `log.mjs` call
  `source.start(...)` against an existing slot
- THEN `start()`'s promise settles once the stream is confirmed live rather
  than remaining pending indefinitely — this requirement asserts that the
  blocking behavior is removed, not that these suites' assertions pass, since
  none of the three has previously run to completion
