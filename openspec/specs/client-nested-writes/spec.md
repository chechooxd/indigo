# Client Nested Writes Specification

## Purpose

Generated `ModelDelegate.create`/`.update` MUST accept relation
sub-operations (`create`, `connect`, `connectOrCreate`, `disconnect`, `set`)
inside `data`, one level deep, and execute them atomically alongside the
parent row write. This closes two gaps: relation aggregates today require
hand-rolled multi-statement sequences with no atomicity guarantee, and an
unrecognized `data` key today falls through to a raw SQL column reference
instead of being rejected. Depth ≥ 2, nested `update`/`upsert`/`deleteMany`,
and `include` on the write return value are out of scope.

## Requirements

### Requirement: `create` sub-operation on relations

`data.<relation>` MUST accept `{ create: {...} | [...] }` for to-one and
to-many relations, creating the related row(s) as part of the same write.

#### Scenario: to-one create nested under parent create

- GIVEN model `Post` with required to-one relation `author`
- WHEN `db.post.create({ data: { title: "x", author: { create: { name: "A" } } } })` is called
- THEN the author row MUST be inserted before the post row
- AND the post row's FK column MUST reference the newly created author

#### Scenario: to-many create nested under parent create

- GIVEN model `User` with to-many relation `posts`
- WHEN `db.user.create({ data: { name: "A", posts: { create: [{ title: "x" }] } } })` is called
- THEN the user row MUST be inserted first
- AND each post row MUST be inserted afterward with its FK set to the new user

### Requirement: `connect` and `connectOrCreate` sub-operations

`data.<relation>` MUST accept `{ connect: <uniqueWhere> }` (or an array for
to-many) to link an existing row by its unique identifier, and
`{ connectOrCreate: { where, create } }` to connect if found or create
otherwise. A `connect` (or the lookup half of `connectOrCreate`) that
matches no row MUST throw a typed error — it MUST NOT silently no-op.

#### Scenario: connect links an existing row

- GIVEN an existing `Author` row with `id: 1`
- WHEN `db.post.create({ data: { title: "x", author: { connect: { id: 1 } } } })` is called
- THEN the post row's FK MUST be set to author `1`
- AND no new author row MUST be inserted

#### Scenario: connect to a non-existent row throws

- GIVEN no `Author` row exists with `id: 999`
- WHEN `db.post.create({ data: { title: "x", author: { connect: { id: 999 } } } })` is called
- THEN the call MUST reject with a typed "record not found" error
- AND the transaction MUST roll back with no post row inserted

#### Scenario: connectOrCreate falls back to create when not found

- GIVEN no `Author` row matches `{ email: "a@x.com" }`
- WHEN `db.post.create({ data: { author: { connectOrCreate: { where: { email: "a@x.com" }, create: { email: "a@x.com", name: "A" } } } } })` is called
- THEN a new author row MUST be created and linked
- AND no error MUST be thrown solely because the lookup found nothing

#### Scenario: Top-level update with relation-ops-only data and zero matching rows throws (behavior flip)

- GIVEN model `Post` with no row matching `id: 999`
- WHEN `db.post.update({ where: { id: 999 }, data: { author: { connect: { id: 1 } } } })` is called (no scalar fields in `data`)
- THEN the call MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND it MUST NOT resolve with `undefined` — this supersedes the previous behavior asserted by `nested-writes-update.mjs` case C1.4c, which is rewritten as part of this change to expect the throw instead of a silent `undefined` result

### Requirement: `disconnect` and `set` on to-many relations

`data.<relation>` MUST accept `disconnect` (unlink specific rows) and `set`
(replace the full linked set) for to-many relations. `set: []` MUST
disconnect every currently linked row.

#### Scenario: set replaces the linked set

- GIVEN a user currently linked to posts `[1, 2, 3]`
- WHEN `db.user.update({ where: { id: 1 }, data: { posts: { set: [{ id: 2 }] } } })` is called
- THEN posts `1` and `3` MUST become unlinked (FK cleared)
- AND post `2` MUST remain linked

#### Scenario: set with an empty array disconnects everything

- GIVEN a user currently linked to posts `[1, 2]`
- WHEN `data: { posts: { set: [] } }` is applied
- THEN both posts MUST become unlinked
- AND no post row MUST be deleted

### Requirement: `disconnect`/`set` on a required to-one relation is a typed error

When a to-one relation's foreign key is non-nullable (`optional: false` in
`__meta`), `disconnect` or `set` on it MUST reject with a typed error
instead of deleting or orphaning the parent row. Optional to-one relations
MUST support `disconnect`/`set` by clearing the FK to `null`.

#### Scenario: disconnect on a required relation is rejected

- GIVEN `Post.author` is a required (non-nullable) to-one relation
- WHEN `db.post.update({ where: { id: 1 }, data: { author: { disconnect: true } } })` is called
- THEN the call MUST reject with a typed error naming the relation as required
- AND the post row MUST be unchanged

#### Scenario: disconnect on an optional relation clears the FK

- GIVEN `Post.editor` is an optional to-one relation
- WHEN `data: { editor: { disconnect: true } }` is applied
- THEN the post's editor FK column MUST become `null`
- AND the editor row itself MUST NOT be deleted

### Requirement: Unrecognized relation/data keys are rejected

Any key under `data` that does not match a scalar field or a declared
relation on the model MUST cause a typed error at call time. It MUST NOT be
passed through to SQL as a literal column name.

#### Scenario: unknown key throws instead of producing invalid SQL

- GIVEN model `User` with no field or relation named `notAField`
- WHEN `db.user.create({ data: { notAField: "x" } })` is called
- THEN the call MUST reject with a typed "unknown field" error
- AND no SQL statement referencing `notAField` MUST be issued

### Requirement: Atomic execution, ordered by FK direction

Every nested write for one top-level `create`/`update` call MUST execute in
a single transaction: to-one relation writes before the parent row write
(the parent needs their key), to-many relation writes after (they need the
parent's key). A failure in any sub-operation MUST roll back the entire
call — no partial parent or child rows persist.

#### Scenario: a failing nested write rolls back the parent

- GIVEN `db.user.create({ data: { name: "A", posts: { create: [{ title: "x" }, { title: null }] } } })` where the second post violates a NOT NULL constraint
- WHEN the call is executed
- THEN the entire call MUST reject
- AND neither the user row nor any post row MUST exist afterward
