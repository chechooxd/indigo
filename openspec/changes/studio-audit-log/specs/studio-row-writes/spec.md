# Delta for Studio Row Writes

## ADDED Requirements

### Requirement: Each successful write emits its own audit log entry

When audit logging is enabled (`studio-audit-log`), each of the three write handlers
(`handleInsertRow`, `handleUpdateRow`, `handleDeleteRow`) MUST emit exactly one stdout JSON
line with `outcome: "ok"` on a successful commit, containing that operation's `op`, table,
primary-key value(s), changed column names, and affected row count — never non-PK values.
Insert, update, and delete each produce their own line for their own request; a request that
touches one row produces exactly one line, never zero and never more than one.

#### Scenario: A successful INSERT emits one ok line

- GIVEN audit logging is enabled
- WHEN a client sends `POST` inserting a new row
- THEN exactly one stdout line is emitted with `op: "insert"`, the table name, the
  generated primary-key value, the inserted column names, and `outcome: "ok"`

#### Scenario: A successful UPDATE emits one ok line

- GIVEN audit logging is enabled
- WHEN a client sends `PATCH` changing one row's fields
- THEN exactly one stdout line is emitted with `op: "update"`, the table name, the row's
  primary-key value(s), the names of the changed columns, and `outcome: "ok"`

#### Scenario: A successful DELETE emits one ok line

- GIVEN audit logging is enabled
- WHEN a client sends `DELETE` for one row
- THEN exactly one stdout line is emitted with `op: "delete"`, the table name, the row's
  primary-key value(s), and `outcome: "ok"`

### Requirement: A failing write emits an error entry without leaking submitted values

When audit logging is enabled, a write that fails after re-validation (e.g. a database error)
MUST emit exactly one stdout JSON line with `outcome: "error"` for that operation, and MUST NOT
include any submitted column value in that line.

#### Scenario: A failed write logs the failure without the attempted values

- GIVEN audit logging is enabled and a write targets a row in a way that causes the database
  to reject it (e.g. a constraint violation)
- WHEN the client sends that write
- THEN exactly one stdout line is emitted with `outcome: "error"`
- AND none of the request's submitted column values appear in that line
