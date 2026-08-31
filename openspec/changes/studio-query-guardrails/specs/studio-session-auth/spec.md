# Delta for Studio Session Auth

## MODIFIED Requirements

### Requirement: Status probe reports read-only and guardrail posture

`GET /api/auth/status` MUST additionally report a `readOnly: boolean` field, a
`queryTimeoutMs: number` field, and a `queryRowCap: number` field alongside its existing
`authRequired`/`authenticated` fields. These fields MUST be populated correctly independent of
auth configuration, and `queryTimeoutMs`/`queryRowCap` MUST reflect the exact values resolved at
startup (per `studio-query-guardrails`'s CLI-flag > env-var > default precedence). This widening
remains additive and non-breaking to the existing response shape.

(Previously: only `readOnly` was added to the status probe; `queryTimeoutMs` and `queryRowCap`
were not exposed.)

#### Scenario: readOnly reflects server posture across all auth combinations

- GIVEN the server is configured with auth off/on and read-only off/on, in each of the 4 combinations
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `readOnly` matching the server's configured read-only state
- AND `authRequired`/`authenticated` remain correct and unaffected by the read-only value

#### Scenario: Status probe remains unauthenticated when read-only is active

- GIVEN a password is configured and read-only mode is active
- WHEN a client with no session calls `GET /api/auth/status`
- THEN the server responds 200 with the current `authRequired`, `authenticated`, `readOnly`,
  `queryTimeoutMs`, and `queryRowCap` fields, not 401

#### Scenario: queryTimeoutMs and queryRowCap reflect resolved startup values without a session

- GIVEN the server was started with `--query-timeout 9000` and `INDIGODB_STUDIO_QUERY_ROW_CAP=250`
- AND a password is configured and no session cookie is presented
- WHEN a client calls `GET /api/auth/status`
- THEN the server responds 200 with `queryTimeoutMs: 9000` and `queryRowCap: 250`
</content>
