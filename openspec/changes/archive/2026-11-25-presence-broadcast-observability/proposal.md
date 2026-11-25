# Proposal: Presence, Broadcast, and Realtime Observability

## Intent

`@indigodb/realtime`, `@indigodb/client/realtime`, and `@indigodb/react` deliver WAL-backed
row-change subscriptions (`@@realtime` + `@@allow` + signed-handle log replay). The final open
row on IndigoDB's roadmap adds:

1. **Ephemeral Presence & Broadcast channels**: room-scoped online member state (`track`/
   `untrack` with TTL expiry and disconnect cleanup) and transient pub/sub messages (`broadcast`),
   over IndigoDB's existing dependency-free HTTP + SSE transport — never touching Postgres or
   `_indigo_realtime_log`.
2. **Realtime Observability**: structured operational metrics (`engine.getMetrics()` and
   `GET /api/realtime/metrics`) plus a zero-dependency `onTelemetry` callback so operators can
   monitor active subscribers, dispatched events by table/op, log replay traffic, backpressure
   evictions, channel activity, and errors without exposing secrets or row payloads.

## Scope

### In Scope
- Protocol shapes and route constants in `@indigodb/realtime/protocol` (browser-safe, zero deps):
  `REALTIME_CHANNELS_PATH`, `REALTIME_BROADCAST_PATH`, `REALTIME_PRESENCE_PATH`,
  `REALTIME_METRICS_PATH`, `PresenceMember`, `BroadcastMessage`, `ChannelReady`,
  `RealtimeMetrics`, `RealtimeTelemetryEvent`.
- `RealtimeEngine` server routes (`handleChannelRequest`, `handleBroadcastRequest`,
  `handlePresenceRequest`, `handleMetricsRequest`), mounted by `attach()` and `indigodb realtime`
  daemon, all enforcing D7 `allowedOrigins`, strict identifier validation, 64 KiB JSON body cap,
  backpressure eviction, presence TTL + disconnect cleanup, and optional `authorizeChannel` hook.
- Browser-safe `createChannel()` in `@indigodb/client/realtime` (zero `pg` / Node imports).
- `useChannel()` React hook in `@indigodb/react` over `useSyncExternalStore`.
- Real HTTP integration tests in `@indigodb/realtime`, browser-safety & client tests in
  `@indigodb/client`, and Vitest hook tests in `@indigodb/react`.

### Out of Scope
- Multi-node distributed presence/broadcast clustering (Redis/PG pubsub fan-out across servers).
- WebSocket transport (IndigoDB standardizes on HTTP + SSE).
- Prometheus exposition format or OpenTelemetry SDK dependency (callers bridge via `getMetrics()`
  and `onTelemetry`).
- Any `crates/` change (no `build:wasm` rerun).

## Capabilities

### New Capabilities
- `realtime-presence-broadcast`: ephemeral channel SSE stream, presence tracking with TTL +
  disconnect cleanup, broadcast pub/sub, client `createChannel()`, React `useChannel()`.
- `realtime-observability`: `RealtimeEngine.getMetrics()`, `GET /api/realtime/metrics`, and
  `onTelemetry` structured event hook (secret- and row-payload-free).

## Rollback Plan

Revert branch commits. All new routes, exports, and options are strictly additive; existing
SSE wake-up (`REALTIME_PATH`) and signed-handle log (`REALTIME_LOG_PATH`) contracts are unchanged.
