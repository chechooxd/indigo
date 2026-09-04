# Studio Audit Log Specification

## Purpose

`indigodb studio` MUST emit one stdout JSON line per attempted row write so an operator can
tell whether Studio changed a row, when, and how — without implying it can say *who*, since
`studio-session-auth` is a shared password with no per-user identity. The log names no one: it
records a session **correlator**, not an identity.

## Requirements

### Requirement: Audit logging resolved once at startup, default on

The system MUST support a `--audit-log`/`--no-audit-log` CLI flag pair and an
`INDIGODB_STUDIO_AUDIT_LOG` env var, resolved via a pure, non-exiting `resolveStudioAuditLog(option, env)`
in `packages/cli/src/util.ts`, alongside `resolveStudioReadOnly`/`resolveStudioEnvironment`,
inside the `studio` CLI action after `loadEnv()`. The default MUST be enabled. `--audit-log`/
`--no-audit-log` MUST take precedence over `INDIGODB_STUDIO_AUDIT_LOG`. The env var MUST disable
logging only on an exact match of `"0"` or `"false"`. Any other non-empty value MUST be REJECTED:
the process exits non-zero before binding, with a message naming `INDIGODB_STUDIO_AUDIT_LOG`. No
fuzzy truthy/falsy parsing is applied, and a malformed value is never silently ignored.

This switch has a *disable* direction, so silent tolerance fails in the dangerous direction: an
operator who writes `INDIGODB_STUDIO_AUDIT_LOG=no` to stop table names and primary keys reaching
stdout would keep emitting them while believing logging was off. Rejecting loudly matches the
newer sibling resolvers `resolveQueryTimeoutMs` and `resolveStudioEnvironment`, which throw.

#### Scenario: Default is enabled with neither flag nor env var set

- GIVEN neither `--audit-log`/`--no-audit-log` nor `INDIGODB_STUDIO_AUDIT_LOG` is set
- WHEN `indigodb studio` starts and a client writes a row
- THEN a stdout audit log line is emitted for that write

#### Scenario: --no-audit-log disables logging regardless of env var

- GIVEN `INDIGODB_STUDIO_AUDIT_LOG=true` is set
- WHEN `indigodb studio` starts with `--no-audit-log`
- THEN no stdout audit log line is emitted for any write

#### Scenario: Exact-match env var disables logging when no flag is passed

- GIVEN `INDIGODB_STUDIO_AUDIT_LOG=false` (or `=0`) is set and no flag is passed
- WHEN `indigodb studio` starts and a client writes a row
- THEN no stdout audit log line is emitted for that write

#### Scenario: A structurally invalid env value is rejected at startup

- GIVEN `INDIGODB_STUDIO_AUDIT_LOG` is set to `"nope"`, `"no"`, `"TRUE"`, or an empty string
- WHEN `indigodb studio` starts
- THEN the process exits non-zero before binding
- AND the error message names `INDIGODB_STUDIO_AUDIT_LOG` as the source of the invalid value
- AND it is NOT silently treated as either enabled or disabled

### Requirement: Successful writes are logged with column names, never values

A successful write MUST emit exactly one stdout JSON line containing an ISO timestamp, `op`
(`insert`/`update`/`delete`), the table name, the affected row's primary-key value(s), the
**names** of changed columns, the affected row count, and `outcome: "ok"`. The line MUST NOT
contain any non-primary-key column value.

#### Scenario: A distinctive non-PK value never appears in captured stdout

- GIVEN a table has a non-PK column holding a sentinel value (e.g. an email or token)
- WHEN a client inserts, updates, or deletes a row containing that value with audit logging on
- THEN the emitted stdout line contains the column's name but not the sentinel value

#### Scenario: The primary key value appears in the emitted line

- GIVEN a table with a single-column primary key `id`
- WHEN a client updates that row
- THEN the emitted line's primary-key field contains that exact `id` value

### Requirement: The session field is a correlator, not an identity

The optional `session` field MUST be present only when session auth is enabled, and MUST be
derived from the presented session cookie such that it is stable for repeated writes within
the same session, differs across distinct sessions, and is not equal to the cookie value itself
and cannot be used to authenticate as one. No log line, startup line, or documentation string
introduced by this change MUST use `user`, `actor`, or `who`; the field name MUST be `session`.
Two logins minted in the same second MAY produce the same correlator — this collision is
accepted, not hidden.

The correlator's derivation key MUST be random per process, generated at startup, never
persisted, never logged, and **never derived from the shared password or from any secret derived
from it**. This is a security requirement, not an implementation preference: the session cookie's
payload is predictable (`v` is constant, `exp = iat + 86400`, and `iat` is recoverable from the
log line's own timestamp), so its only unknown is a signature that is a deterministic function of
the shared password. Under a keyless digest — or one keyed by a fixed public label, or worse by
the derived session secret itself — anyone holding the log could guess a password offline, mint
the candidate cookie for each plausible `iat`, digest it, and compare. That turns the audit log
into an offline guessing oracle against a human-chosen password, strictly cheaper than attacking
the login route. A per-process random key leaves no candidate value to compare against.

A consequence MUST be accepted rather than engineered away: the key rotates on every restart, so
correlators are comparable only within a single process lifetime.

#### Scenario: No session field when auth is disabled

- GIVEN session auth is not configured
- WHEN a client writes a row with audit logging on
- THEN the emitted line has no `session` field

#### Scenario: Session field is stable across writes in the same session

- GIVEN session auth is enabled and a client holds one valid session cookie
- WHEN that client performs two separate writes
- THEN both emitted lines carry the identical `session` value

#### Scenario: Different sessions produce different correlators

- GIVEN session auth is enabled and two clients each hold a distinct valid session cookie
- WHEN each client performs a write
- THEN the two emitted lines carry different `session` values

#### Scenario: The correlator is not the raw cookie value

- GIVEN session auth is enabled and a client holds a valid session cookie
- WHEN that client writes a row
- THEN the emitted `session` value is not byte-equal to the cookie's value

#### Scenario: Correlators do not survive a restart

- GIVEN session auth is enabled and a client writes a row, producing a `session` value
- WHEN the server is restarted and the same client presents the same still-valid cookie for
  another write
- THEN the newly emitted `session` value differs from the one emitted before the restart
- AND this proves the derivation key was regenerated rather than derived from the password

### Requirement: Startup disclosure line

`indigodb studio` MUST print an `Audit log: enabled`/`Audit log: disabled` startup line
alongside the existing `Auth:`/`Read-only:`/`Environment:` disclosure block.

#### Scenario: Startup line reflects the resolved state

- GIVEN `indigodb studio` starts with audit logging enabled
- WHEN the server finishes startup
- THEN stdout includes an `Audit log: enabled` line before the server accepts connections

### Requirement: stdout is the only sink — no file is created

The system MUST NOT create, open, or write any file, directory, or persisted table as part of
audit logging. All output MUST go to stdout only.

#### Scenario: No file is created by a write with audit logging on

- GIVEN `indigodb studio` starts with audit logging enabled in an empty working directory
- WHEN a client performs several writes
- THEN no new file or directory exists in the working directory or `.indigo/` afterward

### Requirement: Reads are never logged

The system MUST NOT emit an audit log line for any read (`GET /api/query`, `GET /api/tables/:name`,
or a paginated `GET /api/rows/:table`), regardless of audit-log setting.

#### Scenario: A read produces no audit log line

- GIVEN audit logging is enabled
- WHEN a client performs `GET /api/query`, `GET /api/tables/:name`, or a paginated read
- THEN no stdout audit log line is emitted for that request

### Requirement: The status probe is unaffected by audit logging

`GET /api/auth/status` MUST return a response byte-identical to its response before this
change, regardless of the resolved audit-log state. This capability adds no field to the probe.

#### Scenario: Probe response is unaffected by audit log state

- GIVEN two otherwise-identical server instances, one with `--audit-log` and one with
  `--no-audit-log`
- WHEN a client calls `GET /api/auth/status` on each
- THEN both responses are byte-identical to each other and to the response before this change

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
