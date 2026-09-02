# Tasks: Realtime `start()` Readiness Contract

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~850-950 (prod ~90-130: wal-source ~50, protocol.ts comment ~15, engine.ts ~10, cli/index.ts ~10, studio-server.ts ~20; tests ~750-820: wal-source.mjs +250, source-contract.mjs new ~90, studio-realtime-degraded.mjs new ~110, realtime-fail-fast.mjs new ~40, useLiveTable.test.ts new ~70, parity.mjs +15, dispatch.mjs +25, 3× package.json +2) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Ready-deferred contract on `WalSource`/`PgNotifySource` seam | PR 1 | `node packages/realtime/test/wal-source.mjs && node packages/realtime/test/source-contract.mjs` | N/A — default checkout, no DB | Revert `wal-source.ts`/`protocol.ts`/test files; no other unit depends on internals |
| 2 | Non-fatal Studio start, fail-fast CLI, engine reset, 503 gating | PR 2 | `pnpm --filter @indigodb/cli test && node packages/realtime/test/dispatch.mjs` | PGlite-backed `studio-harness.mjs`, real `spawnSync` of built CLI | Revert `engine.ts`/`cli/index.ts`/`studio-server.ts`; PR1's seam untouched |
| 3 | Studio badge correctness (SLV-1/2) + package.json wiring + RWS-11 discovery | PR 3 | `pnpm --filter @indigodb/studio test` | `INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime test` (separate labelled discovery leg) | Revert `useLiveTable.test.ts`/package.json chains; badge behavior isolated |

## Phase 1: Contract Foundation (PR 1)

- [x] 1.1 RED: `wal-source.mjs` — resolve-timing + first-attempt-rejection cases fail against unmodified source (RSC-1,2,4,5,7,8a,8b,9,10; RWS-1..9), via `Promise.race` sentinel not timeout.
- [x] 1.2 GREEN: `wal-source.ts` — add `private ready: {resolve;reject}|null`, `settleReady(outcome, err?)` that settles then nulls; rewrite `start()` per design (detached `connect()`, `attempt.then(...)` backstop, `attempt.catch(()=>{})` attached AFTER `.then`).
- [x] 1.3 GREEN: `wal-source.ts` — resolve in existing `service.on("start")` handler; reject in `connect()`'s catch immediately after `onError`.
- [x] 1.4 GREEN: `wal-source.ts` — delete dead `else throw err;` (`:319`); rewrite the false fail-fast doc comment (`:178-180`) to state the real contract.
- [x] 1.5 GREEN: `wal-source.ts` — add private `createService()`/`createWriter()` test seams (no interface change).
- [x] 1.6 Verify 1.1's tests now pass; confirm `wal-source.mjs:648` existing A4 backoff suite (RSC-10/RWS-9) is untouched and still green.
- [x] 1.7 RED then GREEN: `protocol.ts` — add normative `start()`/`stop()` doc comment only; add `rg` guard (RSC-11b) asserting the `RealtimeSource` interface body diff is comment-only.
- [x] 1.8 RED then GREEN: `source-contract.mjs` (new) — RSC-6 (`PgNotifySource` first-attempt ECONNREFUSED rejection, no DB), RSC-11a (`prototype.start.length === 2` + frozen method-name list for both classes).
- [x] 1.9 GREEN: `tsc --noEmit` passes, proving no structural widening (RSC-11c).
- [x] 1.10 RED then GREEN: `parity.mjs` — DB-gated resolve-timing assertion on `notifySource.start()` (RSC-3).

## Phase 2: Engine/CLI/Studio Wiring (PR 2)

- [ ] 2.1 GREEN: `engine.ts` — reset `this.started = false` in a catch before rethrowing when `source.start()` rejects.
- [ ] 2.2 RED then GREEN: `dispatch.mjs` — RSC-14 asserts a **second** `engine.start()` genuinely reaches `source.start()` again (not just `started === false`); DESIGN-ONLY-1 asserts resolve arms the heartbeat.
- [ ] 2.3 GREEN: `cli/index.ts` — wrap `engine.start()` in try/catch, `console.error("❌ Realtime failed to start: " + err.message)`, `process.exit(1)` before `server.listen`.
- [ ] 2.4 RED then GREEN: `realtime-fail-fast.mjs` (new) — `spawnSync` built CLI against `postgres://127.0.0.1:1/db`; non-zero exit, stderr has driver error, port not listening (RSC-12).
- [ ] 2.5 GREEN: `studio-server.ts` — non-fatal `try/catch` around `engine.start()` at `:823` (warn, `realtimeAvailable = false`, `engine.stop().catch(()=>{})`, then `listen` as usual).
- [ ] 2.6 GREEN: `studio-server.ts` — gate `REALTIME_PATH` (`:928`) and `REALTIME_LOG_PATH` (`:934`) on `realtimeAvailable`, returning `503 {"error":"Realtime unavailable"}` otherwise.
- [ ] 2.7 RED then GREEN: `studio-realtime-degraded.mjs` (new) — override `withStudio`'s `connectionString` to `postgres://127.0.0.1:1/db`; RSC-13 (schema route 200), EPT-1 (503 + raw body has no `event: ready` frame), EPT-2 (503, no `events`/`offset`/`hasMore` keys).
- [ ] 2.8 RED then GREEN: same file — EPT-3 differential block: identical status/body shape across `/api/schema`, `/api/tables/:name`, `/api/query` on a healthy (non-`@@realtime`) fixture vs the degraded one.

## Phase 3: Studio Badge + Test Wiring (PR 3)

- [ ] 3.1 RED then GREEN: `useLiveTable.test.ts` (new/modify, vitest) — real `SseTransport` over stubbed `fetch` returning 503, abort transport after first `onError` to avoid backoff loop; record every `setStatus` value, assert no transient `'live'` (SLV-1).
- [ ] 3.2 RED then GREEN: same file — with `status === 'error'`, `fetchTableRows` still resolves and `updateTableRecords` still lands rows (SLV-2).
- [ ] 3.3 GREEN: `wal-source.mjs:702` — replace bare `console.log` with `strictEqual(passed, <exact N>, ...)`; do the same in `source-contract.mjs` (RWS-10a).
- [ ] 3.4 GREEN: add `rg` guard asserting neither new/edited readiness file references `INDIGODB_TEST_DATABASE_URL` (RWS-10b).
- [ ] 3.5 Chain `source-contract.mjs` into `packages/realtime/package.json`'s `test` script; chain `studio-realtime-degraded.mjs` + `realtime-fail-fast.mjs` into `packages/cli/package.json`'s `test` script.
- [ ] 3.6 Run the default-checkout leg once with `INDIGODB_TEST_DATABASE_URL` explicitly unset (RWS-10c).
- [ ] 3.7 Discovery: run `INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime test`; confirm `log.mjs`/`resume.mjs`/`parity.mjs` no longer block at `await source.start(...)` (RWS-11) — file any other failure as a follow-up, do not mark green by omission.
- [ ] 3.8 Full verification: `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root.
