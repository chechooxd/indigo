# Delta for Studio Read-Only Mode

## MODIFIED Requirements

### Requirement: Single shared write gate over the explicit write-route set

When `readOnly` is true, the system MUST reject every write to any route in
an explicit write-route set — currently `/api/rows/` (POST/PATCH/DELETE) and
`PUT /api/schema/source` — with `403 {error: "Studio is running in
read-only mode"}` from one gate check placed after the session-auth gate and
before write-route dispatch. Route-prefix scoping alone is insufficient: the
gate MUST be defined over this explicit set of write routes rather than
inferred from a single shared prefix, because the schema-write route does not
share the `/api/rows/` prefix and would silently bypass a prefix-only gate.
This check MUST NOT be duplicated inside individual verb handlers,
`resolveWriteTarget`, `db.writable`, or the schema-write handler, so a future
write route added to the set inherits the gate automatically once it is
added to the set. The rejection MUST occur before any of `resolveWriteTarget`,
`db.writable`, or schema-write's sentinel/staleness/validation checks run —
no DB connection, no file read, and no compile validation happens for that
request. When audit logging is enabled (`studio-audit-log`), this gate MUST
also emit exactly one stdout audit line with `outcome: "denied"` and
`reason: "read-only"` — using `op: "insert"/"update"/"delete"` for
`/api/rows/` requests and `op: "schema-write"` for
`PUT /api/schema/source` — before returning the `403`. The `403` response
body itself MUST be unchanged by audit logging being on or off, and MUST be
identical in shape across every route in the write-route set.

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

#### Scenario: A denied write emits an audit line marked as denied

- GIVEN `readOnly` is true, the caller is authenticated (or auth is off), and
  audit logging is enabled
- WHEN the caller sends a write to `/api/rows/:table` or a
  `PUT /api/schema/source`
- THEN the server responds 403 with the read-only error body
- AND stdout receives exactly one JSON line with `outcome: "denied"` and
  `reason: "read-only"`, with the appropriate `op` for that route and no
  column names, values, or file path

#### Scenario: The 403 response body is unaffected by audit logging

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a write to `/api/rows/:table` first with audit
  logging enabled, then again with `--no-audit-log`
- THEN both responses have the identical status code and body

(Previously: this requirement scoped the gate to the `/api/rows/` prefix
only, which would not have covered a new write route added under a different
path — as the schema-write route now proves.)
</content>
