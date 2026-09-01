# Client Write Preconditions Specification

## Purpose

`ModelDelegate.update`/`.delete` MUST validate two preconditions before
issuing SQL, and MUST NOT lie about the outcome of a zero-row write:
an all-`undefined` `data` on the direct scalar path currently emits invalid
SQL (`UPDATE "t" SET  WHERE …`), and a zero-row match at any of `update`'s two
write paths or `delete` returns a value statically typed as the written row
but actually `undefined` at runtime. Both are pre-existing defects, not new
behavior; this capability makes them typed, thrown failures instead.

## Requirements

### Requirement: Empty `SET` is rejected before SQL on the direct scalar update path

`update({ where, data })` MUST throw `IndigoArgumentError` with
`code: "EMPTY_UPDATE_DATA"` before any SQL is issued when `data`, after
filtering `undefined` values, contains zero scalar assignments AND no
relation operations are present. This closes the direct scalar-only path
(`rawUpdate`), which is not covered by the pre-existing relation-ops guard.

#### Scenario: All-undefined data with no relation ops throws pre-SQL

- GIVEN model `User` with scalar fields `id`, `name`, `email`
- WHEN a caller calls `db.user.update({ where: { id: 1 }, data: { name: undefined, email: undefined } })`
- THEN it MUST throw `IndigoArgumentError` with `code: "EMPTY_UPDATE_DATA"`
- AND no SQL statement MUST be issued

#### Scenario: Relation-ops-only empty-scalar guard remains in force (regression guard)

- GIVEN model `Post` with to-one relation `author` and no scalar fields in `data`
- WHEN a caller calls `db.post.update({ where: { id: 1 }, data: { author: { connect: { id: 2 } } } })`
- THEN the pre-existing empty-`finalScalars` guard on the relation-ops planner path MUST still apply unchanged
- AND this scenario MUST NOT regress as a side effect of the new direct-path guard

#### Scenario: A single defined scalar assignment is accepted

- GIVEN model `User`
- WHEN a caller calls `db.user.update({ where: { id: 1 }, data: { name: "New", email: undefined } })`
- THEN the call MUST proceed and issue `UPDATE "user" SET "name" = $1 WHERE ...`

### Requirement: Zero-row `update`/`delete` throws a typed not-found error at every write path

`update` and `delete` MUST throw a new `IndigoNotFoundError` with
`code: "RECORD_NOT_FOUND"` whenever the write matches zero rows, at all
three affected sites: the direct scalar `rawUpdate` path, the `deleteImpl`
path, and `updateImpl`'s relation-ops-only branch. None of the three MUST
resolve with `undefined` typed as the row on a zero-row match.

#### Scenario: Zero-row update on the direct scalar path throws

- GIVEN model `User` with no row matching `id: 999`
- WHEN a caller calls `db.user.update({ where: { id: 999 }, data: { name: "New" } })`
- THEN it MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND the promise MUST NOT resolve with `undefined`

#### Scenario: Zero-row delete throws

- GIVEN model `User` with no row matching `id: 999`
- WHEN a caller calls `db.user.delete({ where: { id: 999 } })`
- THEN it MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND the promise MUST NOT resolve with `undefined`

#### Scenario: Zero-row update on the relation-ops-only branch throws

- GIVEN model `Post` with no row matching `id: 999` and `data` containing only relation operations (no scalar fields)
- WHEN a caller calls `db.post.update({ where: { id: 999 }, data: { author: { connect: { id: 1 } } } })`
- THEN it MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND no partial write MUST be committed

#### Scenario: A matching update still resolves with the updated row

- GIVEN model `User` with an existing row `id: 1`
- WHEN a caller calls `db.user.update({ where: { id: 1 }, data: { name: "New" } })`
- THEN the call MUST resolve with the updated row
- AND MUST NOT throw `IndigoNotFoundError`
