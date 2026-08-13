# Client Batch Mutations Specification

## Purpose

`ModelDelegate` MUST support acting on many rows in one round trip —
`createMany`, `updateMany`, `deleteMany` — for scalar fields only, matching
the single-row `create`/`update`/`delete` semantics already in place, without
opening a second SQL builder (reuses `whereExpr`/`Params`/`quote`).

## Requirements

### Requirement: `createMany` inserts all rows atomically in one statement

`createMany(data: CreateInput[])` MUST issue a single multi-row `INSERT ...
VALUES (...), (...), ...` statement and MUST NOT accept a `skipDuplicates`
option in this slice; a constraint violation on any row MUST fail the whole
call with no rows inserted.

#### Scenario: All rows insert together

- GIVEN a model `Tag` with scalar fields `id`, `name`
- WHEN a caller calls `db.tag.createMany({ data: [{name: "a"}, {name: "b"}] })`
- THEN both rows MUST be inserted in a single statement
- AND the call MUST resolve with `{ count: 2 }`

#### Scenario: One row's constraint violation rolls back the whole batch

- GIVEN a model `Tag` with a unique constraint on `name`, and one existing row
  `name: "a"`
- WHEN a caller calls
  `db.tag.createMany({ data: [{name: "b"}, {name: "a"}] })`
- THEN the statement MUST fail
- AND no row from the batch MUST be persisted (neither `"a"` nor `"b"`)

#### Scenario: Nested relation writes are not accepted

- GIVEN model `Post` with a to-one relation `author`
- WHEN a caller passes `{ author: { create: {...} } }` inside a `createMany`
  data element
- THEN this MUST be a compile-time type error — `createMany`'s input type
  accepts scalar fields only, matching Prisma's `createMany` semantics

### Requirement: `updateMany` and `deleteMany` require a non-empty `where`

`updateMany(args)` and `deleteMany(args)` MUST require an explicit, non-empty
`where` object. Calling either with `where` omitted or `where: {}` MUST throw
`IndigoWhereError` with a new code `EMPTY_WHERE` before any SQL is issued —
there is no whole-table batch mutation without explicit intent in this slice.

#### Scenario: Missing where is rejected

- GIVEN model `Tag`
- WHEN a caller calls `db.tag.updateMany({ data: { name: "x" } })` (no
  `where`)
- THEN it MUST throw `IndigoWhereError` with `code: "EMPTY_WHERE"`
- AND no SQL MUST be issued

#### Scenario: Empty where object is rejected

- GIVEN model `Tag`
- WHEN a caller calls `db.tag.deleteMany({ where: {} })`
- THEN it MUST throw `IndigoWhereError` with `code: "EMPTY_WHERE"`
- AND no SQL MUST be issued

#### Scenario: Non-empty where is accepted

- GIVEN model `Tag` with rows matching `name: "x"`
- WHEN a caller calls `db.tag.updateMany({ where: { name: "x" }, data: { name: "y" } })`
- THEN it MUST issue a single `UPDATE ... WHERE ...` statement
- AND MUST resolve with `{ count: <number of rows matched> }`

### Requirement: Batch mutations return an affected-row count

`updateMany` and `deleteMany` MUST resolve with `{ count: number }` reflecting
the number of rows actually affected, matching the same shape `createMany`
returns.

#### Scenario: deleteMany reports zero when nothing matches

- GIVEN model `Tag` with no rows matching `name: "missing"`
- WHEN a caller calls `db.tag.deleteMany({ where: { name: "missing" } })`
- THEN it MUST resolve with `{ count: 0 }` and MUST NOT throw
</content>
