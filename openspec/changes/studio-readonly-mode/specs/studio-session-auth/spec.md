# Delta for Studio Session Auth

## ADDED Requirements

### Requirement: Status probe reports read-only posture

`GET /api/auth/status` MUST additionally report a `readOnly: boolean` field
alongside its existing `authRequired`/`authenticated` fields. This field MUST
be populated correctly independent of auth configuration, across all four
auth-on/off x read-only-on/off combinations, and this widening remains
additive and non-breaking to the existing response shape.

#### Scenario: readOnly reflects server posture across all auth combinations

- GIVEN the server is configured with auth off/on and read-only off/on, in
  each of the 4 combinations
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `readOnly` matching the server's configured
  read-only state
- AND `authRequired`/`authenticated` remain correct and unaffected by the
  read-only value

#### Scenario: Status probe remains unauthenticated when read-only is active

- GIVEN a password is configured and read-only mode is active
- WHEN a client with no session calls `GET /api/auth/status`
- THEN the server responds 200 with the current `authRequired`,
  `authenticated`, and `readOnly` fields, not 401
