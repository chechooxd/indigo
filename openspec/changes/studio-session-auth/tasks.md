# Tasks: Studio Session Auth

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~550-700 (new crypto module ~90, server routes/middleware ~120, CLI preflight ~40, frontend screen+store+wiring ~120, backend test file ~200, frontend tests ~80) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (backend auth core) -> PR 2 (CLI preflight + backend tests) -> PR 3 (frontend gate + frontend tests) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (user decision required before apply) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `studio-auth.ts` + server middleware + 3 routes, zero-config no-op preserved | PR 1 | `node packages/cli/test/studio-auth.mjs` (mint/verify unit slice) | N/A yet — routes wired but full harness coverage lands in PR 2 | Revert `studio-auth.ts` + the middleware/route hunks in `studio-server.ts`; server behaves as pre-change |
| 2 | CLI non-loopback preflight + full `studio-harness.mjs`-backed integration/regression suite | PR 2 | `node packages/cli/test/studio-auth.mjs && node packages/cli/test/preflight.mjs` | `packages/cli/test/studio-harness.mjs` (PGlite-backed, real `startStudio` + real fetch) | Revert `util.ts`/`index.ts` preflight hunk; PR 1's routes remain but preflight silently allows any `--host` again |
| 3 | Frontend login gate, status probe, store, logout affordance, frontend tests | PR 3 | `pnpm test --filter=@indigodb/studio` | N/A — Vite/Vitest component tests are the runtime harness for this unit | Revert `apps/studio` hunks; backend auth still functions via direct API calls |

## Phase 1: Backend Auth Core (PR 1)

- [x] 1.1 RED: `packages/cli/test/studio-auth.mjs` — mint/verify round-trip accepts a freshly minted cookie.
- [x] 1.2 RED: same file — tampered payload, tampered signature, truncated cookie, wrong `v` field, expired `exp`, and a cookie signed with a foreign/old secret all reject.
- [x] 1.3 RED: same file — changing the password changes the derived secret (old cookie rejected under new secret).
- [x] 1.4 GREEN: create `packages/cli/src/studio-auth.ts` — `deriveSessionSecret(password)` via `createHmac("sha256", password).update("indigodb-studio-session-v1").digest("hex")`.
- [x] 1.5 GREEN: same file — `mintSession()`/`verifySession(cookieHeader)` using `{v:1, iat, exp}` JSON -> base64url, signed exactly as `packages/realtime/src/handle.ts`'s payloadText-exact signing; `SESSION_TTL_SECONDS = 86400`; `SESSION_COOKIE = "indigodb_studio_session"`.
- [x] 1.6 GREEN: same file — `createStudioAuth(password)` exposing `mint()`, `verify(cookieHeader)`, `check(password)` (timingSafeEqual over sha256 digests of both strings, equal-length comparison), `cookieHeader(value, maxAge)` with `HttpOnly; SameSite=Strict; Path=/` (no `Secure`).
- [x] 1.7 Add `StudioOptions.password` to `packages/cli/src/studio-server.ts`; compute `const auth = password ? createStudioAuth(password) : null` once at `startStudio` startup (structural no-op path, not a per-request conditional).
- [x] 1.8 Add auth middleware in `createServer`'s request handler, placed immediately after `validateHeaders()`, before routing; applies only to `/api/*` paths; falls through unauthenticated for the static SPA shell always.
- [x] 1.9 Add `GET /api/auth/status` route (always ungated) returning `{authRequired, authenticated}`.
- [x] 1.10 Add `POST /api/auth/login` route: `check(password)` via timingSafeEqual; success sets the signed session cookie (200 `{ok:true}`); failure returns 401 `{error:"Invalid password"}` — identical body whether wrong password or auth unconfigured.
- [x] 1.11 Add `POST /api/auth/logout` route: 200 + `Set-Cookie` with `Max-Age=0`.
- [x] 1.12 Add a startup console line stating whether auth is configured (mirrors existing startup logging pattern).

## Phase 2: CLI Preflight + Backend Test Coverage (PR 2)

- [x] 2.1 RED: extend/create `packages/cli/test/preflight.mjs` mirroring `realtime-secret-preflight.mjs`'s exit-code-stub pattern — non-loopback host + no password -> stubbed `process.exit(1)` called with the message naming `INDIGODB_STUDIO_PASSWORD`. (Implemented as a new sibling file `packages/cli/test/studio-auth-preflight.mjs` rather than extending `preflight.mjs`, since that existing file is a dedicated `assertLogicalReplication` suite unrelated to this check — same naming convention as `realtime-secret-preflight.mjs` beside the generic `preflight.mjs`.)
- [x] 2.2 RED: same file — loopback + no password -> no exit call (starts fine); non-loopback + password set -> no exit call (starts fine).
- [x] 2.3 GREEN: add `assertStudioAuthForHost(host, password)` to `packages/cli/src/util.ts`, parallel to `assertRealtimeSecretPresent` (console.error + `process.exit(1)`); exact message per design ("--host ... binds the Studio beyond loopback...").
- [x] 2.4 GREEN: call `assertStudioAuthForHost` in the `studio` command action in `packages/cli/src/index.ts` before `startStudio` is invoked; pass `password` through to `startStudio`.
- [x] 2.5 RED: `packages/cli/test/studio-auth.mjs` (or a new integration section) via `studio-harness.mjs` — zero-config passthrough: `withStudio` without a password option leaves `/api/schema`, `/api/tables/:t`, `/api/query`, and rows POST/PATCH/DELETE unchanged, no `Set-Cookie` ever issued, `GET /api/auth/status` reports `authRequired:false`. (Already fully covered by PR 1's `studio-auth.mjs` — verified by reading the file in full; no gap, nothing added to avoid duplicating coverage.)
- [x] 2.6 RED: same file — auth-required flow: unauthenticated request to any `/api/*` route (including a rows write) -> 401; wrong password -> 401 generic message; correct login -> cookie issued -> same routes 200 with cookie; logout -> subsequent request without fresh cookie -> 401; hand-minted expired cookie -> 401; static SPA shell route still returns 200 with no session. (Already fully covered by PR 1's `studio-auth.mjs` — verified by reading the file in full; every sub-case listed here has a matching `check(...)` already in place.)
- [x] 2.7 GREEN: wire any harness-side plumbing needed so `startStudio`'s injectable `options.password` flows through `studio-harness.mjs`'s existing options-spreading pattern (confirm zero harness modification needed, per design). (Confirmed: `withStudio(db, fixture, fn, options)` already spreads `...options` into the `startStudio` call, so `{ password }` flows through untouched — zero harness changes made.)
- [x] 2.8 Verify `packages/cli/test/studio-write.mjs` and `packages/cli/test/studio-pagination.mjs` pass unmodified (no password option constructed by either). (Confirmed via `rg password` on both files — no matches — and both pass in the full `pnpm test` run.)

## Phase 3: Frontend Login Gate (PR 3)

- [ ] 3.1 RED: `apps/studio` test — login screen renders when `GET /api/auth/status` reports `authRequired:true, authenticated:false`.
- [ ] 3.2 RED: same suite — app shell renders directly when status probe reports `authRequired:false`.
- [ ] 3.3 RED: same suite — successful login (`POST /api/auth/login`) transitions from login screen to app shell.
- [ ] 3.4 RED: same suite — failed login shows an inline "Invalid password" error and stays on the login screen (no timing/content hints).
- [ ] 3.5 RED: same suite — logout affordance calls `POST /api/auth/logout` and returns to the login screen.
- [ ] 3.6 GREEN: create `apps/studio/src/store/useAuthStore.ts` (Zustand) holding `authRequired`/`authenticated` state and actions calling the three auth routes.
- [ ] 3.7 GREEN: create `apps/studio/src/features/auth/LoginScreen.tsx` — password input, submit -> login action, error display on failure.
- [ ] 3.8 GREEN: modify `apps/studio/src/app/App.tsx` — on load call `GET /api/auth/status` via the store; conditionally render `LoginScreen` instead of the normal app shell (Zustand tab-state gate, no react-router in this app).
- [ ] 3.9 GREEN: modify `apps/studio/src/lib/api.ts` — treat a 401 on any `/api/*` call as a backstop trigger back to the login screen (mid-session expiry), while the primary detection stays the startup status probe.
- [ ] 3.10 GREEN: add a logout affordance in the existing settings page (alongside the Safe Updates toggle) calling the logout action and re-rendering `LoginScreen`.

## Phase 4: Cleanup / Documentation

- [ ] 4.1 Update `packages/cli/CLAUDE.md` or relevant package docs if a `studio` command flag/env var table exists, to document `INDIGODB_STUDIO_PASSWORD` and the non-loopback refusal.
- [ ] 4.2 Confirm no leftover debug logging of the password/secret in `studio-auth.ts` or `studio-server.ts`.
