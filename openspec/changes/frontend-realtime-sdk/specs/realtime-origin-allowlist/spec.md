# Realtime Origin Allowlist Specification

## Purpose

Defines `RealtimeEngine`'s configurable CORS origin allowlist for `REALTIME_PATH` and
`REALTIME_LOG_PATH`, replacing the unconditional `access-control-allow-origin: "*"`. Publishing a
browser SDK against this route is the reason the default flips to closed.

## Requirements

### Requirement: The allowlist defaults closed when unconfigured

When `RealtimeEngine` is constructed with no origin allowlist configured, `handleRequest` and
`handleLogRequest` MUST NOT emit `access-control-allow-origin: "*"`, and MUST NOT reflect an
arbitrary request `Origin` header as allowed. An unconfigured allowlist MUST NOT be treated as
"allow everything".

#### Scenario: No configured origins means no wildcard CORS header

- GIVEN a `RealtimeEngine` constructed with no `origins` option
- WHEN a request is served for `REALTIME_PATH`
- THEN the response does not contain `access-control-allow-origin: *`

#### Scenario: An unlisted origin's request is not granted CORS access

- GIVEN a `RealtimeEngine` constructed with no `origins` option
- WHEN a request arrives with an `Origin` header set to any value
- THEN the response does not echo that origin back as an allowed CORS origin

### Requirement: A request carrying no Origin header is always allowed

A request that carries no `Origin` header at all MUST be served normally on both `REALTIME_PATH`
and `REALTIME_LOG_PATH`, whatever the allowlist is configured to — including the closed default.
The allowlist gates browser cross-origin access only; it MUST NOT be used as an authentication or
authorization boundary. This is what keeps the `indigodb realtime` CLI daemon, `curl`, an operator
proxy, and the Studio's embedded engine working unchanged under a default-closed allowlist.

#### Scenario: An originless request is served even with the allowlist unconfigured

- GIVEN a `RealtimeEngine` constructed with no `origins` option
- WHEN a request is made to `REALTIME_PATH` with no `Origin` header
- THEN the response status is `200` with `content-type: text/event-stream`
- AND the request is not rejected with `403`

### Requirement: A configured origin list opts a matching request into CORS access

`RealtimeEngine` MUST accept an explicit list of allowed origins. When the incoming request's
`Origin` header exactly matches an entry in that list, the response MUST set
`access-control-allow-origin` to that exact origin value.

#### Scenario: A listed origin is granted access

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN a request arrives with `Origin: https://app.example.com`
- THEN the response's `access-control-allow-origin` is exactly `https://app.example.com`

#### Scenario: A non-listed origin is not granted access

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN a request arrives with `Origin: https://evil.example.com`
- THEN the response does not set `access-control-allow-origin` to `https://evil.example.com` or
  to `*`

#### Scenario: An origin that merely prefixes or suffixes a listed one is not granted access

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN requests arrive with `Origin: https://app.example.com.evil.test` and with
  `Origin: https://evil-app.example.com`
- THEN neither response sets `access-control-allow-origin`, and both are rejected with `403`
- AND matching is exact string equality, never a prefix, suffix, or substring test

### Requirement: The allowlist applies uniformly to both the SSE route and the log replay route

Both `handleRequest` (SSE) and `handleLogRequest` (`GET ?handle&offset`) MUST apply the same
configured origin allowlist and the same closed-by-default behavior. Neither route MUST have a
more permissive CORS posture than the other.

#### Scenario: Both routes honor the same allowlist identically

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN requests with `Origin: https://app.example.com` are made to both `REALTIME_PATH` and
  `REALTIME_LOG_PATH`
- THEN both responses set `access-control-allow-origin: https://app.example.com`

### Requirement: OPTIONS preflight answers with the same admission decision as the route it precedes

An `OPTIONS` request to `REALTIME_PATH` or `REALTIME_LOG_PATH` MUST be answered by the same
allowlist gate as a `GET` to that path. An allowed origin MUST receive `204` with the same CORS
headers the `GET` would carry (`access-control-allow-origin` set to that exact origin, never `*`,
plus `vary: origin`, and never `access-control-allow-credentials`). A non-allowed origin MUST
receive `403` with no CORS header. A preflight MUST NOT be more permissive than the route it
precedes.

#### Scenario: A preflight from an allowed origin returns 204 with the exact origin echoed

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN an `OPTIONS` request with `Origin: https://app.example.com` is made to `REALTIME_PATH` and
  to `REALTIME_LOG_PATH`
- THEN both responses are `204` with `access-control-allow-origin: https://app.example.com`
- AND neither response sets `access-control-allow-origin: *`

#### Scenario: A preflight from a non-allowed origin is rejected on both paths

- GIVEN a `RealtimeEngine` configured with `origins: ["https://app.example.com"]`
- WHEN an `OPTIONS` request with `Origin: https://evil.example.com` is made to `REALTIME_PATH` and
  to `REALTIME_LOG_PATH`
- THEN both responses are `403` and set no `access-control-allow-origin` header
