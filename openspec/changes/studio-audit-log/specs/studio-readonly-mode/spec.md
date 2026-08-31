# Delta for Studio Read-Only Mode

## MODIFIED Requirements

### Requirement: Single shared write gate on the /api/rows/ prefix

When `readOnly` is true, the system MUST reject every write to the shared
`/api/rows/` prefix (POST/PATCH/DELETE) with
`403 {error: "Studio is running in read-only mode"}` from one gate check
placed after the session-auth gate and before write-route dispatch. This
check MUST NOT be duplicated inside individual verb handlers,
`resolveWriteTarget`, or `db.writable`, so a future write route added under
the same prefix inherits the gate automatically. The rejection MUST occur
before `resolveWriteTarget` or `db.writable` runs — no DB connection or
validation work happens for that request. When audit logging is enabled
(`studio-audit-log`), this gate MUST also emit exactly one stdout audit line
with `outcome: "denied"` and `reason: "read-only"`, containing no column
detail, before returning the 403. The 403 response body itself MUST be
unchanged by audit logging being on or off.
(Previously: the gate rejected the request with 403 and produced no other
observable effect — no log entry of any kind was emitted.)

#### Scenario: All three write verbs are rejected identically from one gate

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a POST, PATCH, and DELETE to `/api/rows/:table` in
  turn
- THEN all three receive `403 {error: "Studio is running in read-only mode"}`
- AND none reaches `resolveWriteTarget` or opens a write transaction

#### Scenario: A denied write emits an audit line marked as denied

- GIVEN `readOnly` is true, the caller is authenticated (or auth is off), and
  audit logging is enabled
- WHEN the caller sends a write to `/api/rows/:table`
- THEN the server responds 403 with the read-only error body
- AND stdout receives exactly one JSON line with `outcome: "denied"` and
  `reason: "read-only"`, with no column names or values

#### Scenario: The 403 response body is unaffected by audit logging

- GIVEN `readOnly` is true and the caller is authenticated (or auth is off)
- WHEN the caller sends a write to `/api/rows/:table` first with audit
  logging enabled, then again with `--no-audit-log`
- THEN both responses have the identical status code and body
