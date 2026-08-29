# Delta for Studio Read-Only Queries

## ADDED Requirements

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
