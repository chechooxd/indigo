# Client Cursor Pagination Specification

## Purpose

`findMany` MUST support stable "next page" pagination via `cursor` + `take`,
alongside existing offset (`skip`/`take`) pagination, for models with a
single-column primary key. Composite primary keys are explicitly out of
scope for this slice.

## Requirements

### Requirement: `cursor` + `take` page from a given row, ordered by primary key

`findMany({ cursor, take })` MUST accept a `cursor` identifying a single row
by its primary-key value and MUST return up to `take` rows starting
immediately after that row, ordered by the primary key (or by `orderBy` if
also supplied, with the primary key as tiebreaker).

#### Scenario: Cursor pages forward from the given row

- GIVEN model `Post` with single-column primary key `id` and rows
  `id: 1..10`
- WHEN a caller calls `db.post.findMany({ cursor: { id: 5 }, take: 3 })`
- THEN the result MUST be exactly the rows with `id: 6, 7, 8`, in that order

#### Scenario: cursor combined with an explicit orderBy

- GIVEN model `Post` with primary key `id` and a `createdAt` column
- WHEN a caller calls
  `db.post.findMany({ orderBy: { createdAt: "asc" }, cursor: { id: 5 }, take: 3 })`
- THEN the result MUST be ordered by `createdAt` ascending, resuming
  immediately after the row identified by the cursor
- AND `id` MUST be used as a deterministic tiebreaker for rows with equal
  `createdAt`

#### Scenario: cursor pointing at a nonexistent row yields an empty page

- GIVEN model `Post` with no row `id: 999`
- WHEN a caller calls `db.post.findMany({ cursor: { id: 999 }, take: 5 })`
- THEN the result MUST be an empty array
- AND MUST NOT throw

### Requirement: Composite primary keys reject `cursor` with a typed error

Calling `findMany` with a `cursor` option on a model whose primary key spans
more than one column MUST throw a typed error before any SQL is issued,
naming the limitation explicitly. Offset pagination (`skip`/`take`) on such
models MUST remain unaffected.

#### Scenario: Composite-PK model rejects cursor

- GIVEN model `Enrollment` with composite primary key `(studentId, courseId)`
- WHEN a caller calls `db.enrollment.findMany({ cursor: { studentId: 1, courseId: 2 }, take: 5 })`
- THEN it MUST throw a typed error identifying the composite-PK limitation
- AND no SQL MUST be issued

#### Scenario: Composite-PK model still supports offset pagination

- GIVEN model `Enrollment` with composite primary key `(studentId, courseId)`
- WHEN a caller calls `db.enrollment.findMany({ skip: 10, take: 5 })`
- THEN the call MUST succeed exactly as it did before this capability existed

### Requirement: Single-column PK models are unaffected when `cursor` is omitted

Existing offset-only `findMany` calls on single-column PK models MUST behave
identically to before this capability existed when `cursor` is not supplied.

#### Scenario: No cursor means no behavior change

- GIVEN model `Post` with single-column primary key `id`
- WHEN a caller calls `db.post.findMany({ take: 10 })` with no `cursor`
- THEN behavior MUST be identical to pre-existing offset pagination
