# Archive Report: presence-broadcast-observability

**Date Archived**: 2026-11-25
**Branch**: `presence-broadcast-observability`
**Verdict**: PASS — 4/4 requirements verified across `@indigodb/realtime`, `@indigodb/cli`, `@indigodb/client`, and `@indigodb/react`

## Summary

Completed the final open item on IndigoDB's roadmap:
1. **Ephemeral Presence & Broadcast channels** over plain `node:http` SSE + JSON POST (zero new
   runtime dependencies, never touching PostgreSQL or `_indigo_realtime_log`):
   - `GET /api/realtime/channels?channel=<name>[&clientId=<id>]` (`channel_ready`, `presence_join`,
     `presence_update`, `presence_leave`, `broadcast`).
   - `POST /api/realtime/channels/broadcast` and `POST /api/realtime/channels/presence` (`track` /
     `untrack` with `.unref()`'d TTL expiry and SSE disconnect cleanup).
   - Shared D7 `allowedOrigins` gate, optional `authorizeChannel` hook, strict identifier validation,
     64 KiB body cap, and backpressure eviction.
   - Mounted automatically in `RealtimeEngine.attach()` and `indigodb realtime`.
2. **Structured Realtime Observability**:
   - `RealtimeEngine.getMetrics()`, `GET /api/realtime/metrics` (D7 origin-gated, `no-store`), and
     zero-dependency `onTelemetry` callback carrying counts, tables, ops, channels, and LSNs with
     zero row payloads or secrets.
3. **Browser-safe SDK & React hook**:
   - `createChannel()` in `@indigodb/client/realtime` (imports only `@indigodb/realtime/protocol`).
   - `useChannel()` in `@indigodb/react` built over `useSyncExternalStore` with stable snapshot
     identities.

## Spec Merge

- NEW canonical spec: `openspec/specs/presence-broadcast-observability/spec.md` (4 requirements,
  6 scenarios).
