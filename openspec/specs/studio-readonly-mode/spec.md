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
password's env-only pattern). The env var's accepted set MUST mirror
`resolveStudioAuditLog`: an exact match of `"1"` or `"true"` MUST enable
read-only mode, an exact match of `"0"` or `"false"` MUST disable it, and
ANY other value MUST cause the process to exit non-zero before Studio binds
to a port, with an error message naming `INDIGODB_STUDIO_READONLY` and the
four accepted values. Silent fail-open on a malformed value defeats the
entire purpose of this capability — an operator pointing Studio at a shared,
staging, or production database is relying on read-only mode actually being
on, and a lenient parser only discovers the mismatch after data has already
been mutated. The resolved value MUST be captured once into
`StudioOptions.readOnly` at process startup, mirroring how `auth` is
resolved once, with no route to toggle it while the server is running.

#### Scenario: Default preserves existing write behavior

- GIVEN neither `--read-only` nor `INDIGODB_STUDIO_READONLY` is set
- WHEN a client sends INSERT/UPDATE/DELETE requests to `/api/rows/:table`
- THEN every write behaves exactly as before this change
- AND existing suites (`studio-write.mjs`, `studio-auth.mjs`,
  `studio-auth-preflight.mjs`) continue to pass unmodified

#### Scenario: CLI flag or exact-match "on" env values enable read-only mode

- GIVEN the operator starts `indigodb studio --read-only`, or sets
  `INDIGODB_STUDIO_READONLY=1` without the flag, or sets
  `INDIGODB_STUDIO_READONLY=true` without the flag
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `true` for the lifetime of that process

#### Scenario: Exact-match "off" env values keep read-only disabled

- GIVEN no `--read-only` flag is passed, and `INDIGODB_STUDIO_READONLY` is
  set to `"0"`, or separately set to `"false"`
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `false` and the process starts normally with exit 0
- AND this is unchanged from the resolver's behavior before this change

#### Scenario: Unset env var and no flag leaves read-only off

- GIVEN neither `--read-only` nor `INDIGODB_STUDIO_READONLY` is present in
  the process environment
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `false` and the process starts normally with exit 0

#### Scenario: Malformed env values cause a loud startup failure

- GIVEN `INDIGODB_STUDIO_READONLY` is set to `"yes"`, `"on"`, `"TRUE"`,
  `"1.0"`, `" 1 "` (leading/trailing whitespace), or an empty string `""`
- WHEN the server starts
- THEN the process exits with a non-zero status before binding to a port
- AND the error message names `INDIGODB_STUDIO_READONLY` and lists the four
  accepted values (`1`, `true`, `0`, `false`)
- AND `StudioOptions.readOnly` is never bound and no fuzzy truthy parsing is
  applied

#### Scenario: The CLI flag adds read-only but never suppresses env validation

- GIVEN the operator starts `indigodb studio --read-only` while
  `INDIGODB_STUDIO_READONLY` is unset or holds any of the four accepted values
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it resolves to `true` — the flag alone is sufficient, and `"0"`/`"false"`
  in the env var does NOT cancel it

#### Scenario: A malformed env value is rejected even when the flag is passed

- GIVEN `INDIGODB_STUDIO_READONLY` is set to a rejected value such as `"yes"`
- AND the operator also passes `--read-only`
- WHEN `indigodb studio` starts
- THEN the process still exits non-zero before binding, naming the variable and
  the accepted values
- AND the malformed value is NOT silently suppressed by the flag

`--read-only` is enable-only: it can add read-only mode but never turn it off,
so it expresses no intent to override the environment. Suppressing a typo the
operator never asked to suppress would leave that typo in place until the next
launch without the flag, which would then come up writable with no warning —
the exact failure this change exists to close, merely deferred. (This is
deliberately unlike `resolveStudioAuditLog`, whose flag IS authoritative in both
directions and therefore genuinely does override the environment.)

### Requirement: Single shared write gate over the explicit write-route set

When `readOnly` is true, the system MUST reject every write to any route in
an explicit write-route set — currently `/api/rows/` (POST/PATCH/DELETE),
`PUT /api/schema/source`, and `PUT /api/schema/layout` — with `403
{error: "Studio is running in read-only mode"}` from one gate check placed
after the session-auth gate and before write-route dispatch. Route-prefix
scoping alone is insufficient: the gate MUST be defined over this explicit
set of write routes rather than inferred from a single shared prefix,
because neither the schema-write route nor the layout-write route shares
the `/api/rows/` prefix and would silently bypass a prefix-only gate. This
check MUST NOT be duplicated inside individual verb handlers,
`resolveWriteTarget`, `db.writable`, or the schema-write/layout-write
handlers, so a future write route added to the set inherits the gate
automatically once it is added to the set. The rejection MUST occur before
any of `resolveWriteTarget`, `db.writable`, or schema-write/layout-write's
sentinel/staleness/`schemaPath`-presence checks run — no DB connection, no
file read, and no compile validation happens for that request. When audit
logging is enabled (`studio-audit-log`), this gate MUST also emit exactly
one stdout audit line with `outcome: "denied"` and `reason: "read-only"` —
using `op: "insert"/"update"/"delete"` for `/api/rows/` requests,
`op: "schema-write"` for `PUT /api/schema/source`, and `op: "layout-write"`
for `PUT /api/schema/layout` — before returning the `403`. The `403`
response body itself MUST be unchanged by audit logging being on or off,
and MUST be identical in shape across every route in the write-route set.

(Previously: the explicit write-route set covered only `/api/rows/` and
`PUT /api/schema/source`; `PUT /api/schema/layout` did not exist and was
not gated.)

#### Scenario: All three row-write verbs are rejected identically from one gate

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a POST, PATCH, and DELETE to `/api/rows/:table` in
  turn
- THEN all three receive `403 {error: "Studio is running in read-only mode"}`
- AND none reaches `resolveWriteTarget` or opens a write transaction

#### Scenario: A schema write is refused by the same gate, not assumed covered by inheritance

- GIVEN `readOnly` is true, the caller is authenticated (or auth is off), and
  `schemaWritable` is `true`
- WHEN the caller sends `PUT /api/schema/source`
- THEN the response is `403 {error: "Studio is running in read-only mode"}`
- AND the request never reaches sentinel-count checking, staleness checking,
  or compile validation, and the on-disk schema file is unchanged
- AND this holds even though `/api/schema/source` does not share the
  `/api/rows/` prefix — proving the gate is defined by the explicit
  write-route set, not by prefix matching

#### Scenario: A layout write is refused by the same gate, proving the new route inherited it

- GIVEN `readOnly` is true, the caller is authenticated (or auth is off), and
  `layoutWritable` is `true`
- WHEN the caller sends `PUT /api/schema/layout`
- THEN the response is `403 {error: "Studio is running in read-only mode"}`
- AND the request never reaches layout staleness checking or the atomic
  write step, and the on-disk sidecar file is unchanged
- AND this demonstrates the explicit-set design intent stated above: the
  new mutating route required no new gate code, only its addition to the
  set

#### Scenario: A denied write emits an audit line marked as denied, with the correct op per route

- GIVEN `readOnly` is true, the caller is authenticated (or auth is off), and
  audit logging is enabled
- WHEN the caller sends a write to `/api/rows/:table`, a
  `PUT /api/schema/source`, and a `PUT /api/schema/layout`, in turn
- THEN each response is 403 with the read-only error body
- AND stdout receives exactly one JSON line per request with
  `outcome: "denied"` and `reason: "read-only"`, with `op` set to
  `insert`/`update`/`delete`, `schema-write`, and `layout-write`
  respectively, and no column names, values, or file paths

#### Scenario: The 403 response body is unaffected by audit logging

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a write to `/api/rows/:table` first with audit
  logging enabled, then again with `--no-audit-log`
- THEN both responses have the identical status code and body

#### Scenario: The read-only gate runs before the layout route's own schemaPath check

- GIVEN `readOnly` is true and `schemaPath` is absent (so `layoutWritable`
  is `false`)
- WHEN the caller sends `PUT /api/schema/layout`
- THEN the response is `403` from the read-only gate, not `404` from the
  route's own `schemaPath`-presence check — proving gate ordering places
  the shared read-only refusal before any route-specific dispatch logic
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
