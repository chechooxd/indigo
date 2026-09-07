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
