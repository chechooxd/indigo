# Studio Table Pagination Specification

## Purpose

`GET /api/tables/:name` MUST let a client reliably traverse an entire table, forward and
backward, through a stable keyset cursor keyed on the table's primary key, with a bounded,
server-authoritative page size and an exact total row count.

## Requirements

### Requirement: Stable PK-ordered keyset pagination

The system MUST order every table read by the table's primary-key column(s) ascending, and
MUST paginate via a keyset cursor over that PK (composite-safe through Postgres row-value
comparison, e.g. `(pk1, pk2) > ($1, $2)`), never via `OFFSET`.

#### Scenario: Two consecutive loads of the same page agree

- GIVEN a table with more rows than one page
- WHEN the same page is requested twice with no intervening writes
- THEN both responses contain the same rows in the same order

#### Scenario: Composite-PK table pages without duplicates or gaps

- GIVEN a table with a two-column primary key and rows spanning multiple pages
- WHEN a client pages forward through the entire table
- THEN every row appears exactly once and none is skipped

### Requirement: Bidirectional keyset traversal

The system MUST support both `direction=forward` and `direction=backward` cursor requests,
and paging forward then backward from any page MUST return to the same rows as before.

#### Scenario: Forward then back returns the same page

- GIVEN a client has fetched page 2 by paging forward from page 1
- WHEN the client requests the previous page using page 2's cursor with `direction=backward`
- THEN the response rows exactly match page 1's original rows and order

#### Scenario: Boundaries are detected correctly

- GIVEN a client is on the first page
- WHEN it inspects pagination affordances
- THEN no backward cursor is returned, and separately, on the last page no forward cursor is
  returned

### Requirement: Bounded, server-authoritative page size

The system MUST accept an optional `limit` query parameter and MUST NOT return more rows
than the maximum allowed page size (200), regardless of what value the client sends. This
guarantee is enforced by rejecting any request whose `limit` is not exactly one of the
closed set `{25, 50, 100, 200}`, never by clamping an out-of-set value to the nearest
member of that set. When `limit` is absent, the system MUST default to 100.

#### Scenario: Valid page size changes the fetched count

- GIVEN a table with more than 200 rows
- WHEN a client requests `limit=25`, then `limit=200`
- THEN each response contains at most the requested number of rows

#### Scenario: A valid limit from the closed set is accepted and used exactly as requested

- GIVEN a table with more than 200 rows
- WHEN a client requests `limit=25`, `limit=50`, `limit=100`, or `limit=200`
- THEN the request succeeds and the response's page contains exactly that many rows
  (or fewer only if the table itself has fewer remaining rows)

#### Scenario: Absent limit defaults to 100

- GIVEN a table with more than 100 rows
- WHEN a client requests a page without specifying `limit`
- THEN the response's page contains exactly 100 rows (or fewer only if the table has
  fewer remaining rows)

#### Scenario: Out-of-range or malformed limit is rejected, never clamped

- GIVEN a client sends `limit=999999`, `limit=0`, `limit=50.0`, or a non-numeric `limit`
- WHEN the request is processed
- THEN the system MUST respond with HTTP 400 and the exact error message
  `limit must be one of 25, 50, 100, 200`, and MUST NOT execute any database query

### Requirement: Exact total row count

The system MUST return an exact `SELECT count(*)` total alongside every page.

#### Scenario: Total count matches the table's real row count

- GIVEN a table with a known row count
- WHEN any page is requested
- THEN the response's total count field equals that exact row count

### Requirement: PK-less tables short-circuit to a single unpaginated page

A table whose resolved `primaryKey` is empty MUST return one page using today's behavior
(no `ORDER BY`, `LIMIT` only) and MUST set `paginated: false` in the response.

#### Scenario: PK-less table returns one page with an honest flag

- GIVEN a table with an empty `primaryKey`
- WHEN a client requests it, with or without cursor/direction/limit params
- THEN the response contains a single page of rows, no `ORDER BY` behavior change, and
  `paginated: false`
