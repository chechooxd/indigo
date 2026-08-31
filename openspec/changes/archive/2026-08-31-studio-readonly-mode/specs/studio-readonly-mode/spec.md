# Studio Read-Only Mode Specification

## Purpose

`indigodb studio` MUST support an opt-in, global, server-side read-only mode
so an operator pointing Studio at a shared, staging, or production database
can guarantee "inspect, never mutate" independent of the client-side Safe
Updates toggle. Read-only mode is off by default and fully orthogonal to
session auth.

## Requirements

### Requirement: Read-only flag resolved once at startup

The system MUST support a `--read-only` CLI flag and an
`INDIGODB_STUDIO_READONLY` env var as its default, following the
`--host`/`INDIGODB_STUDIO_HOST` flag+env-default convention (not the
password's env-only pattern). The env var MUST enable read-only mode only on
an exact match of `"1"` or `"true"`; any other value MUST leave it off. The
resolved value MUST be captured once into `StudioOptions.readOnly` at
process startup, mirroring how `auth` is resolved once, with no route to
toggle it while the server is running.

#### Scenario: Default preserves existing write behavior

- GIVEN neither `--read-only` nor `INDIGODB_STUDIO_READONLY` is set
- WHEN a client sends INSERT/UPDATE/DELETE requests to `/api/rows/:table`
- THEN every write behaves exactly as before this change
- AND existing suites (`studio-write.mjs`, `studio-auth.mjs`,
  `studio-auth-preflight.mjs`) continue to pass unmodified

#### Scenario: CLI flag or exact-match env var enables read-only mode

- GIVEN the operator starts `indigodb studio --read-only`, or sets
  `INDIGODB_STUDIO_READONLY=true`/`=1` without the flag
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `true` for the lifetime of that process

#### Scenario: Malformed env values do not enable read-only mode

- GIVEN `INDIGODB_STUDIO_READONLY` is set to `"yes"`, `"1.0"`, or an empty
  string
- WHEN the server starts
- THEN `StudioOptions.readOnly` resolves to `false`, with no fuzzy truthy
  parsing applied

### Requirement: Single shared write gate on the /api/rows/ prefix

When `readOnly` is true, the system MUST reject every write to the shared
`/api/rows/` prefix (POST/PATCH/DELETE) with
`403 {error: "Studio is running in read-only mode"}` from one gate check
placed after the session-auth gate and before write-route dispatch. This
check MUST NOT be duplicated inside individual verb handlers,
`resolveWriteTarget`, or `db.writable`, so a future write route added under
the same prefix inherits the gate automatically. The rejection MUST occur
before `resolveWriteTarget` or `db.writable` runs — no DB connection or
validation work happens for that request.

#### Scenario: All three write verbs are rejected identically from one gate

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a POST, PATCH, and DELETE to `/api/rows/:table` in
  turn
- THEN all three receive `403 {error: "Studio is running in read-only mode"}`
- AND none reaches `resolveWriteTarget` or opens a write transaction

### Requirement: Read routes unaffected by read-only mode

Read-only mode MUST NOT alter the behavior of any GET route, including
paginated `/api/rows/:table` reads, `/api/schema`, `/api/schema/source`,
`/api/tables/:name`, and `/api/query`.

#### Scenario: Reads succeed unchanged while read-only is active

- GIVEN `readOnly` is true
- WHEN a client requests `/api/schema`, `/api/query`, or a paginated
  `/api/rows/:table` read
- THEN the response is identical to the response with read-only off

### Requirement: Authenticated-only exposure of the read-only gate

When both session auth and read-only mode are active, the auth gate MUST run
first, so an unauthenticated write attempt MUST receive 401, never 403, and
MUST NOT reach the read-only check.

#### Scenario: Unauthenticated write cannot distinguish read-only state

- GIVEN a password is configured and read-only mode is active
- AND the caller presents no valid session cookie
- WHEN the caller sends a write to `/api/rows/:table`
- THEN the server responds 401
- AND the read-only gate is never evaluated for this request

#### Scenario: Authenticated write is refused by the read-only gate

- GIVEN a password is configured, the caller holds a valid session, and
  read-only mode is active
- WHEN the caller sends a write to `/api/rows/:table`
- THEN the server responds 403 with the read-only error message

### Requirement: Persistent read-only banner in Studio UI

The Studio frontend MUST show a persistent, visible banner whenever the
status probe reports `readOnly: true`, reusing the existing status wiring in
`useAuthStore`, and MUST NOT show it when `readOnly` is `false`.

#### Scenario: Banner renders when the server reports read-only

- GIVEN the status probe response includes `readOnly: true`
- WHEN the Studio SPA loads or the store refreshes status
- THEN a persistent banner indicating read-only mode is displayed

#### Scenario: Banner does not render when read-only is off

- GIVEN the status probe response includes `readOnly: false`
- WHEN the Studio SPA loads
- THEN no read-only banner is displayed
