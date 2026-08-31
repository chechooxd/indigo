# Tasks: Studio Query Guardrails

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~650-750 (2 test files, 2 src modifications, CLI wiring, 4 frontend files, i18n) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (backend resolvers+enforcement+tests) → PR 2 (frontend disclosure+tests) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Resolvers, preamble, classifier, cursor cap, timeout mapping, status probe, CLI flags | PR 1 | `pnpm test --filter=@indigodb/cli` | `withStudio` PGlite harness (`studio-query-guardrails.mjs`) + injected `StudioDb` double for `57014` | Revert `util.ts`/`studio-server.ts`/`index.ts`/harness diffs; both flags default `0` restores today |
| 2 | Console hint, truncation banner, timeout message, i18n | PR 2 | `pnpm --filter @indigodb/studio test` | Vitest component tests | Revert `apps/studio` diff only; backend unaffected |

## Phase 1: Unit RED — resolvers, preamble, classifier

- [x] 1.1 Create `packages/cli/test/studio-query-resolution.mjs`; test flag > env > default precedence for `resolveQueryTimeoutMs`/`resolveQueryRowCap` (spec: CLI flag precedence, env-var-used scenarios)
- [x] 1.2 Same file: defaults applied when flag and env absent (30000 / 1000) (spec: built-in default scenario)
- [x] 1.3 Same file: `0` accepted as disabled sentinel for both resolvers
- [x] 1.4 Same file: malformed values `"abc"`, `"-1"`, `"1.5"`, `" 100 "`, `""`, `"1e3"`, `"Infinity"` each throw naming the offending flag (spec: negative/non-numeric rejected scenario)
- [x] 1.5 Same file: `readOnlyPreamble(30000)` → `["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = 30000"]`; `readOnlyPreamble(0)` still emits the `0` form
- [x] 1.6 Same file: `isCursorEligible` true for `select`/`with`/`table`/`values` incl. leading comments/`(`/mixed case; false for `EXPLAIN`/`SHOW`

## Phase 2: Unit GREEN

- [x] 2.1 Implement `parseGuardrailInt`, `resolveQueryTimeoutMs`, `resolveQueryRowCap` in `packages/cli/src/util.ts` — pure, throw on malformed, never `process.exit`
- [x] 2.2 Implement exported `readOnlyPreamble(timeoutMs)` and `isCursorEligible(sql)` in `packages/cli/src/studio-server.ts`
- [x] 2.3 Append `studio-query-resolution.mjs` to `packages/cli/package.json`'s `test` chain; confirm Phase 1 tests pass

## Phase 3: Integration RED — `studio-query-guardrails.mjs`

- [x] 3.1 Cap enforced: table with `cap+5` rows → exactly `cap` rows, `truncated: true` (`withStudio(…, { queryRowCap: 5 })`)
- [x] 3.2 Under-cap boundary: exact-`cap` and below → every row, `truncated: false`
- [x] 3.3 Empty result set: `columns` populated, `rows: []`, `truncated: false`
- [x] 3.4 User's own smaller `LIMIT n` respected unchanged: exactly `n` rows, `truncated: false`
- [x] 3.5 `queryRowCap: 0` disables cursor path: response byte-identical to today plus `truncated: false`
- [x] 3.6 `queryTimeoutMs: 0` disables timeout: SELECT that would exceed any positive timeout is not aborted, status reports `queryTimeoutMs: 0` (spec: "value of 0 disables that guardrail" — **not in design's table; adding explicitly**)
- [x] 3.7 Cursor-ineligible statements still 200: `EXPLAIN SELECT 1`, `SHOW server_version`, `TABLE "User"`, `VALUES (1)`
- [x] 3.8 CTE-wrapped DELETE → 400, zero mutation; assert refusal only, never assert SQLSTATE or message text
- [x] 3.9 Multi-statement/empty input still rejected pre-filter before any connection (regression)
- [x] 3.10 `/api/tables/:name` + `ALLOWED_LIMITS` + pagination unchanged with guardrails on (control)
- [x] 3.11 Write routes take no timeout/cap; `db.writable` preamble unchanged (control)
- [x] 3.12 Probe echoes `queryTimeoutMs`/`queryRowCap` exactly as passed to `startStudio` (`{ queryTimeoutMs: 1234, queryRowCap: 7 }`)
- [x] 3.13 `57014` → 400 with exact guidance message, no SQL echoed — inject a `StudioDb` double whose `readOnly` rejects `{ code: "57014" }` (deterministic, not live PGlite timeout)
- [x] 3.14 Slow `GET /api/tables/:name` bounded by same timeout → 4xx naming timeout (spec: "slow table read bounded") — implemented via the same deterministic `StudioDb` double (see Deviations)

## Phase 4: Integration GREEN

- [x] 4.1 Add `queryTimeoutMs`/`queryRowCap` to `StudioOptions`; thread into `createPgDb`, preamble via `readOnlyPreamble` (`studio-server.ts`)
- [x] 4.2 Update `packages/cli/test/studio-harness.mjs` PGlite adapter to call the shared `readOnlyPreamble` (per Open Question: confirmed PGlite ACCEPTS `SET LOCAL statement_timeout` without error but does NOT enforce/abort on it — harness pins timeout to `0` always; see apply-progress)
- [x] 4.3 Implement `/api/query` cursor path: classify via `isCursorEligible`, `DECLARE … CURSOR FOR <sql>` + `FETCH FORWARD cap+1`, slice + `truncated`
- [x] 4.4 Map `57014` to `400` with exact guidance message — implemented in BOTH `/api/query`'s catch AND `/api/tables/:name`'s catch (see Deviations: the spec's normative "statement_timeout is enforced on both read-only routes" requirement and task 3.14 require a named 4xx on the table-read path too, which design.md's narrower "translated on /api/query only" decision did not cover)
- [x] 4.5 Widen `GET /api/auth/status` with `queryTimeoutMs`/`queryRowCap`
- [x] 4.6 Add `--query-timeout`/`--query-row-cap` CLI options in `index.ts`, resolved post-`loadEnv()`, catch resolver throw → print + `process.exit(1)`; thread into `startStudio`
- [x] 4.7 Append `studio-query-guardrails.mjs` to `packages/cli/package.json`'s `test` chain; confirm Phase 3 passes

## Phase 5: Frontend RED

- [ ] 5.1 `useAuthStore.test.ts`: store holds `queryTimeoutMs`/`queryRowCap` from probe; standalone (no backend) falls back without throwing
- [ ] 5.2 `QueryEnginePage` test: persistent cap/timeout hint renders from store
- [ ] 5.3 `QueryEnginePage` test: truncation banner renders only when `truncated: true`
- [ ] 5.4 `QueryEnginePage` test: 4xx timeout response renders a message naming the configured timeout (spec: "timeout error shown with actionable message" — **not in design's table; adding explicitly**)
- [ ] 5.5 Add a static assertion test (grep-style or route-list check) that no cancel button, cancel route, or `pg_cancel_backend` reference exists anywhere in the diff (spec: "No cancel affordance exists" — **not in design's table; adding explicitly**)

## Phase 6: Frontend GREEN

- [ ] 6.1 Widen `AuthStatus`/`QueryResult` types in `apps/studio/src/lib/api.ts`
- [ ] 6.2 Widen `useAuthStore.ts` to hold both guardrail values
- [ ] 6.3 Implement hint + truncation banner + timeout message in `QueryEnginePage.tsx`
- [ ] 6.4 Add hint/banner/timeout copy to `src/i18n/locales/{en,es}.json`
- [ ] 6.5 Confirm Phase 5 tests pass (`pnpm --filter @indigodb/studio test`)

## Phase 7: Verification

- [x] 7.1 (backend-scoped, PR 1) `pnpm build && pnpm lint && pnpm test` clean — verified on this PR's diff; frontend (Phase 5/6) tasks remain for PR 2
- [x] 7.2 Confirm Open Question resolved: PGlite ACCEPTS `SET LOCAL statement_timeout` without error but does NOT enforce it (`pg_sleep(2)` under `statement_timeout = 100` completed uninterrupted); `studio-harness.mjs`'s `readOnly` now pins the preamble's timeout to `0` unconditionally, documented inline and in apply-progress
