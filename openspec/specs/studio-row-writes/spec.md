# Studio Row Writes Specification

## Purpose

Studio's server gains a genuinely writable path for row-level INSERT/UPDATE/DELETE,
identified by primary key, separate from the existing read-only query path.

## Requirements

### Requirement: Write routes use a dedicated writable transaction path
The system MUST execute `POST`/`PATCH`/`DELETE` row routes on a connection/pool that is
distinct from the read-only pool guarded by `SET TRANSACTION READ ONLY`, and MUST NOT
run write statements on that read-only connection.

#### Scenario: Write route opens its own writable connection
- GIVEN the Studio server is running with both pools configured
- WHEN a client sends `PATCH` to a row route
- THEN the server acquires a connection from the writable pool, not the read-only pool
- AND the write commits successfully

### Requirement: Table and column identifiers are re-validated before SQL interpolation
Every write route MUST validate the requested table name against `resolved.tables` and
every column name against that table's `columns` before interpolating either into SQL.
Unknown identifiers MUST be rejected before any statement executes. All values MUST be
passed as parameters, never interpolated.

#### Scenario: Unknown table name is rejected
- GIVEN a request targets a table name absent from `resolved.tables`
- WHEN the client sends any write request for that table
- THEN the server responds with an error status (4xx) and executes no SQL

#### Scenario: Unknown column name is rejected
- GIVEN an UPDATE or INSERT body includes a key not present in the target table's columns
- WHEN the client sends the request
- THEN the server responds with an error status (4xx) and no statement is executed

### Requirement: Rows are identified by primary key, including composite keys
Write routes MUST identify the target row by its primary key value(s) as defined in
`ResolvedTable.primaryKey`, building the `WHERE` clause from that definition. Composite
primary keys MUST be supported by requiring and matching all key columns together.

#### Scenario: UPDATE targets a row by single-column primary key
- GIVEN a table with a single-column primary key `id`
- WHEN a client sends `PATCH` with that `id` and a changed field value
- THEN exactly the row with that `id` is updated
- AND the response reflects the persisted new value

#### Scenario: UPDATE and DELETE target a row by composite primary key
- GIVEN a table whose primary key is composed of two columns
- WHEN a client sends `PATCH` or `DELETE` with both key column values
- THEN exactly the one row matching both values is affected
- AND a request supplying only one of the two key values is rejected as an error (4xx)

### Requirement: INSERT creates a new row and returns it
`POST` MUST insert a new row from validated columns and return the persisted row,
including any database-generated primary key or default values.

#### Scenario: INSERT with a generated primary key
- GIVEN a table whose primary key is database-generated (e.g. serial/identity)
- WHEN a client sends `POST` with the other required column values
- THEN the row is inserted and the response includes the generated primary key value

### Requirement: DELETE removes exactly the targeted row
`DELETE` MUST remove only the row matched by primary key and MUST NOT affect other rows.

#### Scenario: DELETE removes one row and leaves others intact
- GIVEN a table with multiple rows
- WHEN a client sends `DELETE` for one row's primary key
- THEN that row no longer exists
- AND all other rows remain unchanged
</content>

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
