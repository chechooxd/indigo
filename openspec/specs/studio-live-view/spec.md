# Studio Live View Specification

## Purpose

Defines the Table Browser's live-refresh contract: subscribing to the already-embedded,
unauthenticated realtime SSE stream for the active `@@realtime` table, and turning any
`change`/`wake` frame into a debounced, coalesced full refetch of that table's rows. This
capability is explicitly outside the `@@allow`/RLS/handle trust boundary — Studio already
holds a privileged, unscoped DB connection, so its live view matches that posture rather than
simulating an end-user's scoped view. No frame payload is ever read; every trigger produces
the same `fetchTableRows(name)` call already used by the manual Refresh button.

## Requirements

### Requirement: Subscription is scoped to exactly the active realtime-eligible table

The Table Browser MUST open at most one live subscription at a time, for the currently
selected table, and only when that table's `Table.realtime` is `true` and a backend is
connected. It MUST NOT subscribe to any other table, and MUST NOT open a subscription for a
non-`@@realtime` table.

#### Scenario: Selecting a realtime table opens exactly one subscription

- GIVEN a backend is connected and the Table Browser lists a table with `realtime: true`
- WHEN the user selects that table
- THEN exactly one live subscription opens, scoped to that table's name

#### Scenario: Selecting a non-realtime table opens no subscription

- GIVEN a backend is connected and the Table Browser lists a table with `realtime: false`
- WHEN the user selects that table
- THEN no live subscription opens and no live status indicator renders

### Requirement: Both `change` and `wake` frames trigger the same debounced refetch, without reading frame data

On receiving either an `event: change` or an `event: wake` frame for the subscribed table, the
Table Browser MUST treat it purely as a "this table changed" signal and arm a fixed 50ms
trailing debounce before calling the existing `fetchTableRows(name)` and replacing the grid's
records via `updateTableRecords`. The Table Browser MUST NOT read any field off the frame
payload to decide how to update the grid.

#### Scenario: A `change` frame triggers a refetch after the debounce window

- GIVEN a live subscription is active and in `live` status
- WHEN one `event: change` frame arrives for the subscribed table
- THEN no refetch occurs synchronously; `fetchTableRows` runs once the 50ms trailing window
  elapses with no further frame, and the grid is replaced with the returned rows

#### Scenario: A `wake` frame triggers the identical refetch path as a `change` frame

- GIVEN a live subscription is active and in `live` status, on an `@@allow` model that only
  ever emits data-free `wake` frames
- WHEN one `event: wake` frame arrives for the subscribed table
- THEN the same debounced `fetchTableRows` + `updateTableRecords` path runs as for a `change`
  frame, with no frame field read

### Requirement: A burst of frames within the debounce window coalesces to exactly one refetch

Multiple frames (of either kind) arriving for the subscribed table faster than the 50ms
trailing window MUST collapse into exactly one `fetchTableRows` call.

#### Scenario: N frames inside 50ms produce one refetch

- GIVEN a live subscription in `live` status
- WHEN 5 frames arrive for the subscribed table within a 50ms span, each restarting the
  trailing window before it elapses
- THEN exactly one `fetchTableRows` call is issued once the window elapses with no further
  frame

### Requirement: A frame arriving mid-refetch schedules exactly one follow-up refetch

Refetches MUST NOT overlap. If a frame arrives while a previously triggered refetch is still
in flight, the Table Browser MUST schedule exactly one follow-up refetch after the in-flight
one resolves, rather than starting a second concurrent refetch or dropping the new frame.

#### Scenario: A frame mid-flight produces one additional refetch afterward

- GIVEN a debounced refetch has started and not yet resolved
- WHEN another frame arrives for the subscribed table before that refetch resolves
- THEN no second concurrent refetch starts; exactly one additional refetch runs after the
  in-flight refetch completes

### Requirement: A `connecting | live | error` status reflects the subscription lifecycle

The Table Browser MUST expose a status of `connecting` before the SSE connection first opens,
`live` once it is open (including after a reconnect, which MUST also trigger one refetch to
close the replay gap), and `error` on transport failure. The status indicator MUST render only
while a subscription is active (realtime-eligible table, backend connected).

#### Scenario: Status starts connecting and transitions to live

- GIVEN the user selects a realtime-eligible table with a backend connected
- WHEN the subscription is created and its connection opens
- THEN the status reads `connecting` before open and `live` after open

#### Scenario: Reconnect returns to live and refetches

- GIVEN a live subscription that lost its connection and is reconnecting
- WHEN the connection reopens
- THEN the status returns to `live` and exactly one refetch runs to close the replay gap

#### Scenario: Transport failure surfaces as error

- GIVEN an active live subscription
- WHEN the underlying transport reports a failure it cannot recover from
- THEN the status becomes `error`

### Requirement: Switching or leaving the active table tears down the previous subscription

Changing the selected table, or unmounting the Table Browser, MUST close any existing live
subscription before (or as part of) opening a new one. At most one subscription MUST exist at
any time.

#### Scenario: Switching tables closes the old subscription and opens exactly one new one

- GIVEN a live subscription is active for table A
- WHEN the user selects realtime-eligible table B
- THEN the subscription for A closes and exactly one subscription opens for B

#### Scenario: Unmounting the Table Browser closes the subscription

- GIVEN a live subscription is active
- WHEN the Table Browser unmounts
- THEN the subscription closes

### Requirement: The live view is inert, not erroring, when no backend is connected

When no backend is connected (the sample-data fallback path), the Table Browser MUST NOT open
any subscription and MUST NOT render a live status indicator, regardless of whether the
selected sample table would otherwise be realtime-eligible. This MUST behave as a silent
no-op, never as a visible error or a stuck `connecting` state.

#### Scenario: No backend means no subscription and no indicator

- GIVEN no backend is connected (standalone `pnpm dev`, sample data shown)
- WHEN the user selects any table
- THEN no live subscription opens, no status indicator renders, and no error is shown

### Requirement: The live badge reads `error`, never `live`, when realtime is unavailable

The Table Browser's live status MUST NOT read `live` from a response that is
not an actually-open, deliverable stream. When the realtime route responds
`503` (per `realtime-live-endpoint`'s "source never started" behavior), the
subscribing transport MUST treat that response as a connection failure, not
as a successful open, and the Table Browser's status MUST become `error`.
The badge MUST NOT assert `live` over a stream that can never deliver an
event — doing so would misreport a dead stream as healthy.

#### Scenario: Badge reads `error`, not `live`, when the realtime route responds 503

- GIVEN the active table is realtime-eligible and a backend is connected, but
  the host's realtime source never started
- WHEN the Table Browser opens its live subscription and receives a `503`
  response from `REALTIME_PATH`
- THEN the transport does not fire its "connection open" signal, and the
  Table Browser's status becomes `error`, never `live`

#### Scenario: The rest of the Studio remains usable while the badge reports error

- GIVEN the live badge is reporting `error` because the realtime source never
  started
- WHEN the user browses tables, runs queries, or reads documentation
- THEN those non-realtime features behave exactly as they would with a
  healthy realtime source — only the live badge and refresh-on-change
  behavior for the active table are affected
