# Studio Query Guardrails Specification

## Purpose

Studio's read-only routes (`POST /api/query`, `GET /api/tables/:name`) are safe from mutation
but unbounded: no statement timeout exists, and the SQL console has no row cap. With a `max: 4`
read-only pool in a single `node:http` process, one slow or unqualified query is an availability
risk. This spec covers startup resolution of a query timeout and a row cap, their enforcement,
and their disclosure to the operator and the console UI. Query cancellation is explicitly out of
scope (see `studio-query-cancellation`, not yet proposed).

## Requirements

### Requirement: Query timeout and row cap are resolved once at startup

The system MUST resolve `queryTimeoutMs` and `queryRowCap` once at startup, before the server
binds, via pure functions taking a CLI flag value and an environment variable value, with
precedence CLI flag > environment variable > built-in default. `--query-timeout` pairs with
`INDIGODB_STUDIO_QUERY_TIMEOUT_MS`; `--query-row-cap` pairs with `INDIGODB_STUDIO_QUERY_ROW_CAP`.
Each built-in default MUST be a positive number (guardrails on by default). A resolved value of
exactly `0` MUST disable that guardrail entirely, reproducing pre-change behavior on every path
for that guardrail. Any other non-positive or non-numeric resolved value MUST cause the process
to exit non-zero before binding, with an error message naming the offending flag or environment
variable and stating that it must be a non-negative integer.

#### Scenario: CLI flag takes precedence over the environment variable

- GIVEN `INDIGODB_STUDIO_QUERY_TIMEOUT_MS=5000` is set
- WHEN `indigodb studio` starts with `--query-timeout 9000`
- THEN `GET /api/auth/status` reports `queryTimeoutMs: 9000`

#### Scenario: Environment variable is used when no flag is passed

- GIVEN `INDIGODB_STUDIO_QUERY_ROW_CAP=250` is set and no `--query-row-cap` flag is passed
- WHEN `indigodb studio` starts
- THEN `GET /api/auth/status` reports `queryRowCap: 250`

#### Scenario: Neither flag nor env falls back to a positive built-in default

- GIVEN neither `--query-timeout`/`--query-row-cap` nor their env vars are set
- WHEN `indigodb studio` starts
- THEN `GET /api/auth/status` reports `queryTimeoutMs` and `queryRowCap` as numbers greater than 0

#### Scenario: A value of 0 disables that guardrail

- GIVEN `--query-timeout 0` is passed
- WHEN a client sends `POST /api/query` with a SELECT that would exceed any positive timeout
- THEN the query is not aborted for exceeding a timeout, and `GET /api/auth/status` reports
  `queryTimeoutMs: 0`

#### Scenario: A negative or non-numeric value is rejected at startup

- GIVEN `--query-row-cap -1` or `INDIGODB_STUDIO_QUERY_ROW_CAP=abc` is set
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `--query-row-cap` or `INDIGODB_STUDIO_QUERY_ROW_CAP` and states it
  must be a non-negative integer

### Requirement: statement_timeout is enforced on both read-only routes

The system MUST issue `SET LOCAL statement_timeout` inside the shared `db.readOnly` transaction
preamble, using the resolved `queryTimeoutMs`, so both `/api/query` and `/api/tables/:name` are
bounded. A statement exceeding the timeout MUST be aborted by Postgres; the server MUST respond
with a 4xx status whose body names the timeout as the cause, and the pool connection MUST be
returned usable for the next request (not left open or wedged).

#### Scenario: A query exceeding the timeout is aborted with a named 4xx

- GIVEN `queryTimeoutMs` is configured to a small positive value
- WHEN a client sends `POST /api/query` with a SELECT that runs longer than that value
- THEN the server responds with a 4xx status whose body names the statement timeout as the cause
- AND a subsequent unrelated request succeeds normally, proving the pool connection was released

#### Scenario: A slow table read is bounded by the same timeout

- GIVEN `queryTimeoutMs` is configured to a small positive value
- WHEN a client sends `GET /api/tables/:name` against a table whose `count(*)` or row fetch runs
  longer than that value
- THEN the server responds with a 4xx status whose body names the statement timeout as the cause

#### Scenario: Write routes are never subject to the query timeout

- GIVEN `queryTimeoutMs` is configured to a small positive value
- WHEN a client performs a write via `PATCH`/`POST`/`DELETE` on a row route that itself runs
  longer than `queryTimeoutMs`
- THEN the write is not aborted for exceeding `queryTimeoutMs`, and its response is unchanged
  from before this change

### Requirement: /api/query enforces a row cap with an explicit truncation flag

The system MUST cap the number of rows returned by `POST /api/query` to `queryRowCap`, without
rewriting the submitted SQL in any way that changes its semantics (e.g. it MUST NOT inject or
alter a `LIMIT`, `WHERE`, or aggregate clause in the client's statement). The response MUST
include a `truncated: boolean` field: `true` when more rows existed than `queryRowCap`, `false`
otherwise. `GET /api/tables/:name` MUST NOT be affected by `queryRowCap`; its row limit remains
governed exclusively by `studio-table-pagination`'s `limit` parameter.

#### Scenario: A result under the cap is not marked truncated

- GIVEN a SELECT whose result set has fewer rows than `queryRowCap`
- WHEN a client sends that SELECT to `POST /api/query`
- THEN the response contains every matching row and `truncated: false`

#### Scenario: A result over the cap is capped and marked truncated

- GIVEN a SELECT whose result set has more rows than `queryRowCap`
- WHEN a client sends that SELECT to `POST /api/query`
- THEN the response contains exactly `queryRowCap` rows and `truncated: true`

#### Scenario: A user-supplied LIMIT smaller than the cap is respected unchanged

- GIVEN a SELECT that itself contains `LIMIT n` where `n` is smaller than `queryRowCap`
- WHEN a client sends that SELECT to `POST /api/query`
- THEN the response contains exactly `n` rows and `truncated: false`

#### Scenario: /api/tables/:name ignores queryRowCap

- GIVEN `queryRowCap` is configured smaller than a table's requested page `limit`
- WHEN a client sends `GET /api/tables/:name?limit=200`
- THEN the response page size is governed only by the `limit` parameter and
  `studio-table-pagination`'s allowed set, unaffected by `queryRowCap`

### Requirement: Status probe and console UI disclose both guardrail values

`GET /api/auth/status` MUST report `queryTimeoutMs: number` and `queryRowCap: number` reflecting
the exact resolved startup values, independent of auth state (available with no session, per
`studio-session-auth`'s exempt-route contract). The SQL console UI MUST display `queryRowCap` and
MUST render a visible indicator when a response has `truncated: true`, and MUST render a message
naming the timeout when a query is rejected for exceeding it.

#### Scenario: Truncated response shows a visible banner in the console

- GIVEN the SQL console receives a `POST /api/query` response with `truncated: true`
- WHEN the results render
- THEN the console displays a visible indicator that the result set was truncated

#### Scenario: Timeout error is shown with an actionable message

- GIVEN the SQL console receives a 4xx response naming the statement timeout as the cause
- WHEN the error renders
- THEN the console displays a message stating the query exceeded the configured timeout

### Requirement: No query cancellation is introduced

The system MUST NOT expose any route, UI control, or backend mechanism to cancel an in-flight
query in this change. `statement_timeout` and `queryRowCap` are the complete guardrail surface
here; cancellation is deferred to a future `studio-query-cancellation` change.

#### Scenario: No cancel affordance exists

- GIVEN the SQL console is showing an in-flight query
- WHEN the operator inspects the UI and the API surface
- THEN no cancel button, cancel route, or `pg_cancel_backend` call is present
