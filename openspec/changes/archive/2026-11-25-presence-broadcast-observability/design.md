# Design: Presence, Broadcast, and Realtime Observability

## Technical Approach

Extend `RealtimeEngine` additively over plain `node:http` (SSE for downstream fan-out, JSON POST
for upstream broadcast/presence writes, JSON GET for metrics) using the exact same D7 origin gate
and bounded `maxBufferedBytes` write choke point already enforced on `handleRequest`. Keep all
wire shapes in `packages/realtime/src/protocol.ts` (zero runtime imports) so
`@indigodb/client/realtime` and `@indigodb/react` remain 100% browser-safe.

## Architecture Decisions

### Decision 1: HTTP SSE + POST rather than WebSockets

| Option | Tradeoff | Decision |
|---|---|---|
| Add `ws` dependency for WebSockets | New runtime dependency, separate upgrade path, breaks `node:http`-only simplicity | Rejected |
| `GET /api/realtime/channels` (SSE) + `POST /api/realtime/channels/{broadcast,presence}` | Zero new deps, shares D7 origin gate, backpressure choke point, and `fetch()` streaming parser already in `SseTransport` | **Chosen** |

### Decision 2: Security & resource bounds on channel routes

- **D7 origin gate** runs FIRST on every channel/broadcast/presence/metrics request (`403` if
  present `Origin` not in `allowedOrigins`).
- **Optional `authorizeChannel(req, action)` hook** runs before subscribing/tracking/broadcasting
  (`401` on `false`).
- **Strict identifier regex** `/^[A-Za-z0-9_.:-]{1,128}$/` on `channel`, `clientId`, and `event`.
- **Body size cap**: `65_536` bytes (`413 Payload Too Large` on oversize, destroying read loop).
- **Presence TTL & disconnect cleanup**: each tracked member arms an `.unref()`'d timeout
  (`presenceTtlMs`, default `30_000`ms); explicit `untrack` OR closing an SSE connection bound
  with `?clientId=<id>` removes presence immediately and emits `presence_leave`. `engine.stop()`
  clears all timers and channel streams.

### Decision 3: Metrics hygiene — zero row payloads, zero secrets

`RealtimeMetrics` and `RealtimeTelemetryEvent` carry only counts, timestamps, table names, op
names, channel names, and LSNs — never row `new`/`old` values, handles, secrets, or connection
strings. `GET /api/realtime/metrics` serves JSON with `cache-control: no-store`.

### Decision 4: Snapshot stability for React `useSyncExternalStore`

`createChannel().getMembers()` returns a cached immutable array reference that is replaced ONLY
when presence changes (`channel_ready`, `presence_join`, `presence_update`, `presence_leave`),
matching `useLiveTable`'s snapshot-stability invariant so `useChannel()` never tears or
infinite-loops under React 19.

## File Changes

| File | Action |
|---|---|
| `packages/realtime/src/protocol.ts` | Modify — add channel/presence/broadcast/metrics types & path constants |
| `packages/realtime/src/engine.ts` | Modify — add metrics counters, `getMetrics()`, `onTelemetry`, channel/presence/broadcast/metrics HTTP handlers, `attach()` mounting |
| `packages/realtime/src/index.ts` | Modify — export new constants and types |
| `packages/cli/src/index.ts` | Modify — mount new routes in `indigodb realtime` daemon |
| `packages/client/src/realtime.ts` | Modify — add browser-safe `createChannel()` |
| `packages/react/src/use-channel.ts`, `packages/react/src/index.ts` | Create / Modify — add `useChannel()` |
| `packages/realtime/test/channels-observability.mjs`, `packages/realtime/package.json` | Create / Modify — real HTTP server integration tests |
| `packages/client/test/channel.mjs`, `packages/client/package.json` | Create / Modify — client channel SDK tests |
| `packages/react/test/use-channel.test.tsx` | Create — Vitest jsdom React hook tests |
