# Delta for Client Upsert

## MODIFIED Requirements

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
(Previously: the type was named `<Model>UpsertWhereInput` and was not shared
with any other operation.)

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
</content>
