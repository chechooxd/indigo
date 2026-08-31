# Tasks: Studio Read-Only Mode

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 260-340 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Server: flag/env resolution, prefix gate, status field, log line, integration tests | PR 1 | `node packages/cli/test/studio-readonly.mjs` | `pnpm --filter @indigodb/cli test` (pglite-backed `withStudio` harness) | Revert `studio-server.ts`/`index.ts` changes; unset flag/env is a structural no-op |
| 2 | Frontend: `AuthStatus.readOnly`, store field, `ReadOnlyBanner`, `App.tsx` wiring, i18n copy | PR 1 (same PR — small, tightly coupled to Unit 1's contract) | `pnpm --filter @indigodb/studio test` | N/A — no Studio E2E harness (per design.md Testing Strategy); manually verify banner via `pnpm --filter @indigodb/cli exec node dist/index.js studio --read-only` against a local schema | Revert the 4 frontend files; banner is additive-only, no existing UI is altered |

## Phase 1: Server — Flag & Option Resolution

- [x] 1.1 RED: in `packages/cli/test/studio-readonly.mjs` (new file), assert `StudioOptions.readOnly` defaults to `false`/gate absent when `startStudio` is called with no `readOnly` option — write the control-case test first (spec: "Default preserves existing write behavior").
- [x] 1.2 GREEN: add `readOnly?: boolean` to `StudioOptions` in `packages/cli/src/studio-server.ts`; add `const readOnly = options.readOnly === true;` next to the existing `auth` constant (near line 588), with a doc comment noting the naming collision with `StudioDb.readOnly()` (design.md "Naming note").
- [x] 1.3 In `packages/cli/src/index.ts`, add `.option("--read-only", "…")` (no default) to the `studio` command, following the option's placement near `--host`/`--no-open`.
- [x] 1.4 In the `studio` command's action, after `loadEnv()`, add `const isReadOnlyEnv = (v?: string) => v === "1" || v === "true";` and `const readOnly = options.readOnly === true || isReadOnlyEnv(process.env.INDIGODB_STUDIO_READONLY);`; thread `readOnly` into the `startStudio(...)` call. Add a comment noting the deliberate divergence from `--host`'s module-load-time default (design.md decision).

## Phase 2: Server — Write Gate & Status Field

- [x] 2.1 RED: in `studio-readonly.mjs`, add the three-verb rejection test — `readOnly: true`, POST/PATCH/DELETE `/api/rows/User` each return `403 {error: "Studio is running in read-only mode"}` and the DB row count is unchanged (spec: "All three write verbs are rejected identically from one gate").
- [x] 2.2 RED: add the unrouted-verb test — PUT `/api/rows/User` with `readOnly: true` also returns 403 via the same gate (design.md prefix-bypass adversarial case).
- [x] 2.3 GREEN: in `studio-server.ts`, add the single gate check between the existing auth gate (ends ~line 625) and the routing `try` (line 627): `if (readOnly && path.startsWith("/api/rows/")) { sendJson(res, 403, { error: "Studio is running in read-only mode" }); return; }` — exact message from `specs/studio-readonly-mode/spec.md`.
- [x] 2.4 RED: extend the `GET /api/auth/status` assertions in `studio-readonly.mjs` to check `readOnly` is present and correct; add the compact loop asserting `{authRequired, readOnly}` across the 4 auth×read-only combinations (spec: "readOnly reflects server posture across all auth combinations").
- [x] 2.5 GREEN: in `studio-server.ts`, widen the `/api/auth/status` handler (line 632) to `sendJson(res, 200, { authRequired, authenticated, readOnly });`.
- [x] 2.6 RED: add the read-routes-unaffected test — with `readOnly: true`, `GET /api/schema`, `GET /api/tables/User`, `POST /api/query` all return 200 identical to `readOnly: false` (spec: "Reads succeed unchanged while read-only is active").
- [x] 2.7 GREEN: confirm no changes needed for 2.6 (gate is prefix-scoped to `/api/rows/`); if the test fails, fix the gate's path check, not the read routes.

## Phase 3: Server — Auth Precedence

- [x] 3.1 RED: add the precedence test — password configured, `readOnly: true`, no session cookie, write to `/api/rows/:table` → **401** `{error: "Authentication required"}`, DB unchanged, and assert the read-only gate is never reached (spec: "Unauthenticated write cannot distinguish read-only state").
- [x] 3.2 RED: add the companion test — same server, valid session cookie, same write → **403** with the read-only message (spec: "Authenticated write is refused by the read-only gate").
- [x] 3.3 GREEN: verify gate ordering already satisfies 3.1/3.2 (auth gate at line ~620 runs before the new gate at 2.3); no production change expected — if a test fails, fix ordering, not the auth gate's logic.
- [x] 3.4 GREEN: add the startup log line in `studio-server.ts` (after the existing `Auth:` line, ~line 833) reporting `Read-only: <on/off>` so operators see the mode explicitly (proposal.md risk: "Operators expect read-only to auto-engage").

## Phase 4: Server — Test Wiring

- [x] 4.1 Append `node test/studio-readonly.mjs` to the `test` script chain in `packages/cli/package.json`, after `studio-auth.mjs` (per design.md File Changes).
- [x] 4.2 Run `pnpm --filter @indigodb/cli test` and confirm `studio-write.mjs`, `studio-auth.mjs`, `studio-auth-preflight.mjs` still pass unmodified (spec: "Default preserves existing write behavior").

## Phase 5: Frontend — Status Wiring

- [x] 5.1 In `apps/studio/src/lib/api.ts`, widen the `AuthStatus` interface (line ~42) with `readOnly: boolean`.
- [x] 5.2 In `apps/studio/src/store/useAuthStore.ts`, add `readOnly: boolean` to `AuthState` (default `false`), and set it from `status.readOnly` inside `checkStatus()`.

## Phase 6: Frontend — Banner

- [x] 6.1 Create `apps/studio/src/app/components/ReadOnlyBanner.tsx`: non-dismissible, `role="status"`, styling copied from `SampleDataBanner.tsx` (amber palette, `px-4 py-2 … border-b … text-[11px] … shrink-0`), reading `useAuthStore((s) => s.readOnly)`, rendering nothing when `false`.
- [x] 6.2 Add banner copy keys to `apps/studio/src/i18n/locales/en.json` and `es.json`: "Read-only mode — this Studio instance refuses all writes." (English) with a neutral, professional Spanish equivalent.
- [x] 6.3 In `apps/studio/src/app/App.tsx`, render `<ReadOnlyBanner />` as the first child of `AppShell`'s content column, above `<Header>` — confirm it never renders on `LoginScreen` (spec: "Banner renders when the server reports read-only" / "does not render when read-only is off").
- [x] 6.4 If `apps/studio` has a component test for `SampleDataBanner`-style banners, add an equivalent `vitest` case for `ReadOnlyBanner` (renders on `readOnly: true`, renders nothing on `readOnly: false`); otherwise confirm via `pnpm --filter @indigodb/studio test` that no existing suite regresses.

## Phase 7: Verification & Cleanup

- [x] 7.1 Run `pnpm build`, `pnpm lint`, `pnpm test` from repo root; confirm all four auth×read-only combinations pass end-to-end per `studio-readonly.mjs`.
- [x] 7.2 Manually verify the CLI: `indigodb studio --read-only` prints the `Read-only: on` startup line and refuses a `curl -X POST /api/rows/<table>` with 403 (success criteria checklist in proposal.md). Verified via a direct `startStudio({ readOnly: true, ... })` call over the real HTTP server (no live Postgres available in this sandbox — the PGlite-backed `StudioDb` adapter stands in for `pg.Pool`, exercising the identical code path as the CLI): startup printed `Read-only: on` and a POST to `/api/rows/User` returned `403 {"error":"Studio is running in read-only mode"}`.
- [x] 7.3 Update `apps/studio` and `packages/cli` inline doc comments only where the design calls for them (`StudioOptions.readOnly` doc comment, `--read-only` divergence note) — no other doc/generator changes are in scope.
