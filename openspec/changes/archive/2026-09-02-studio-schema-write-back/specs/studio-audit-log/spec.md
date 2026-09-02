# Delta for Studio Audit Log

## ADDED Requirements

### Requirement: Schema-write attempts are audited without file content or file path

`AuditOp` MUST widen from the closed union `"insert" | "update" | "delete"`
to include `"schema-write"`, and `StudioAuditEntry.table` MUST become
optional to accommodate this op, which has no table. `AuditReason` MUST gain
`"stale"`, `"redaction-conflict"`, and `"schema-invalid"` alongside the
existing reasons, for use with `outcome: "denied"` on a rejected
`PUT /api/schema/source`. Every attempted schema write — success or
rejection — MUST emit exactly one stdout JSON line with `op: "schema-write"`,
an outcome (`"ok"` or `"denied"`), a reason on denial, and the affected byte
count. The line MUST NOT contain the schema file's content, and MUST NOT
contain the schema file's path — a path can leak a home directory or a
private project name, and this Studio process is single-schema, so recording
that a schema write happened (not to which file) loses no operationally
useful information.

#### Scenario: A successful schema write is audited without content or path

- GIVEN audit logging is enabled and `schemaWritable` is `true`
- WHEN a client successfully `PUT`s a valid schema buffer
- THEN exactly one stdout JSON line is emitted with `op: "schema-write"`,
  `outcome: "ok"`, and a byte count
- AND the line contains neither the submitted schema text nor the schema
  file's path

#### Scenario: A stale write is audited with reason "stale"

- GIVEN audit logging is enabled and the client's `version` no longer matches
  the on-disk content hash
- WHEN the client `PUT`s the stale buffer
- THEN the server responds `409`
- AND exactly one stdout JSON line is emitted with `op: "schema-write"`,
  `outcome: "denied"`, and `reason: "stale"`

#### Scenario: A sentinel/redaction conflict is audited with reason "redaction-conflict"

- GIVEN audit logging is enabled and the client's buffer has zero, two, or
  more sentinel lines, or contains a literal datasource block
- WHEN the client `PUT`s that buffer
- THEN the server responds `400`
- AND exactly one stdout JSON line is emitted with `op: "schema-write"`,
  `outcome: "denied"`, and `reason: "redaction-conflict"`

#### Scenario: An invalid schema is audited with reason "schema-invalid"

- GIVEN audit logging is enabled and the client's buffer fails parse or
  resolve
- WHEN the client `PUT`s that buffer
- THEN the server responds `422`
- AND exactly one stdout JSON line is emitted with `op: "schema-write"`,
  `outcome: "denied"`, and `reason: "schema-invalid"`

#### Scenario: The audit line never carries the schema file path

- GIVEN audit logging is enabled and Studio is running against a schema file
  at some absolute path
- WHEN any schema write attempt is audited, successful or denied
- THEN the emitted line contains no field holding that path, or any path
  fragment derived from it

#### Scenario: Row-write audit entries are unaffected by the widened union

- GIVEN audit logging is enabled
- WHEN a client performs an insert, update, or delete on `/api/rows/:table`
- THEN the emitted line's shape (table, primary key, changed column names,
  `outcome: "ok"`) is unchanged from before this change, since widening
  `AuditOp` and making `table` optional does not alter the existing
  row-write entries, which continue to always include `table`
</content>
