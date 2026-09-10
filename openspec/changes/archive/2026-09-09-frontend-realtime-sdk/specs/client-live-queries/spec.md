# Delta for Client Live Queries

## ADDED Requirements

### Requirement: `RealtimeConnectionManager` replays current channel state to a listener joining an already-open channel

`ChannelListener` MUST gain an `onOpen(reconnected: boolean)` handler. `RealtimeConnectionManager`
MUST track each channel's current open state (not-yet-open / open) and MUST invoke a newly
subscribed listener's `onOpen(false)` at subscribe time when the channel it is joining is already
open, so the listener is not left silent until the next reconnect. `RealtimeConnectionManager`
MUST also invoke every registered listener's `onOpen` on the channel's own transport-level open
(fresh open: `onOpen(false)`; reconnect: `onOpen(true)`), correcting the prior defect where the
first, non-reconnect open was swallowed (`onOpen: (reconnected) => { if (!reconnected) return; ...
}`). This is purely additive: `onResync` semantics are unchanged.

#### Scenario: A listener joining an already-open channel is told it is live without waiting for a reconnect

- GIVEN a channel for table `Order` already open with one existing subscriber
- WHEN a second listener calls `subscribe("Order", listener)`
- THEN `listener.onOpen(false)` is called at subscribe time, before any reconnect occurs

#### Scenario: The first subscriber on a fresh channel now receives its own open signal

- GIVEN no channel exists yet for table `Order`
- WHEN a listener subscribes and the transport's first connect succeeds
- THEN `listener.onOpen(false)` is called for that initial open — it is no longer swallowed

#### Scenario: A genuine reconnect still reports reconnected=true to every listener

- GIVEN a channel for table `Order` with two subscribed listeners, already open
- WHEN the transport disconnects and reconnects
- THEN both listeners' `onOpen(true)` is called, and existing `onResync` behavior is unchanged

#### Scenario: onOpen replay is additive and does not trigger onResync

- GIVEN the existing `onResync` behavior on reconnect
- WHEN a listener joins an already-open channel and receives the state-replay `onOpen(false)`
- THEN `onResync` is not invoked for that join — only a genuine reconnect invokes `onResync`

### Requirement: `.live()` exposes a channel-level `retry()` so a terminal transport error is recoverable

The terminal-error stop introduced for `SseTransport` (`realtime-live-subscription` spec) halts the
retry loop at the **channel** level, and `RealtimeConnectionManager` shares one channel per table
across every consumer of that table. A terminal error raised by any consumer therefore stops the
channel for **all** of them, `.live()` included — which previously retried forever and so had no
recovery path of its own once that loop stopped.

`LiveQuery` MUST therefore gain a `retry(): void`. It MUST delegate to the SAME channel-level
revive path `createLiveSubscription.retry()` uses (`RealtimeConnectionManager.reviveChannel`), so it
revives the table's channel for **every** listener attached to it, not only the calling query. It
MUST be a no-op unless the query is in a transport-error state — a caller MUST NOT be able to close
and reopen a healthy channel — and it MUST be a no-op after `unsubscribe()`. A `.live()` query's
transport-error state is raised by the shared channel's `onError` and lowered by its next successful
`onOpen`; this is deliberately distinct from `LiveQuery.status`, which tracks the data-fetch state
machine (bootstrap/refetch), a different axis. After a successful revive the query MUST resume its
normal snapshot-then-tail behavior: exactly one immediate refetch (events were missed while the
channel was down), then debounced refetches on subsequent wakes.

#### Scenario: A terminal channel error leaves `.live()` stopped and the channel never revives itself

- GIVEN a `.live()` query whose bootstrap snapshot has settled and whose channel is open
- WHEN the channel reports an error classified terminal
- THEN no further connect attempt is made on that channel by itself, and no further refetch occurs

#### Scenario: `retry()` revives the shared channel and resumes snapshot-then-tail

- GIVEN a `.live()` query whose channel was stopped by a terminal error
- WHEN `retry()` is called and the revived connection opens
- THEN the stale connection is closed and a fresh one opened on the same channel
- AND exactly one immediate refetch runs for the revived open
- AND a subsequent wake on the revived channel drives a further debounced refetch

#### Scenario: `retry()` is a no-op on a healthy channel and after `unsubscribe()`

- GIVEN a `.live()` query whose channel is open and has reported no error
- WHEN `retry()` is called
- THEN the channel is neither closed nor reopened
- AND `retry()` called after `unsubscribe()` likewise opens nothing

#### Scenario: A transient error the transport recovers from on its own clears `retry()`'s gate

- GIVEN a `.live()` query whose channel reported an error that was never classified terminal
- WHEN the transport's own backoff reconnects and the channel reports its open
- THEN a later `retry()` is a no-op, because the channel is healthy again
