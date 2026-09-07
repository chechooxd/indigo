# Delta for Studio Live View

## ADDED Requirements

### Requirement: The Table Browser's subscription shares its table's connection through `RealtimeConnectionManager` and reports live without waiting for a reconnect

The Table Browser's live subscription MUST be established through the shared
`RealtimeConnectionManager` (via `createLiveSubscription`) rather than opening a private transport
per instance. If the manager's channel for the selected table is already open when the Table
Browser subscribes (e.g. another consumer already holds a live query on the same table), the
Table Browser's status MUST become `live` immediately, without waiting for the next reconnect.
This retires the prior deliberate bypass of `RealtimeConnectionManager`, which existed only
because the manager swallowed the first `onOpen` (see `client-live-queries`'s connection-sharing
fix); all other observable behavior defined elsewhere in this spec (debounce window, coalescing,
transient-error semantics, and the inert no-backend state) is unchanged.

#### Scenario: Joining an already-open channel from another consumer reports live immediately

- GIVEN another consumer (e.g. a `.live()` query) already holds an open connection for table
  `Order`
- WHEN the Table Browser selects `Order` and opens its subscription
- THEN its status becomes `live` immediately, without waiting for a reconnect event

#### Scenario: Debounce and coalescing behavior is unchanged after re-basing onto the shared connection

- GIVEN the Table Browser's subscription is now built on `createLiveSubscription`
- WHEN a burst of wake frames arrives within the 50ms window
- THEN exactly one `fetchTableRows` refetch occurs, matching the pre-existing debounce/coalesce
  behavior defined elsewhere in this spec
