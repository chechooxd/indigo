# Studio Read-Only Queries Specification

## Purpose

Studio's SQL console (`POST /api/query`) and table browser
(`GET /api/tables/:name`) MUST NOT be able to mutate the connected database,
regardless of how a write is phrased in SQL. Enforcement MUST rely on
Postgres itself, not on pattern-matching the SQL text.

## Requirements

### Requirement: Transaction-level read-only enforcement

The system MUST execute both `/api/query` and `/api/tables/:name` reads
inside a dedicated connection running `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = <resolved
queryTimeoutMs>;` before the query, and MUST NOT use the connection/pool shared with any
write-capable code path for these two routes. Postgres's own read-only
transaction enforcement is the authoritative guard against mutation; Postgres's own statement-timeout enforcement is the
authoritative guard against unbounded queries (see `studio-query-guardrails`). A regex or other text
heuristic MAY be kept only as a cheap pre-filter for read-only rejection and MUST NOT be the
sole enforcement mechanism for either guarantee.

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
  `BEGIN; SET TRANSACTION READ ONLY;` connection path used by `/api/query`
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

### Requirement: Fast-path pre-filter remains advisory only

The system MAY reject obviously non-read-only input early (e.g. via the
existing `isReadOnlyQuery`-style check) to avoid a round trip to Postgres for
clearly malformed input, but this pre-filter MUST NOT be relied upon as the
authoritative safety boundary.

#### Scenario: Pre-filter rejects obviously invalid input without a DB round trip

- GIVEN a request body containing multiple semicolon-separated statements
- WHEN a client sends `POST /api/query` with that body
- THEN the server MAY reject it before opening a database connection
- AND the response is an error (4xx) explaining only a single read-only
  statement is allowed

### Requirement: Column aliasing preserved for table reads

The system MUST continue aliasing physical column names to their logical
schema field names (e.g. `created_at` → `createdAt`) in
`/api/tables/:name` responses after moving to the transaction-level guard.

#### Scenario: Table read returns logical column names identically

- GIVEN a table whose physical column names differ from their schema field
  names
- WHEN a client sends `GET /api/tables/:name`
- THEN the response `columns` and `rows` use the logical schema field names
- AND this behavior is unchanged from before the transaction-level guard was
  introduced

### Requirement: Pagination parameters are validated and executed under the same read-only guard

`GET /api/tables/:name` MUST accept `cursor`, `direction` (`forward`/`backward`), and `limit`
query parameters, MUST validate `limit` server-side against the fixed allowed set
(`{25, 50, 100, 200}`, default `100` when absent) before use — rejecting any other value with
an HTTP 400 rather than clamping it — and MUST run the accompanying `count(*)` query inside
the same read-only transaction as the row fetch. The route MUST NOT trust `limit` as
free-form client input.

#### Scenario: Cursor/direction/limit params execute inside the read-only transaction

- GIVEN a table with pagination params supplied
- WHEN a client sends `GET /api/tables/:name?cursor=...&direction=forward&limit=50`
- THEN both the row query and the count query run inside the dedicated
  `BEGIN; SET TRANSACTION READ ONLY;` connection

#### Scenario: Invalid limit is rejected, never clamped

- GIVEN a client sends `limit=abc` or `limit=100000`
- WHEN the request is processed
- THEN the server responds `400 { error: "limit must be one of 25, 50, 100, 200" }` before
  running any query, and the response never reflects an unbounded, non-numeric, or
  silently-clamped limit

#### Scenario: Write routes and their transaction remain untouched

- GIVEN the new pagination params are added to `GET /api/tables/:name`
- WHEN a client performs a write via `PATCH`/`POST`/`DELETE`
- THEN `resolveWriteTarget` and the writable-pool code path are unchanged and unaffected by
  this addition
</content>
