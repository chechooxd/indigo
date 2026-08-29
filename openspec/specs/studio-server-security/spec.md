# Studio Server Security Specification

## Purpose

`indigodb studio` MUST NOT behave as an unauthenticated public service. This
spec covers the network bind default, credential redaction in API responses,
and Origin/Host validation for `packages/cli/src/studio-server.ts`.

## Requirements

### Requirement: Loopback bind by default

The system MUST bind the Studio HTTP server to `127.0.0.1` unless the
operator explicitly opts into a different host via a flag or environment
variable. A non-loopback bind MUST NOT be reachable as a side effect of any
other default behavior.

#### Scenario: Default startup binds loopback only

- GIVEN `indigodb studio` is started with no host flag or env var
- WHEN the server starts listening
- THEN the server binds to `127.0.0.1`
- AND it is not reachable from another host on the network

#### Scenario: Explicit opt-in allows remote bind when auth is configured

- GIVEN the operator passes an explicit host flag or sets the corresponding
  env var to a non-loopback address (e.g. `0.0.0.0`)
- AND `INDIGODB_STUDIO_PASSWORD` is set
- WHEN the server starts listening
- THEN the server binds to the requested host
- AND the startup console output includes a message naming the risk of
  binding to a non-loopback interface
- AND every `/api/*` route requires a valid session per `studio-session-auth`
  (the static SPA shell itself stays unauthenticated, per that spec)

#### Scenario: Explicit opt-in without configured auth refuses to start

- GIVEN the operator passes an explicit host flag or sets the corresponding
  env var to a non-loopback address (e.g. `0.0.0.0`)
- AND `INDIGODB_STUDIO_PASSWORD` is NOT set
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `INDIGODB_STUDIO_PASSWORD` as the missing
  precondition for a non-loopback bind

### Requirement: Datasource redaction in API responses

The system MUST NOT expose the `datasource` block — including connection
strings supplied via `env()` or as a literal URL — in any response served by
`/api/schema` or `/api/schema/source`. Redaction MUST apply to the entire
`datasource` block, not only the `url` field.

#### Scenario: /api/schema omits datasource regardless of literal or env() URL

- GIVEN a resolved schema whose `datasource` uses a literal connection string
- WHEN a client requests `GET /api/schema`
- THEN the JSON response contains no `datasource` key
- AND this holds identically when the schema instead uses `env()` for the URL

#### Scenario: /api/schema/source omits datasource block from raw source

- GIVEN raw `.indigo` source text containing a `datasource` block with a
  connection string
- WHEN a client requests `GET /api/schema/source`
- THEN the returned text does not contain the `datasource` block or any
  connection string it held

### Requirement: Origin/Host validation

The system MUST reject any HTTP request whose `Origin` header (when present)
or `Host` header does not match the expected local server address, to
prevent cross-origin pages from reaching the API via the loopback bind.

#### Scenario: Cross-origin request is rejected

- GIVEN the Studio server is running and bound to its expected local address
- WHEN a request arrives with an `Origin` or `Host` header that does not
  match the expected local server
- THEN the server responds with HTTP 403
- AND the response body is a JSON error object (e.g. `{ "error": "..." }`)
  describing the rejection
- AND no application logic (schema read, query, table read) executes for
  that request
</content>
