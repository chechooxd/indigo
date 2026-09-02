# Realtime Source Contract Specification

## Purpose

Defines the normative meaning of `RealtimeSource.start()` and `stop()`
(`packages/realtime/src/protocol.ts`) — what "started" guarantees, when the
returned promise settles, and how settlement interacts with the internal
reconnect machinery. Binding on every `RealtimeSource` implementation
(`WalSource`, `PgNotifySource`), so a caller awaiting `start()` gets the same
guarantee regardless of which source `RealtimeEngine` was constructed with.
This capability governs the seam only; it does not change
`RealtimeSource`'s method signatures.

## Requirements

### Requirement: `start()` resolves once the stream is confirmed live

`RealtimeSource.start()` MUST resolve once the underlying stream is confirmed
live — the point at which the source is actually receiving change
notifications, not merely attempting to — and MUST NOT wait for the stream to
end. "Confirmed live" means: Postgres has acknowledged `START_REPLICATION`
for a logical-replication source, or `LISTEN` has succeeded for a
notification-based source. Because it does not wait for stream end, on a
healthy connection `start()` MUST resolve within a bounded time and MUST NOT
remain pending for the lifetime of the stream.

#### Scenario: `start()` resolves promptly on a healthy stream, not at stream end

- GIVEN a `RealtimeSource` implementation constructed against a reachable
  Postgres with the required replication slot or channel already provisioned
- WHEN `start(onEvent, onError)` is called and the stream becomes live
- THEN the returned promise resolves within a bounded time, and specifically
  does not remain pending while the stream continues to run

#### Scenario: `WalSource` satisfies the seam's resolve-timing requirement

- GIVEN a `WalSource` instance connected to an existing replication slot
- WHEN Postgres acknowledges `START_REPLICATION`
- THEN `start()`'s promise resolves at that point, not when the replication
  stream later ends

#### Scenario: `PgNotifySource` satisfies the seam's resolve-timing requirement

- GIVEN a `PgNotifySource` instance connected to a reachable Postgres
- WHEN `client.connect()` and `client.query('LISTEN ...')` both succeed
- THEN `start()`'s promise resolves at that point

### Requirement: `start()` rejects on a first-attempt connect failure

`RealtimeSource.start()` MUST reject when the stream never becomes live
during the first connection attempt it makes — including a missing
replication slot, an authentication failure, or any other error surfaced
while establishing that first attempt. The rejection MUST carry the
underlying Postgres error (or an `Error` wrapping it), not a generic or
substituted message.

#### Scenario: Missing replication slot rejects `start()`

- GIVEN a `WalSource` configured to replicate from a slot that does not exist
- WHEN `start(onEvent, onError)` is called
- THEN the returned promise rejects, and the rejection's error carries the
  underlying Postgres error reporting the missing slot

#### Scenario: Authentication failure rejects `start()`

- GIVEN a `RealtimeSource` implementation configured with connection
  credentials Postgres rejects
- WHEN `start(onEvent, onError)` is called
- THEN the returned promise rejects, and the rejection's error carries the
  underlying Postgres authentication error

#### Scenario: `PgNotifySource` rejects on a first-attempt connect failure

- GIVEN a `PgNotifySource` instance configured against an unreachable Postgres
- WHEN `start(onEvent, onError)` is called
- THEN the returned promise rejects with the underlying connection error

### Requirement: Settlement is scoped to the first connection attempt only

Once `start()`'s returned promise has settled (resolved or rejected), no
later reconnect attempt driven by the source's own backoff/retry machinery
MUST resolve or reject it again. Reconnect failures and reconnect successes
that occur after `start()` has already settled MUST be reported only through
the `onError` callback (on failure) or through resumed event delivery (on
success) — never by re-settling the `start()` promise, which has no further
effect once settled.

#### Scenario: A reconnect failure after a successful start does not reject `start()`

- GIVEN `start()` has already resolved because the stream was confirmed live
- WHEN the connection is later lost and a subsequent reconnect attempt fails
- THEN the already-resolved `start()` promise is not rejected, and the
  failure is reported only via `onError`

#### Scenario: A reconnect success after a successful start does not re-resolve `start()`

- GIVEN `start()` has already resolved because the stream was confirmed live
- WHEN the connection is later lost and a subsequent reconnect attempt
  succeeds in re-establishing the stream
- THEN the already-resolved `start()` promise is not resolved again — it has
  already settled exactly once — and event delivery simply resumes

#### Scenario: A reconnect success after a first-attempt rejection does not re-settle `start()`

- GIVEN `start()`'s first connection attempt failed and its promise already
  rejected, and the implementation's own retry path scheduled a later
  reconnect attempt because the source was not stopped
- WHEN that later reconnect attempt subsequently succeeds in establishing the
  stream
- THEN the already-rejected `start()` promise is not resolved by that later
  success — it has already settled exactly once, as a rejection — and event
  delivery simply begins from that point without ever re-settling `start()`

### Requirement: `stop()` called before the stream goes live rejects the pending `start()`

If `stop()` is called while `start()`'s first connection attempt has not yet
confirmed the stream live, `start()`'s promise MUST reject — a stopped
source is not a live one, so resolving it is not an option — and MUST NOT be
left pending indefinitely. Every exit path of the first connection attempt
(an early "already stopped" check, any supersession check, the catch
path, or normal completion) MUST either settle the deferred directly or be
covered by a backstop that settles it once the attempt itself has settled,
so `start()` is guaranteed to settle exactly once no matter which exit path
fires first. No connection resources opened by that attempt MUST be left
open once `stop()` has returned. The source's existing supersession and
orphaned-resource guards in its reconnect/connect path apply unchanged to
this case.

#### Scenario: `stop()` called before the stream goes live rejects `start()` and tears down resources

- GIVEN `start()` has been called and its first connection attempt has not
  yet confirmed the stream live
- WHEN `stop()` is called before that attempt completes
- THEN the `start()` promise rejects rather than remaining pending, and any
  connection resources opened by the in-flight attempt are closed with none
  remaining open once `stop()`'s promise resolves

#### Scenario: `start()` never remains pending forever, by construction

- GIVEN any implementation conforming to this contract
- WHEN `start()`'s first connection attempt is stopped, superseded, or fails
  before confirming the stream live
- THEN `start()`'s promise always settles — every exit path of the first
  attempt either settles it directly or is caught by a backstop — so a
  caller awaiting `start()` can never hang indefinitely

### Requirement: Reconnect machinery is unaffected by this contract

Implementing this contract MUST NOT change the behavior of an implementation's
existing reconnect bookkeeping: supersession checks that detect a superseded
connection attempt, guards against orphaned sockets from a `stop()` racing an
in-flight connect, and exponential-backoff retry scheduling all continue to
behave exactly as before this capability was introduced. This contract only
governs when `start()`'s own promise settles, not the internal machinery that
keeps a stream alive across reconnects.

#### Scenario: Backoff-driven reconnect scheduling is unchanged

- GIVEN a `RealtimeSource` implementation whose connection is lost after a
  successful `start()`
- WHEN it retries the connection
- THEN it retries using the same exponential-backoff policy it used before
  this capability was introduced

#### Scenario: No `RealtimeSource` signature change

- GIVEN `packages/realtime/src/protocol.ts`'s `RealtimeSource` interface
- WHEN this contract is implemented
- THEN `start(onEvent, onError): Promise<void>` and `stop(): Promise<void>`
  keep their exact existing signatures — this contract is documented as a
  comment, not a type change

### Requirement: Operators observe a rejected `start()` distinctly per consumer

Different `RealtimeSource` consumers MAY react differently to a rejected
`start()`, provided the rejection itself always carries the underlying error
per the requirement above. A standalone daemon process that has no purpose
without a live stream MAY treat the rejection as fatal; a host process that
serves unrelated functionality MAY treat it as non-fatal and continue without
realtime.

#### Scenario: Standalone daemon exits non-zero on a rejected `start()`

- GIVEN the `indigodb realtime` CLI command constructs a `RealtimeEngine` and
  awaits `engine.start()`
- WHEN the underlying `RealtimeSource.start()` rejects
- THEN the process exits with a non-zero status code and the underlying
  Postgres error is surfaced to the operator

#### Scenario: Studio server binds its port despite a rejected `start()`

- GIVEN `indigodb studio` constructs a `RealtimeEngine` and awaits
  `engine.start()` before calling `listen()`
- WHEN the underlying `RealtimeSource.start()` rejects
- THEN the rejection is logged as a diagnostic, the HTTP server still binds
  its port, and realtime functionality is unavailable for that process
  rather than the whole server failing to start

### Requirement: A rejected `RealtimeEngine.start()` leaves the engine restartable

`RealtimeEngine.start()` MUST NOT leave the engine in a permanently "started"
state when the underlying `RealtimeSource.start()` rejects. Marking the
engine as started MUST be undone before the rejection propagates to the
caller, so that a consumer which catches the rejection and later attempts to
start the engine again (e.g. after an operator fixes the underlying cause)
is not permanently blocked by internal state left over from the failed
attempt.

#### Scenario: A rejected `engine.start()` resets the engine's started state

- GIVEN a `RealtimeEngine` whose configured `RealtimeSource.start()` rejects
  on its first attempt
- WHEN `engine.start()` is called and the rejection propagates
- THEN the engine's internal started state reflects "not started", not
  "started" — a caller catching the rejection and calling `engine.start()`
  again is not blocked by leftover state from the failed attempt
