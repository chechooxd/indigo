# Verify Report: presence-broadcast-observability

**Date**: 2026-11-25
**Branch**: `presence-broadcast-observability`
**Verdict**: PASS — archive-ready

## Task Completion

All tasks across Phases 1–3 complete (`tasks.md`).

## Verification Evidence

- **Workspace build & lint**: `pnpm build && pnpm lint` → **exit 0** (11/11 build, 21/21 lint).
- **Realtime engine HTTP integration**: `pnpm --filter @indigodb/realtime test` → **all green**,
  including new `packages/realtime/test/channels-observability.mjs` (5/5 suites over real `node:http`):
  1. Broadcast fan-out & cross-channel isolation (`202 { delivered: 1 }`).
  2. Presence track, `channel_ready` initial snapshot, `presence_update`, and disconnect
     `presence_leave`.
  3. Automatic presence expiry after `presenceTtlMs` with `.unref()`'d timers.
  4. Security gates: D7 `allowedOrigins` (`403`), `authorizeChannel` (`401`), identifier validation
     (`400`), and 64 KiB JSON body cap (`413`).
  5. Live `getMetrics()` + `GET /api/realtime/metrics` (`cache-control: no-store`) counter accuracy
     and zero leakage of row payloads or `INDIGODB_REALTIME_SECRET`, plus `onTelemetry` hook events.
- **Client SDK & browser safety**:
  - `node packages/client/test/channel.mjs` → **all passed** (`createChannel()` SSE/POST lifecycle
    and stable snapshot references).
  - `node packages/client/test/realtime-entry.mjs` → **all passed** (zero `pg` / `node:*` imports in
    browser entry).
- **React hook & browser safety**:
  - `pnpm --filter @indigodb/react test` → **3/3 files, 14/14 tests passed** (including new
    `packages/react/test/use-channel.test.tsx`) + `browser-safety.mjs` **ok**.
- **Mutation proof (origin gate)**:
  - Temporarily mutated the origin check in `handleMetricsRequest` (`packages/realtime/src/engine.ts`)
    and rebuilt: `channels-observability.mjs` failed specifically on `security gates` (`1 failure(s)`).
    Reverted and rebuilt → all 5/5 green again.
