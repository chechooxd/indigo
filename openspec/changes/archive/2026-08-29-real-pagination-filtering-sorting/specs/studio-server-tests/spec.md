# Delta for Studio Server Tests

## ADDED Requirements

### Requirement: Coverage of bidirectional keyset pagination

The harness MUST cover forward and backward keyset traversal for single-column and
composite primary keys, limit validation (reject-only, never clamped), exact count accuracy, the PK-less
short-circuit, and a regression proving the read-only guard and write routes are unaffected.

#### Scenario: Forward-then-back round trip matches original rows

- GIVEN a seeded table with more rows than one page
- WHEN the harness pages forward one page, then back using `direction=backward`
- THEN the returned rows exactly match the original first page

#### Scenario: Composite-PK forward and backward traversal

- GIVEN a seeded table with a two-column primary key spanning multiple pages
- WHEN the harness pages forward through the whole table and then back to the start
- THEN every row appears exactly once each direction, matching between passes

#### Scenario: First/last page boundaries are detected

- GIVEN a seeded table with exactly two pages at the configured page size
- WHEN the harness requests the first page, then the last page
- THEN the first page's response carries no backward cursor and the last page's response
  carries no forward cursor

#### Scenario: Limit validation never exceeds the hard maximum

- GIVEN a seeded table with more than 200 rows
- WHEN the harness sends `limit=999999` and separately `limit=abc`
- THEN neither response contains more than 200 rows

#### Scenario: Exact count is asserted

- GIVEN a seeded table with a known row count
- WHEN the harness requests any page
- THEN the response's total count field equals that exact known count

#### Scenario: PK-less table short-circuits correctly

- GIVEN a seeded table with no primary key
- WHEN the harness requests it with pagination params supplied
- THEN the response is a single unpaginated page with `paginated: false`

#### Scenario: Read-only guard and write routes remain unaffected

- GIVEN the pagination params are added to `GET /api/tables/:name`
- WHEN the harness re-runs the CTE-wrapped `DELETE` regression and the existing write-route
  scenarios
- THEN all continue to pass exactly as before this change
