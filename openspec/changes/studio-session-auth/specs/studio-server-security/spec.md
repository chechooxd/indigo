# Delta for Studio Server Security

## MODIFIED Requirements

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

(Previously: opt-in allowed a remote bind unconditionally, with only a risk
warning printed at startup.)

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
