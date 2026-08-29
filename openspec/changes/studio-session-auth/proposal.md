# Proposal: Studio Session Auth

## Context

Change **1 of 5** splitting the roadmap epic "Auth and production guardrails" (Road to 1.0,
Phase 5). Sequence: **studio-session-auth** → `studio-readonly-mode` →
`studio-query-guardrails` / `studio-environment-badge` (parallel) → `studio-audit-log`.
This change is not the whole epic.

## Intent

`indigodb studio` has zero session concept. The only protections are the loopback-default
bind and `validateHeaders()`. Any process reaching the port with a matching `Host` header
gets unrestricted access — including the `/api/rows/:table` INSERT/UPDATE/DELETE routes,
which are server-side UI-guard-agnostic (the client "Safe Updates" toggle is bypassable by
curl). A `--host` bind removes the only real boundary and leaves nothing behind it.

## Scope

### In Scope
- Optional shared password via `INDIGODB_STUDIO_PASSWORD` (single secret, no user records).
- Login route + logout; HMAC-signed session cookie, `timingSafeEqual` verification,
  expiry — modeled on `@indigodb/realtime`'s `mintHandle`/`verifyHandle`.
- Auth middleware gating **every** route (API + SPA shell) when auth is configured.
- Studio login screen and 401 handling in `src/lib/api.ts`.
- Startup preflight in `util.ts`: **non-loopback `--host` without a password refuses to
  start** (throw, never guess).

### Out of Scope
- Read-only enforcement (`studio-readonly-mode`), environment badge, query
  timeout/row-cap/cancellation, audit logging — sibling changes, not absorbed here.
- Users, roles, RBAC, OAuth, TLS, password rotation/storage, rate limiting.

## Capabilities

### New Capabilities
- `studio-session-auth`: password configuration, login/logout, signed session cookie,
  route gating, non-loopback preflight.

### Modified Capabilities
- `studio-server-security`: "Explicit opt-in allows remote bind" gains a precondition —
  a non-loopback bind requires configured session auth.

## Approach

Two resolved decisions:
1. **Zero-config default preserved.** No password set ⇒ today's no-auth behavior; the
   session machinery is present-but-inert. Loopback bind remains the boundary.
2. **`--host` + no password ⇒ refuse to start**, with a message naming the fix.

Implementation reuses the realtime handle shape: HMAC over `{issuedAt, expiresAt}` with a
session secret derived from the password (or `INDIGODB_STUDIO_SECRET`), set as an
`HttpOnly; SameSite=Strict` cookie; middleware runs after `validateHeaders()` and before
routing, exempting only the login route and static login assets.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modified | Auth middleware, login/logout routes |
| `packages/cli/src/util.ts` | Modified | Password/secret preflight |
| `packages/cli/src/studio.ts` | Modified | Wire preflight to `--host` |
| `apps/studio/src/lib/api.ts` | Modified | 401 → login redirect |
| `apps/studio/src/features/auth/` | New | Login screen |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Inert-by-default reads as "auth shipped but off" | Med | Startup line states auth state explicitly |
| `--host` refusal breaks an existing workflow | Med | Documented; the alternative is a silently open network service |
| Cookie replay after password change | Low | Secret derives from password; changing it invalidates sessions |
| Homegrown crypto | Low | Reuse the reviewed `handle.ts` shape; no new primitives |

## Rollback Plan

Revert the change commits. With no password set the server behaves exactly as today, so an
unset `INDIGODB_STUDIO_PASSWORD` is also a runtime disable path short of revert.

## Dependencies

None. `node:crypto` only; no new packages.

## Success Criteria

- [ ] No password set: startup, all routes, and Studio behave as before.
- [ ] Password set: every route returns 401 without a valid cookie; login issues one.
- [ ] Tampered, expired, or foreign-secret cookies are rejected.
- [ ] `--host <non-loopback>` without a password exits non-zero with an actionable message.
- [ ] Direct `curl` to `/api/rows/:table` is rejected without a session.
