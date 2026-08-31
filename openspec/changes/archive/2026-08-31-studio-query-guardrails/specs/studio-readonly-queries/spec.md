# Delta for Studio Read-Only Queries

## MODIFIED Requirements

### Requirement: Transaction-level read-only enforcement

The system MUST execute both `/api/query` and `/api/tables/:name` reads inside a dedicated
connection running `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = <resolved
queryTimeoutMs>;` before the query, and MUST NOT use the connection/pool shared with any
write-capable code path for these two routes. Postgres's own read-only transaction enforcement
is the authoritative guard against mutation; Postgres's own statement-timeout enforcement is the
authoritative guard against unbounded queries (see `studio-query-guardrails`). A regex or other
text heuristic MAY be kept only as a cheap pre-filter for read-only rejection and MUST NOT be the
sole enforcement mechanism for either guarantee.

(Previously: the preamble issued only `BEGIN; SET TRANSACTION READ ONLY;`, with no statement
timeout, and the "Plain SELECT succeeds" scenario's response shape had no `truncated` field.)

#### Scenario: CTE-wrapped DELETE is rejected by Postgres, not a regex

- GIVEN the Studio server is running against a database containing rows in
  `"User"`
- WHEN a client sends
  `POST /api/query` with body
  `{"sql": "WITH x AS (DELETE FROM \"User\" RETURNING *) SELECT * FROM x"}`
- THEN the query executes inside a read-only transaction on a dedicated
  connection
- AND Postgres itself refuses the statement — not a text heuristic (the exact
  SQLSTATE depends on the execution path: `25006` read-only-transaction on the
  direct path, `0A000` feature-not-supported when the statement is run through
  the row-cap cursor; assertions MUST NOT depend on either code or its message)
- AND the server responds with an error status (4xx) whose body surfaces
  that failure
- AND no row in `"User"` is deleted, added, or modified

#### Scenario: Plain SELECT succeeds

- GIVEN the Studio server is running against a reachable database
- WHEN a client sends `POST /api/query` with a body containing a valid
  read-only `SELECT` statement that returns fewer rows than `queryRowCap`
- THEN the server responds with HTTP 200, the query's columns and rows, and
  `truncated: false`

#### Scenario: /api/tables/:name uses the same enforcement path

- GIVEN a known table name
- WHEN a client sends `GET /api/tables/:name`
- THEN the row fetch executes inside the same dedicated
  `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = ...;`
  connection path used by `/api/query`
- AND the response is unaffected by this change in success cases

#### Scenario: Read-only guard is unaffected by the new write routes

- GIVEN both the read-only pool and the new writable pool are configured
- WHEN a client sends `GET /api/tables/:name` immediately after a successful `PATCH`
  row write
- THEN the `GET` request still executes on the dedicated read-only connection under
  `SET TRANSACTION READ ONLY`
- AND its behavior and response shape are identical to before write routes existed

#### Scenario: A query exceeding statement_timeout is aborted on both routes

- GIVEN `queryTimeoutMs` is configured to a small positive value
- WHEN a client sends `POST /api/query` (or `GET /api/tables/:name`) with a query that runs
  longer than that value
- THEN Postgres aborts the statement due to `statement_timeout`
- AND the server responds with a 4xx status whose body names the timeout as the cause
- AND the connection is returned usable for the next request, not left held
</content>
