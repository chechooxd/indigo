# Realtime SSE Backpressure Specification

## Purpose

Defines bounded per-subscriber write buffering for `RealtimeEngine`'s SSE stream: a
single write choke point, a byte-based watermark cap, an eviction policy that
terminates the stream observably, and heartbeat-driven detection of stalled idle
subscribers. Without this capability, a slow or stalled subscriber's socket buffer
grows in the server process heap with no bound.

## Requirements

### Requirement: All SSE frames route through one bounded write path

`RealtimeEngine` MUST route every frame written to a subscriber's response — heartbeat
ping, `event: ready`, `event: wake`, and `event: change` — through a single write
helper that enforces the buffered-bytes cap. No call site MUST call `res.write()`
directly on a subscriber's response outside that helper.

#### Scenario: Heartbeat is subject to the same cap as data frames

- GIVEN a subscriber whose `res.writableLength` is already above `maxBufferedBytes`
- WHEN the heartbeat timer ticks over that subscriber
- THEN the heartbeat write is evicted via the same path as a `change` frame would be,
  not written unconditionally

### Requirement: `dispatch()` remains synchronous and MUST NOT await drain

`RealtimeEngine.dispatch()` MUST remain synchronous (`void`-returning) and MUST NOT
`await` a socket `drain` event or any other I/O completion before returning. The
bounded write path MUST decide evict-or-write from the pre-write buffer probe alone,
with no asynchronous step in between.

#### Scenario: A stalled subscriber does not delay dispatch to other subscribers

- GIVEN one subscriber's socket is stalled and buffered past the cap
- WHEN `dispatch()` is called for a new event
- THEN `dispatch()` returns without awaiting any I/O, and healthy subscribers receive
  their frame in the same synchronous pass

### Requirement: A write is evicted when the pre-write buffered-byte probe exceeds the cap

Before writing any frame, the bounded write path MUST read the subscriber response's
current buffered-byte level and compare it against `RealtimeEngineOptions.maxBufferedBytes`
(default 1 MiB). If the level is already over the cap, the frame MUST NOT be written and
the subscriber MUST be evicted. If the level is at or under the cap, the frame MUST be
written normally. The probe MUST run before the write, so a single oversized frame
cannot itself evict an otherwise-healthy subscriber.

#### Scenario: Over-cap subscriber is evicted instead of written to

- GIVEN a fake subscriber response reporting a buffered-byte level above
  `maxBufferedBytes`
- WHEN a `change` event dispatches to that subscriber
- THEN the frame is not written, the subscriber is evicted, and a second dispatch to
  the same (now-removed) subscriber writes nothing

#### Scenario: A subscriber at cap minus one byte is not evicted

- GIVEN a fake subscriber response reporting a buffered-byte level of
  `maxBufferedBytes - 1`
- WHEN an event dispatches to that subscriber
- THEN the frame is written and the subscriber remains registered

### Requirement: Eviction during a broadcast MUST NOT disturb the remaining subscribers

Eviction removes an entry from `this.subscribers` while that same collection is being
iterated — both in the heartbeat loop and in `dispatch()`'s fan-out. The bounded write
path MUST guarantee that evicting one subscriber mid-broadcast neither skips nor
double-writes any other subscriber in that same pass, and that every remaining healthy
subscriber still receives the frame. Removal MUST NOT rely on the incidental behavior of
whichever collection type `this.subscribers` happens to be; the iteration-safety strategy
MUST be explicit (iterate a snapshot, defer removal until the pass completes, or an
equivalent guarantee stated in the implementation).

This requirement exists because a broadcast that silently skips a subscriber produces no
error, no dropped connection, and no failing test — the skipped client simply stops
receiving one event while its stream stays open and its UI keeps reading as live. That is
indistinguishable from a healthy idle stream, which is the failure class this capability
exists to prevent.

#### Scenario: A healthy subscriber later in the iteration order still receives the frame

- GIVEN three subscribers to the same table, in registration order A, B, C, where B is
  buffered past the cap and A and C are healthy
- WHEN a change event is dispatched to that table
- THEN B is evicted, and BOTH A and C receive the frame exactly once — C is not skipped
  as a consequence of B's removal during the same pass

#### Scenario: A heartbeat tick that evicts still reaches every remaining subscriber

- GIVEN three subscribers, in registration order A, B, C, where B is buffered past the cap
- WHEN the heartbeat interval fires
- THEN B is evicted, and both A and C receive the heartbeat exactly once in that same tick

### Requirement: Eviction removes the subscriber and terminates its stream

Evicting a subscriber MUST remove it from `RealtimeEngine`'s subscriber registry and
MUST call `res.end()` on its response, so the connection observably closes rather than
going silently idle. Eviction MUST additionally attempt to write a best-effort
`event: overflow` frame before `res.end()`, but that frame's delivery MUST NOT be a
precondition for removal or stream termination — a backed-up socket that cannot flush
it MUST still be removed and terminated.

#### Scenario: Evicted subscriber's connection is closed

- GIVEN a subscriber evicted for exceeding `maxBufferedBytes`
- WHEN eviction runs
- THEN `res.end()` is called on that subscriber's response and it no longer appears in
  the engine's subscriber registry

#### Scenario: Eviction proceeds even if the overflow frame cannot be flushed

- GIVEN a subscriber whose response cannot accept any further writes at all
- WHEN eviction runs
- THEN the subscriber is still removed from the registry and `res.end()` is still
  called, regardless of whether the `event: overflow` frame was flushed

### Requirement: Eviction is reported through the existing error hook

Each eviction MUST report through `RealtimeEngineOptions.onError`, so an operator can
observe and count evictions without inspecting process memory.

#### Scenario: Eviction invokes `onError`

- GIVEN an `onError` callback configured on the engine
- WHEN a subscriber is evicted for exceeding `maxBufferedBytes`
- THEN `onError` is invoked with information identifying the eviction

### Requirement: Raw `subscribe()` consumers are a documented lossy path under eviction

`RealtimeModelDelegate.subscribe()` has no built-in resync on stream termination. This
specification MUST document, not silently omit, that an evicted subscriber using raw
`subscribe()` misses events until the application supplies its own resync logic. This
is a documented limitation, not a guarantee this capability provides.

#### Scenario: Documentation states the raw `subscribe()` gap

- GIVEN this specification
- WHEN a reader checks what happens to a raw `subscribe()` caller after eviction
- THEN the spec states plainly that events are missed with no automatic resync,
  distinguishing it from `.live()` and `useLiveTable`, which both refetch on
  reconnect and are unaffected by eviction

### Requirement: New test coverage for this capability MUST run without a database

Any test asserting backpressure behavior (probe, cap comparison, eviction, heartbeat
coverage) MUST pass with `INDIGODB_TEST_DATABASE_URL` unset, added inside
`packages/realtime/test/dispatch.mjs`'s existing fake-`ServerResponse`/fake-`RealtimeSource`
pattern so it is covered by `scripts/check-realtime-projection-db-gate.mjs`'s fixed file
list. A test that only runs against a live Postgres MUST NOT be the sole coverage for
any scenario in this spec.

#### Scenario: Backpressure suite passes in a default checkout

- GIVEN a fresh checkout with `INDIGODB_TEST_DATABASE_URL` unset
- WHEN `packages/realtime/test/dispatch.mjs` runs
- THEN every backpressure scenario in this spec that has a corresponding test executes
  and passes — none are skipped for lack of a database
