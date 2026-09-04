# Client Aggregation Specification

## Purpose

`ModelDelegate` MUST expose `aggregate`, `groupBy`, and a `distinct`
`findMany` option, generalizing the SQL shape `count()` already produces.
`_sum`/`_avg` MUST be restricted at the type and runtime level to columns
tagged numeric in `__meta`. `groupBy` in this slice supports grouping plus
aggregation only — no `having`.

## Requirements

### Requirement: `aggregate` computes `_count`/`_sum`/`_avg`/`_min`/`_max` over a `where`

`aggregate({ where?, _count?, _sum?, _avg?, _min?, _max? })` MUST issue one
`SELECT` with the requested aggregate expressions and MUST resolve with an
object keyed identically to the requested aggregate options.

#### Scenario: Multiple aggregates in one call

- GIVEN model `Order` with numeric field `total`
- WHEN a caller calls
  `db.order.aggregate({ _count: true, _sum: { total: true }, _avg: { total: true } })`
- THEN the result MUST have `_count`, `_sum: { total }`, and `_avg: { total }`
  populated from a single query

### Requirement: `_sum`/`_avg` reject non-numeric fields with a typed error

Requesting `_sum` or `_avg` on a field not tagged numeric in generated
`__meta` MUST throw a typed error before any SQL is issued. This MUST hold
both as a compile-time type constraint (the field is not a valid key of the
generated `_sum`/`_avg` arg type) and as a runtime guard for callers that
bypass the type system.

#### Scenario: Runtime rejection of non-numeric _sum field

- GIVEN model `Order` with a non-numeric field `status` (text)
- WHEN a caller calls `db.order.aggregate({ _sum: { status: true } } as any)`
- THEN it MUST throw a typed error before issuing SQL
- AND MUST NOT attempt `SUM("status")` against Postgres

#### Scenario: Compile-time rejection of non-numeric _avg field

- GIVEN model `Order` with a non-numeric field `status`
- WHEN a caller writes `db.order.aggregate({ _avg: { status: true } })`
  without a type-bypassing cast
- THEN this MUST fail to type-check, since `status` is not numeric-tagged

### Requirement: `groupBy` groups by fields and returns aggregates per group

`groupBy({ by: string[], _count?, _sum?, _avg?, _min?, _max?, where? })` MUST
issue one `SELECT ... GROUP BY` statement and MUST resolve with one result
row per distinct combination of the `by` fields, each carrying the requested
aggregates. `having` is explicitly out of scope for this slice.

#### Scenario: Group with a count aggregate

- GIVEN model `Order` with field `status`
- WHEN a caller calls
  `db.order.groupBy({ by: ["status"], _count: true })`
- THEN the result MUST have one row per distinct `status` value present,
  each with `status` and `_count`

#### Scenario: having is not part of the accepted input shape

- GIVEN the generated `groupBy` argument type
- WHEN a caller attempts to pass a `having` key
- THEN this MUST fail to type-check — `having` is not part of the generated
  arg interface in this slice

### Requirement: `distinct` is a `findMany` option, not a standalone method

`findMany({ distinct: string[] })` MUST return at most one row per distinct
combination of the named fields, matching Prisma's `distinct` semantics.
There MUST NOT be a standalone `distinct()` method on `ModelDelegate`.

#### Scenario: distinct narrows findMany results

- GIVEN model `Order` with multiple rows sharing the same `status`
- WHEN a caller calls `db.order.findMany({ distinct: ["status"] })`
- THEN the result MUST contain at most one row per distinct `status` value
