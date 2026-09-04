# Client Upsert Specification

## Purpose

`ModelDelegate` MUST expose `upsert`, implemented as a single `INSERT ... ON
CONFLICT` statement targeting a declared unique constraint sourced from new
`__meta` unique-constraint groups, rather than a read-then-write race.

## Requirements

### Requirement: `upsert` issues one `ON CONFLICT` statement targeting a declared unique group

`upsert({ where, create, update })` MUST issue a single `INSERT ... ON
CONFLICT (<unique columns>) DO UPDATE SET ...` statement, where the conflict
target is resolved from `where`'s keys matching a declared unique-constraint
group in generated `__meta`.

#### Scenario: Existing row is updated

- GIVEN model `User` with a unique constraint on `email`, and an existing row
  `email: "a@x.com"`
- WHEN a caller calls
  `db.user.upsert({ where: { email: "a@x.com" }, create: {...}, update: { name: "New" } })`
- THEN a single `INSERT ... ON CONFLICT (email) DO UPDATE` statement MUST be
  issued
- AND the result MUST reflect the updated row

#### Scenario: Nonexistent row is created

- GIVEN model `User` with a unique constraint on `email`, no existing row for
  `email: "b@x.com"`
- WHEN a caller calls
  `db.user.upsert({ where: { email: "b@x.com" }, create: { email: "b@x.com", name: "B" }, update: {...} })`
- THEN the same statement MUST insert the row from `create`
- AND the result MUST reflect the newly created row

### Requirement: `where` not matching a declared unique group is rejected with a typed error

If `upsert`'s `where` keys do not exactly match any declared unique-constraint
group (single-column or composite) in `__meta`, the call MUST throw a typed
error before any SQL is issued — there is no valid `ON CONFLICT` target to
generate. The generated type carrying this constraint is
`<Model>WhereUniqueInput`, shared with `update`/`delete` (see the
`client-unique-write-selector` capability); it was previously named
`<Model>UpsertWhereInput` and scoped to `upsert` only. This is a naming
change only — the generated shape, its unique-group derivation, and
`upsert`'s runtime/compile-time behavior are unchanged.

#### Scenario: where on a non-unique field is rejected

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller calls
  `db.user.upsert({ where: { name: "A" } as any, create: {...}, update: {...} })`
- THEN it MUST throw a typed error identifying that `where` matches no
  declared unique-constraint group
- AND no SQL MUST be issued

#### Scenario: Compile-time restriction to declared unique groups

- GIVEN model `User` with `email` unique but `name` not unique
- WHEN a caller writes `db.user.upsert({ where: { name: "A" }, ... })`
  without a type-bypassing cast
- THEN this MUST fail to type-check — `upsert`'s `where` type only accepts
  the declared unique-constraint group shapes, now named
  `<Model>WhereUniqueInput`

#### Scenario: Generated type name is shared with update/delete (non-breaking to upsert callers)

- GIVEN model `User` with a unique constraint on `email`
- WHEN the client is generated
- THEN `db.user.upsert`'s `where` parameter type MUST be `UserWhereUniqueInput`
- AND every existing `upsert` call site that compiled before this rename
  MUST continue to compile unchanged, since the shape of the type is
  identical to the former `UserUpsertWhereInput` — only the name changed

### Requirement: Composite unique groups are supported as a single conflict target

If a model declares a composite unique constraint (multiple columns), `where`
MUST accept the full set of those columns together as one conflict target;
partial matches MUST be rejected the same as a wholly non-unique `where`.

#### Scenario: Composite unique target succeeds

- GIVEN model `Membership` with a composite unique constraint on
  `(userId, orgId)`
- WHEN a caller calls
  `db.membership.upsert({ where: { userId: 1, orgId: 2 }, create: {...}, update: {...} })`
- THEN it MUST issue `ON CONFLICT (userId, orgId) DO UPDATE`

#### Scenario: Partial composite match is rejected

- GIVEN the same composite unique constraint `(userId, orgId)`
- WHEN a caller calls `db.membership.upsert({ where: { userId: 1 } as any, ... })`
- THEN it MUST throw a typed error — `userId` alone does not match the
  declared composite unique group
