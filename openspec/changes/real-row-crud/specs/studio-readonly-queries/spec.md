# Delta for Studio Readonly Queries

## MODIFIED Requirements

### Requirement: Transaction-level read-only enforcement

The system MUST execute both `/api/query` and `/api/tables/:name` reads inside a
dedicated connection running `BEGIN; SET TRANSACTION READ ONLY;` before the query, and
MUST NOT use the connection/pool shared with any write-capable code path for these two
routes. Postgres's own read-only transaction enforcement is the authoritative guard; a
regex or other text heuristic MAY be kept only as a cheap pre-filter and MUST NOT be the
sole enforcement mechanism. The new row-write routes (`POST`/`PATCH`/`DELETE`) MUST use a
separate writable pool and MUST NOT share this read-only connection path.
(Previously: scope only distinguished this path from "any write-capable code path" in
the abstract; no write routes existed yet to verify the separation against.)

#### Scenario: CTE-wrapped DELETE is rejected by Postgres, not a regex

- GIVEN the Studio server is running against a database containing rows in `"User"`
- WHEN a client sends `POST /api/query` with body
  `{"sql": "WITH x AS (DELETE FROM \"User\" RETURNING *) SELECT * FROM x"}`
- THEN the query executes inside a read-only transaction on a dedicated connection
- AND Postgres raises a read-only-transaction error
- AND the server responds with an error status (4xx) whose body surfaces that failure
- AND no row in `"User"` is deleted, added, or modified

#### Scenario: Plain SELECT succeeds

- GIVEN the Studio server is running against a reachable database
- WHEN a client sends `POST /api/query` with a body containing a valid read-only
  `SELECT` statement
- THEN the server responds with HTTP 200 and the query's columns and rows

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
</content>
