# Delta for Studio Read-Only Mode

## MODIFIED Requirements

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
</content>
