# Delta for Studio Read-Only Queries

## ADDED Requirements

### Requirement: Pagination parameters are validated and executed under the same read-only guard

`GET /api/tables/:name` MUST accept `cursor`, `direction` (`forward`/`backward`), and `limit`
query parameters, MUST validate/clamp `limit` server-side against the fixed allowed maximum
before use, and MUST run the accompanying `count(*)` query inside the same read-only
transaction as the row fetch. The route MUST NOT trust `limit` as free-form client input.

#### Scenario: Cursor/direction/limit params execute inside the read-only transaction

- GIVEN a table with pagination params supplied
- WHEN a client sends `GET /api/tables/:name?cursor=...&direction=forward&limit=50`
- THEN both the row query and the count query run inside the dedicated
  `BEGIN; SET TRANSACTION READ ONLY;` connection

#### Scenario: Invalid limit is rejected or clamped, never trusted

- GIVEN a client sends `limit=abc` or `limit=100000`
- WHEN the request is processed
- THEN the server validates/clamps the value server-side before querying, and the response
  never reflects an unbounded or non-numeric limit

#### Scenario: Write routes and their transaction remain untouched

- GIVEN the new pagination params are added to `GET /api/tables/:name`
- WHEN a client performs a write via `PATCH`/`POST`/`DELETE`
- THEN `resolveWriteTarget` and the writable-pool code path are unchanged and unaffected by
  this addition
