# Realtime WAL Source Specification

## Purpose

Defines `WalSource`, a `RealtimeSource` implementation over Postgres logical replication
(`pgoutput`), providing event-shape parity with `PgNotifySource` while closing the
"events lost while disconnected" gap inherent to `LISTEN`/`NOTIFY`.

## Requirements

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

### Requirement: Emitted events are shape-identical to `PgNotifySource`

For insert, update, and delete on a `@@realtime` table, `WalSource` MUST emit a `RealtimeEvent`
with the same fields (`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`) as `PgNotifySource`,
translated from physical table/column names to schema names.

#### Scenario: Insert parity

- GIVEN a row is inserted into a `@@realtime` table
- WHEN both `WalSource` and `PgNotifySource` observe the change
- THEN both emit a `RealtimeEvent` with identical `table`, `op: "insert"`, `pk`, and `new` values

#### Scenario: No `partial: true` truncation

- GIVEN a row whose serialized payload exceeds NOTIFY's 8000-byte limit
- WHEN `WalSource` emits the corresponding event
- THEN the full row is included and `partial` is not set to `true`

### Requirement: Changes are not lost while disconnected

`WalSource` MUST resume from the replication slot's confirmed LSN on reconnect, delivering
every change committed while the source was stopped or disconnected.

#### Scenario: Resume after restart

- GIVEN `WalSource` is stopped and one or more changes are committed on a `@@realtime` table
- WHEN `WalSource` restarts and reconnects to the same slot
- THEN every change committed during the gap is delivered, in commit order

### Requirement: Reconnect uses exponential backoff

On connection loss, `WalSource` MUST retry with the same exponential backoff policy
`PgNotifySource` uses (1s initial, capped at 30s), then resume streaming from the slot.

#### Scenario: Backoff caps at 30s

- GIVEN repeated connection failures
- WHEN `WalSource` retries
- THEN each retry delay increases exponentially and MUST NOT exceed 30 seconds

### Requirement: Unknown tables and malformed messages are dropped, not fatal

`WalSource` MUST silently skip `pgoutput` relation/change messages for tables not present in
its `@@realtime` table map, and MUST drop malformed or undecodable messages via `onError`
without terminating the stream.

#### Scenario: Change on a non-realtime table is ignored

- GIVEN a publication that (by misconfiguration) includes a non-`@@realtime` table
- WHEN a change arrives for that table
- THEN `WalSource` does not emit a `RealtimeEvent` for it and continues streaming

#### Scenario: Malformed message does not crash the stream

- GIVEN an undecodable `pgoutput` message
- WHEN `WalSource` receives it
- THEN `onError` is invoked with a descriptive error and the replication stream continues

### Requirement: `WalSource` is the engine's default source

`packages/realtime/src/engine.ts` MUST construct `WalSource` by default (`source ?? new
WalSource(...)`); `PgNotifySource` MUST remain exported and constructible via
`RealtimeEngineOptions.source`.

#### Scenario: Default engine construction uses WAL

- GIVEN `new RealtimeEngine(options)` with no `options.source` provided
- WHEN the engine starts
- THEN it uses a `WalSource` instance, not `PgNotifySource`

#### Scenario: `PgNotifySource` remains available

- GIVEN `new RealtimeEngine({ ...options, source: new PgNotifySource(...) })`
- WHEN the engine starts
- THEN it uses the explicitly provided `PgNotifySource` instance

### Requirement: Slot name resolution matches the DDL path

`WalSource` MUST resolve the replication slot name identically to
`packages/migrator`/`packages/cli`: the fixed default `indigo_realtime`, overridden by
`INDIGODB_REALTIME_SLOT` when set, validated against Postgres slot-name rules (lowercase
letters, digits, underscores only).

#### Scenario: Default slot name

- GIVEN `INDIGODB_REALTIME_SLOT` is unset
- WHEN `WalSource` connects
- THEN it starts replication on slot `indigo_realtime`

#### Scenario: Override is honored

- GIVEN `INDIGODB_REALTIME_SLOT=tenant_a_realtime`
- WHEN `WalSource` connects
- THEN it starts replication on slot `tenant_a_realtime`

#### Scenario: Invalid override is rejected

- GIVEN `INDIGODB_REALTIME_SLOT=Tenant-A!`
- WHEN `WalSource` resolves the slot name
- THEN construction fails with a diagnostic naming the invalid characters, and no connection
  is attempted

### Requirement: `WalSource` opens a dedicated log-writer connection

`WalSource` MUST open a second, ordinary `pg.Client` connection (distinct from its logical
replication connection, which cannot run DML) to write `_indigo_realtime_log` rows. This
connection MUST be owned by `WalSource` itself, opened alongside the replication connection.

#### Scenario: Second connection opened on start

- GIVEN `WalSource` is constructed and started
- WHEN it establishes its replication stream
- THEN it also holds an open ordinary `pg.Client` connection usable for `INSERT` statements

### Requirement: `RealtimeEvent` carries the commit `lsn`

`RealtimeEvent` (`packages/realtime/src/protocol.ts`) MUST include an optional `lsn` field: the
commit LSN as the `X/Y` hex string Postgres prints for `pg_lsn`. `WalSource` MUST populate `lsn`
on every event it emits. `PgNotifySource` is not required to populate it, since NOTIFY-based
delivery has no commit LSN to surface; this is an additive field and does not break shape parity
for `table`, `op`, `pk`, `new`, `old`, `txid`, or `ts`.

#### Scenario: `WalSource` events carry `lsn`

- GIVEN a row is inserted into a `@@realtime` table
- WHEN `WalSource` emits the corresponding `RealtimeEvent`
- THEN `event.lsn` is set to that transaction's commit LSN, formatted as an `X/Y` hex string

#### Scenario: `PgNotifySource` events omit `lsn`

- GIVEN a row is inserted into a `@@realtime` table observed via `PgNotifySource`
- WHEN `PgNotifySource` emits the corresponding `RealtimeEvent`
- THEN `event.lsn` is not set, and this is not a contract violation

### Requirement: Log write precedes dispatch, which precedes acknowledgment

On `commit`, `WalSource` MUST, in order: (1) write the transaction's buffered row changes to
`_indigo_realtime_log` as one multi-row `INSERT`, (2) dispatch each row to `onEvent`, (3)
acknowledge the commit LSN. If step 1 fails, `WalSource` MUST NOT perform steps 2 or 3, and the
transaction MUST be redelivered on reconnect. This ordering exists because a dispatched-but-unlogged
event is a gap no later reader can fill, whereas a logged-but-undispatched event is recoverable.

#### Scenario: Successful commit follows insert-dispatch-ack order

- GIVEN a transaction commits on a `@@realtime` table with the log-writer connection healthy
- WHEN `WalSource` processes the `commit` message
- THEN the log `INSERT` completes before any `onEvent` call, and `onEvent` calls complete before
  the commit LSN is acknowledged

#### Scenario: Log write failure skips dispatch and ack

- GIVEN the log-writer connection is unavailable when a transaction commits
- WHEN `WalSource` attempts the log `INSERT` and it fails
- THEN no `onEvent` call is made for that transaction and the commit LSN is not acknowledged
