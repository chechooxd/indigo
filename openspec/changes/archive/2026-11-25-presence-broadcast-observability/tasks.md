# Tasks: Presence, Broadcast, and Realtime Observability

## Phase 1: Protocol & Engine (`@indigodb/realtime` + CLI mount)
- [x] 1.1 Extend `packages/realtime/src/protocol.ts` with channel/presence/broadcast/metrics types and path constants (zero runtime imports).
- [x] 1.2 Implement channel SSE, broadcast POST, presence POST (with TTL + disconnect cleanup + `authorizeChannel`), metrics counters + `getMetrics()` + `handleMetricsRequest` + `onTelemetry` in `packages/realtime/src/engine.ts`, re-export from `packages/realtime/src/index.ts`, and mount routes in `packages/cli/src/index.ts`.
- [x] 1.3 Add `packages/realtime/test/channels-observability.mjs` (wired into `packages/realtime/package.json`) testing all server scenarios over real `node:http`.

## Phase 2: Client SDK & React Hook (`@indigodb/client/realtime` + `@indigodb/react`)
- [x] 2.1 Implement browser-safe `createChannel()` in `packages/client/src/realtime.ts` and add `packages/client/test/channel.mjs` (wired into `packages/client/package.json`).
- [x] 2.2 Implement `useChannel()` in `packages/react/src/use-channel.ts`, export from `packages/react/src/index.ts`, and add `packages/react/test/use-channel.test.tsx`.

## Phase 3: Verification, Archive, Merge
- [x] 3.1 Run `pnpm build && pnpm lint`, `@indigodb/realtime` tests, `@indigodb/client` channel + realtime-entry tests, `@indigodb/react` tests (including `browser-safety.mjs`), and mutation proof on channel origin/authorization gate.
- [x] 3.2 Write `verify-report.md` and `archive-report.md`, merge canonical spec, archive, fast-forward `main`, delete branch, and save to Engram.
