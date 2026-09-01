# Delta for Client Nested Writes

## MODIFIED Requirements

### Requirement: `connect` and `connectOrCreate` sub-operations

`data.<relation>` MUST accept `{ connect: <uniqueWhere> }` (or an array for
to-many) to link an existing row by its unique identifier, and
`{ connectOrCreate: { where, create } }` to connect if found or create
otherwise. A `connect` (or the lookup half of `connectOrCreate`) that
matches no row MUST throw a typed error — it MUST NOT silently no-op.
Additionally, when the top-level `update` call's own `data` contains only
relation operations (no scalar fields) and `where` matches zero rows, the
call MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"` instead
of resolving with `undefined`.
(Previously: only the nested `connect`/`connectOrCreate` not-found case was
specified here; the top-level relation-ops-only zero-match case was
unspecified and the implementation silently resolved with `undefined`.)

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
- WHEN `db.post.update({ where: { id: 999 }, data: { author: { connect: { id: 1 } } } })` is
  called (no scalar fields in `data`)
- THEN the call MUST throw `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND it MUST NOT resolve with `undefined` — this supersedes the previous
  behavior asserted by `nested-writes-update.mjs` case C1.4c, which is
  rewritten as part of this change to expect the throw instead of a silent
  `undefined` result
</content>
