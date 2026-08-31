# Studio Session Auth Specification

## Purpose

`indigodb studio` MUST support an optional shared-password session gate so a
non-loopback deployment is never left with zero access control. Auth is
opt-in and off by default: the machinery is present but inert until an
operator configures a password, preserving today's zero-config behavior.

## Requirements

### Requirement: Zero-config default remains unauthenticated

The system MUST NOT activate any auth machinery when `INDIGODB_STUDIO_PASSWORD`
is unset. No login screen, no session cookie, and no auth middleware checks
MUST be introduced in this state, and every existing route (including
`real-row-crud`'s `/api/rows/:table` writes and `real-pagination-filtering-
sorting`'s reads) MUST behave exactly as before this change.

#### Scenario: No password set preserves prior behavior

- GIVEN `INDIGODB_STUDIO_PASSWORD` is unset
- WHEN the Studio server starts and a client requests any route, including a
  write to `/api/rows/:table`
- THEN no login screen is shown, no session cookie is issued or checked
- AND the request behaves identically to the server's behavior before this
  change

### Requirement: Password-gated access to every API route

When `INDIGODB_STUDIO_PASSWORD` is set, the system MUST require a valid
signed session cookie on every `/api/*` route, applied after the existing
`validateHeaders()` Host/Origin check, except the login route
(`POST /api/auth/login`) and the auth-status probe
(`GET /api/auth/status`). This includes write routes such as
`/api/rows/:table` INSERT/UPDATE/DELETE.

The static SPA shell (the built frontend bundle and its assets) is served
**unauthenticated** regardless of configuration, since the bundle is one
indivisible artifact and gating it would make the login screen itself
unreachable. The shell carries no schema or row data of its own — every
value it displays arrives through a gated `/api/*` call — so this is not a
data-exposure gap, only a UI-shell exemption.

#### Scenario: Unauthenticated request to a protected API route is rejected

- GIVEN a password is configured and no valid session cookie is presented
- WHEN a client requests any `/api/*` route, including a write to
  `/api/rows/:table`
- THEN the server responds 401 and does not execute the route's application
  logic

#### Scenario: Valid session grants access to every API route

- GIVEN a password is configured and the client holds a valid, unexpired
  signed session cookie
- WHEN the client requests any `/api/*` route, read or write
- THEN the request proceeds and behaves as it would with auth disabled

#### Scenario: Static SPA shell loads without a session

- GIVEN a password is configured and no valid session cookie is presented
- WHEN the client requests the Studio SPA's HTML/JS/CSS shell
- THEN the shell is served normally (not 401), and the shell's own first
  `/api/*` calls (including the auth-status probe) are what determine
  whether the login screen or the application renders

### Requirement: Login issues a signed session cookie

The system MUST provide a login route that accepts the shared password,
verifies it with a constant-time comparison, and on success issues an
HMAC-signed session cookie (`HttpOnly`, `SameSite=Strict`) whose signing
secret is derived from the configured password. On failure it MUST reject
without revealing whether the submitted password was partially correct.

#### Scenario: Correct password issues a valid session cookie

- GIVEN a password is configured
- WHEN a client submits the correct password to the login route
- THEN the server issues an `HttpOnly; SameSite=Strict` session cookie signed
  with a secret derived from the password
- AND that cookie is accepted by the auth middleware on subsequent requests

#### Scenario: Incorrect password is rejected without timing leakage

- GIVEN a password is configured
- WHEN a client submits an incorrect password to the login route
- THEN the server rejects the login with no session cookie issued
- AND the comparison used is constant-time (matching the `timingSafeEqual`
  pattern in `@indigodb/realtime`'s `handle.ts`), so response timing does not
  indicate how close the guess was

### Requirement: Logout clears the client-side session

The system MUST provide a logout route that clears the session cookie on the
client. Because sessions are stateless (HMAC-verified, no server-side
registry), a cookie retained or replayed by a client after logout remains
technically valid until its expiry; this is a stated limitation, not a bug.

#### Scenario: Logout clears the cookie

- GIVEN a client holds a valid session cookie
- WHEN the client calls the logout route
- THEN the server responds with a cookie-clearing directive
- AND a fresh request without that cookie is treated as unauthenticated

#### Scenario: A retained cookie after logout remains valid until expiry

- GIVEN a client captured its session cookie value before calling logout
- WHEN the client replays that exact cookie value on a later request before
  its expiry
- THEN the server accepts it as valid, because logout does not invalidate
  sessions server-side

### Requirement: Fixed session expiry with no renewal

Every issued session cookie MUST carry a fixed expiry set at issuance. The
system MUST NOT extend or renew that expiry on subsequent activity, and MUST
reject any request presenting an expired session.

#### Scenario: Expired session is rejected

- GIVEN a session cookie issued with a fixed TTL that has since elapsed
- WHEN the client makes a request using that cookie
- THEN the server responds 401 and requires the client to log in again

#### Scenario: Activity does not extend session lifetime

- GIVEN a valid, unexpired session cookie
- WHEN the client makes repeated requests before the fixed expiry
- THEN the cookie's expiry timestamp does not change as a result of that
  activity

### Requirement: No login rate limiting

The system MAY allow unlimited login attempts and unlimited concurrent
sessions from one password; this is an accepted gap for a local development
tool, not an omission to fix in this change.

#### Scenario: Repeated login attempts are not throttled

- GIVEN a password is configured
- WHEN a client submits multiple incorrect login attempts in succession
- THEN none of the attempts are throttled, delayed, or locked out by the
  server

### Requirement: Password rotation invalidates all sessions

Because the session-signing secret is derived from the configured password,
changing `INDIGODB_STUDIO_PASSWORD` and restarting the server MUST invalidate
every previously issued session cookie.

#### Scenario: Rotating the password invalidates prior sessions

- GIVEN a client holds a valid session cookie issued under the old password
- WHEN the operator changes `INDIGODB_STUDIO_PASSWORD` and restarts the
  server
- THEN a request using the old session cookie is rejected as invalid

### Requirement: Non-loopback bind requires configured auth

The system MUST refuse to start (non-zero exit, actionable error message)
when a non-loopback `--host` value is requested and
`INDIGODB_STUDIO_PASSWORD` is not set. The same `--host` value with the
password set MUST start normally and gate every `/api/*` route as above.

#### Scenario: Non-loopback bind without a password refuses to start

- GIVEN the operator passes `--host 0.0.0.0` (or any non-loopback address)
- AND `INDIGODB_STUDIO_PASSWORD` is unset
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `INDIGODB_STUDIO_PASSWORD` as the missing
  requirement

#### Scenario: Non-loopback bind with a password starts and enforces auth

- GIVEN the operator passes `--host 0.0.0.0`
- AND `INDIGODB_STUDIO_PASSWORD` is set
- WHEN the operator starts `indigodb studio`
- THEN the server starts and binds to the requested host
- AND every `/api/*` route requires a valid session cookie (the static SPA
  shell itself stays unauthenticated)

### Requirement: Login screen shown when auth is required

The Studio frontend MUST show a login screen when the server reports that
auth is required and no valid session exists, and MUST NOT show it otherwise.

#### Scenario: Frontend shows login screen for an unauthenticated session

- GIVEN the server has a password configured
- AND the browser holds no valid session cookie
- WHEN the Studio SPA loads
- THEN the login screen is displayed instead of the application shell

#### Scenario: Frontend skips login screen when auth is not configured

- GIVEN the server has no password configured
- WHEN the Studio SPA loads
- THEN the application shell renders directly, with no login screen

### Requirement: Status probe reports read-only posture

`GET /api/auth/status` MUST additionally report a `readOnly: boolean` field alongside its existing `authRequired`/`authenticated` fields. This field MUST be populated correctly independent of auth configuration, across all four auth-on/off x read-only-on/off combinations, and this widening remains additive and non-breaking to the existing response shape.

#### Scenario: readOnly reflects server posture across all auth combinations

- GIVEN the server is configured with auth off/on and read-only off/on, in each of the 4 combinations
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `readOnly` matching the server's configured read-only state
- AND `authRequired`/`authenticated` remain correct and unaffected by the read-only value

#### Scenario: Status probe remains unauthenticated when read-only is active

- GIVEN a password is configured and read-only mode is active
- WHEN a client with no session calls `GET /api/auth/status`
- THEN the server responds 200 with the current `authRequired`, `authenticated`, and `readOnly` fields, not 401
