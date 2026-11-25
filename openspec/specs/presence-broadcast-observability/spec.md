# Presence, Broadcast, and Realtime Observability Specification

## Purpose

Adds ephemeral room-scoped Presence & Broadcast channels and structured operational observability
(`getMetrics()`, `GET /api/realtime/metrics`, `onTelemetry`) to `@indigodb/realtime`,
`@indigodb/client/realtime`, and `@indigodb/react`.

## Requirements

### Requirement: Ephemeral Broadcast fan-out on named channels

`RealtimeEngine` MUST expose `handleBroadcastRequest` (`POST /api/realtime/channels/broadcast`)
and `handleChannelRequest` (`GET /api/realtime/channels?channel=<name>`) enforcing D7
`allowedOrigins`, identifier validation, a 64 KiB body cap, and optional `authorizeChannel`.
Broadcasts MUST fan out `event: broadcast` frames to subscribers on that channel only and MUST
NOT touch PostgreSQL or `_indigo_realtime_log`.

#### Scenario: Broadcast fans out to channel subscribers and isolates other channels

- GIVEN subscriber A on channel `room:1` and subscriber B on channel `room:2`
- WHEN a client POSTs `{ channel: "room:1", event: "cursor", payload: { x: 10 } }`
- THEN subscriber A receives `event: broadcast` with `{ channel: "room:1", event: "cursor", payload: { x: 10 } }`,
  subscriber B receives nothing, and the POST returns HTTP 202 with `{ delivered: 1 }`

#### Scenario: Invalid origin, invalid channel name, or oversize body is rejected

- GIVEN an engine with `allowedOrigins: ["https://app.example"]`
- WHEN a request carries a disallowed `Origin` -> HTTP 403
- AND when a POST carries an invalid channel name or body > 64 KiB -> HTTP 400 / 413

### Requirement: Ephemeral Presence tracking with TTL and disconnect cleanup

`RealtimeEngine` MUST expose `handlePresenceRequest` (`POST /api/realtime/channels/presence`)
supporting `action: "track"` and `action: "untrack"`. Subscribers joining a channel MUST receive
the current member list in `event: channel_ready`. Tracking MUST emit `presence_join` (new) or
`presence_update` (existing); untracking, TTL expiry, or closing an SSE connection bound with
`?clientId=<id>` MUST remove the member and emit `presence_leave`.

#### Scenario: Presence track, update, initial snapshot, and disconnect leave

- GIVEN client `u1` connects with `?channel=doc:1&clientId=u1` and tracks `{ cursor: 1 }`
- WHEN client `u2` connects to `doc:1`
- THEN `u2` receives `channel_ready` containing `u1`
- AND when `u1` updates `{ cursor: 2 }`, `u2` receives `presence_update`
- AND when `u1`'s SSE connection closes, `u2` receives `presence_leave` for `u1`

#### Scenario: Presence expires automatically after `presenceTtlMs`

- GIVEN an engine configured with a short `presenceTtlMs` (e.g. 60ms)
- WHEN a client tracks presence without refreshing before TTL elapses
- THEN the member is automatically removed and subscribers receive `presence_leave`

### Requirement: Structured Realtime Observability (`getMetrics`, HTTP metrics, `onTelemetry`)

`RealtimeEngine` MUST expose `getMetrics(): RealtimeMetrics`, `handleMetricsRequest`
(`GET /api/realtime/metrics`, D7 origin-gated, `cache-control: no-store`), and an optional
`onTelemetry` callback. Metrics MUST accurately count active/total/evicted subscribers,
dispatched events by table and op, log requests/sealed/head/401/errors, channel subscribers,
active presence members, broadcasts sent, and errors, and MUST NOT include row payloads or secrets.

#### Scenario: Metrics reflect live engine activity and contain no row payloads or secrets

- GIVEN a running `RealtimeEngine` with SSE subscribers, dispatched row events, log requests,
  presence members, and broadcasts
- WHEN `engine.getMetrics()` and `GET /api/realtime/metrics` are read
- THEN every counter matches the observed activity and the serialized JSON contains neither row
  field values nor `INDIGODB_REALTIME_SECRET`

### Requirement: Browser-safe client `createChannel()` and React `useChannel()`

`@indigodb/client/realtime` MUST export `createChannel()` with zero Node/`pg` imports, and
`@indigodb/react` MUST export `useChannel()` built over `useSyncExternalStore` with stable
snapshot identities.

#### Scenario: `createChannel()` and `useChannel()` stay browser-safe and drive live presence/broadcast

- GIVEN `@indigodb/client/realtime` and `@indigodb/react`
- WHEN `browser-safety` / `realtime-entry` guards run
- THEN zero forbidden Node/`pg` specifiers are reachable
- AND `createChannel()` / `useChannel()` receive `channel_ready`, `presence_join`, `presence_leave`,
  and `broadcast` events cleanly
