# Delta for Studio Session Auth

## MODIFIED Requirements

### Requirement: Status probe reports read-only, guardrail, and environment posture

`GET /api/auth/status` MUST additionally report an `environment: string | null` field alongside
its existing `authRequired`/`authenticated`/`readOnly`/`queryTimeoutMs`/`queryRowCap` fields.
`environment` MUST reflect the exact value resolved at startup by `resolveStudioEnvironment`
(per `studio-environment-badge`'s CLI-flag `--env` > `INDIGODB_ENV` > unset precedence), or `null`
when neither was set. This field MUST be populated correctly independent of auth configuration,
and MUST NOT be read by, or influence, any authorization or guardrail decision. This widening
remains additive and non-breaking to the existing response shape.
(Previously: reported `readOnly`, `queryTimeoutMs`, and `queryRowCap` only, with no `environment`
field.)

#### Scenario: readOnly reflects server posture across all auth combinations

- GIVEN the server is configured with auth off/on and read-only off/on, in each of the 4 combinations
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `readOnly` matching the server's configured read-only state
- AND `authRequired`/`authenticated` remain correct and unaffected by the read-only value

#### Scenario: Status probe remains unauthenticated when read-only is active

- GIVEN a password is configured and read-only mode is active
- WHEN a client with no session calls `GET /api/auth/status`
- THEN the server responds 200 with the current `authRequired`, `authenticated`, `readOnly`,
  `queryTimeoutMs`, `queryRowCap`, and `environment` fields, not 401

#### Scenario: queryTimeoutMs and queryRowCap reflect resolved startup values without a session

- GIVEN the server was started with `--query-timeout 9000` and `INDIGODB_STUDIO_QUERY_ROW_CAP=250`
- AND a password is configured and no session cookie is presented
- WHEN a client calls `GET /api/auth/status`
- THEN the server responds 200 with `queryTimeoutMs: 9000` and `queryRowCap: 250`

#### Scenario: environment reflects the resolved startup value without a session

- GIVEN the server was started with `--env production`
- AND a password is configured and no session cookie is presented
- WHEN a client calls `GET /api/auth/status`
- THEN the server responds 200 with `environment: "production"`

#### Scenario: environment is null when unset

- GIVEN neither `--env` nor `INDIGODB_ENV` was set at startup
- WHEN a client calls `GET /api/auth/status`
- THEN the server responds 200 with `environment: null`
