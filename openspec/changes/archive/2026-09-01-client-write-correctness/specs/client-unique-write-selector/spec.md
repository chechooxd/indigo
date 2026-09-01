# Client Unique Write Selector Specification

## Purpose

`ModelDelegate.update`/`.delete`'s `where` currently accepts any
`WhereInput<Row>` — the same broad shape `findMany`/`updateMany`/`deleteMany`
use — so a single call intended to target one row can silently match many.
This capability restricts `update`/`delete`'s `where` to `<Model>WhereUniqueInput`
(a declared unique-constraint group), at compile time and, for `as any`
bypasses, at runtime before any SQL is issued. `<Model>WhereUniqueInput` is
the renamed, shared successor of `<Model>UpsertWhereInput` (see the
`client-upsert` delta) — no parallel type is introduced.

## Requirements

### Requirement: `update`/`delete` `where` is restricted to a declared unique group at compile time

Generated `<Model>UpdateArgs`/`<Model>DeleteArgs` MUST type `where` as
`<Model>WhereUniqueInput` — the same generated union of declared unique-group
shapes used by `upsert` — instead of the full `WhereInput<Row>`. A `where`
value that does not match one of those shapes MUST fail to type-check without
a bypassing cast.

#### Scenario: A declared unique-group where type-checks

- GIVEN model `User` with a unique constraint on `email`
- WHEN a caller writes `db.user.update({ where: { email: "a@x.com" }, data: { name: "New" } })`
- THEN this MUST type-check without any cast

#### Scenario: A non-unique-looking where fails to type-check

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller writes `db.user.update({ where: { name: "A" }, data: { name: "New" } })`
  without a type-bypassing cast
- THEN this MUST fail to type-check

#### Scenario: findUnique is unaffected (non-regression)

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller writes `db.user.findUnique({ where: { name: "A" } })`
- THEN this MUST continue to type-check and MUST resolve with `Payload | null`,
  unchanged by this capability

#### Scenario: updateMany/deleteMany keep the broad where (non-regression)

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller writes `db.user.updateMany({ where: { name: "A" }, data: { name: "New" } })`
  or `db.user.deleteMany({ where: { name: "A" } })`
- THEN both MUST continue to type-check against the full `WhereInput<Row>`,
  unchanged by this capability

### Requirement: A `where` bypassing the type restriction is rejected at runtime before SQL

If a caller bypasses the compile-time restriction (e.g. `as any`) and passes
a `where` that does not exactly match a declared unique-constraint group,
`update`/`delete` MUST throw `IndigoArgumentError` with
`code: "NO_MATCHING_UNIQUE_CONSTRAINT"` before any SQL is issued, mirroring
`upsert`'s existing `resolveUpsertConflictTarget` guard.

#### Scenario: as any bypass with a non-unique where throws pre-SQL

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller calls `db.user.update({ where: { name: "A" } as any, data: { name: "New" } })`
- THEN it MUST throw `IndigoArgumentError` with `code: "NO_MATCHING_UNIQUE_CONSTRAINT"`
- AND no SQL MUST be issued

#### Scenario: as any bypass with a valid unique where is accepted

- GIVEN model `User` with `email` unique
- WHEN a caller calls `db.user.delete({ where: { email: "a@x.com" } as any })`
- THEN the call MUST proceed normally — the runtime guard MUST NOT reject a
  value that genuinely matches a declared unique group

### Requirement: `update` with relation ops and an ambiguous `where` still throws `AMBIGUOUS_UPDATE_TARGET`

The pre-existing `AMBIGUOUS_UPDATE_TARGET` guard on `updateImpl`'s
relation-ops planner path (triggered when more than one row matches `where`
with relation ops present) MUST remain in force and MUST NOT be shadowed,
replaced, or bypassed by the new unique-selector guard. The two guards
protect different failure surfaces (unique-shape validity vs. actual
multi-row match) and both apply.

#### Scenario: Relation ops with a where that passes the unique-shape guard but matches multiple rows still throws AMBIGUOUS_UPDATE_TARGET

- GIVEN model `User` whose generated `__meta.uniqueGroups` declares
  `["name"]` as unique but the underlying database has no matching unique
  constraint on `name` (constraint dropped in the database while the
  generated meta still declares it), and two rows share `name: "Dup"`, and
  `data` contains relation operations
- WHEN a caller calls `db.user.update({ where: { name: "Dup" }, data: { posts: { connect: { id: 1 } } } })`
- THEN `where` MUST pass the unique-shape check (its keys match the declared
  `["name"]` group)
- AND the call MUST throw `IndigoNestedWriteError` with `code: "AMBIGUOUS_UPDATE_TARGET"`
  once the underlying match count resolves to 2 rows
- AND this MUST fire even though `where` already passed the
  `NO_MATCHING_UNIQUE_CONSTRAINT` shape check

### Requirement: A model with no declared unique group cannot call `update`/`delete` in the typed client

If a model declares no unique constraint (no PK, no `@unique` column, no
unique `@@index`/`@@unique` group), its generated `<Model>WhereUniqueInput`
MUST resolve to `never`, making `update`/`delete` uncallable at compile time
for that model — the same limitation `upsert` already imposes.
`updateMany`/`deleteMany` MUST remain available on that model, unaffected.

#### Scenario: No-unique-group model cannot call update/delete

- GIVEN a model `Log` with no PK, no `@unique` column, and no unique
  `@@index`/`@@unique` group
- WHEN the client is generated
- THEN `LogWhereUniqueInput` MUST resolve to `never`
- AND any attempted `db.log.update(...)` or `db.log.delete(...)` call MUST
  fail to type-check

#### Scenario: updateMany/deleteMany remain callable on that model

- GIVEN the same model `Log` with no declared unique group
- WHEN a caller calls `db.log.updateMany({ where: { level: "error" }, data: { level: "warn" } })`
- THEN this MUST type-check and execute normally, since `updateMany` uses
  the full `WhereInput<Row>`, unaffected by this capability
</content>
