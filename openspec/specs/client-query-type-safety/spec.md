# Client Query Type Safety Specification

## Purpose

Generated `ModelDelegate` read methods (`findMany`, `findFirst`, `findUnique`)
MUST return TypeScript types that narrow to exactly the fields and relations a
caller requested via `select` and/or `include`. This closes a pre-existing gap
where `select` narrowed the emitted SQL and runtime row shape but never the
compile-time return type, so callers could access excluded fields without a
type error even though the value was runtime-absent. `include`, introduced by
the sibling `client-relation-loading` capability, MUST ship type-honest from
day one rather than repeating that gap.

An accepted implementation-time deviation exists for cases where full
conditional (`GetPayload`-style) type narrowing proves intractable during
implementation: see "Accepted fallback" below. That fallback does not weaken
the requirement below — it is a documented, user-confirmed escape hatch to be
exercised only if needed, and resolved concretely in design/tasks.

## Requirements

### Requirement: Return type narrows to exactly the requested `select`/`include` shape

For any call to `findMany`, `findFirst`, or `findUnique` that passes a `select`
and/or `include` option, the statically inferred return type MUST reflect
exactly the requested shape: scalar fields present are exactly those named
`true` in `select` (or all scalar fields when no `select` is given), and
relation keys present are exactly those named in `include`, narrowed further by
any nested `select` on that relation. Fields and relations not requested MUST
NOT be part of the inferred type.

#### Scenario: select narrows the return type to chosen scalars

- GIVEN a model `User` with scalar fields `id`, `email`, `name`
- WHEN a caller writes `db.user.findMany({ select: { id: true, email: true } })`
- THEN the inferred element type of the result MUST have exactly `id` and
  `email` as accessible fields
- AND `name` MUST NOT be a valid property to read on that inferred type

#### Scenario: include narrows the return type to add the relation key

- GIVEN a model `User` with list relation `posts`
- WHEN a caller writes `db.user.findMany({ include: { posts: true } })`
- THEN the inferred element type MUST include a `posts` property typed as an
  array of the full `Post` row shape
- AND a model `User` fetched without `include: { posts: true }` MUST NOT have
  a `posts` property on its inferred type

#### Scenario: nested select narrows the included relation's inferred shape

- GIVEN a model `User` with list relation `posts` (fields `id`, `title`, `body`)
- WHEN a caller writes
  `db.user.findMany({ include: { posts: { select: { title: true } } } })`
- THEN the inferred type of each element of `posts` MUST have exactly `title`
  as an accessible field
- AND `body` MUST NOT be a valid property to read on that inferred `posts`
  element type

### Requirement: Accessing an excluded field or non-included relation is a compile-time error

Reading a scalar field excluded by `select`, or a relation not named in
`include`, on the result of a narrowed query MUST fail TypeScript compilation.
This MUST hold for both plain excluded scalars and for relations, closing the
"select narrows SQL but not the type" gap this capability exists to fix.

#### Scenario: excluded scalar field is a compile error

- GIVEN `const users = await db.user.findMany({ select: { id: true } })`
- WHEN calling code writes `users[0].email`
- THEN this MUST fail to type-check
- AND MUST NOT compile even though `email` may be runtime-present via any
  incidental implementation detail

#### Scenario: non-included relation is a compile error

- GIVEN `const users = await db.user.findMany()` (no `include`)
- WHEN calling code writes `users[0].posts`
- THEN this MUST fail to type-check, since `posts` was never requested

### Requirement: No `select`/`include` behaves exactly as before (backward compatible)

Calling a read method with no `select` and no `include` MUST produce the same
inferred return type as it did before this capability existed: the model's
full scalar row shape, with no relation keys present on the type.

#### Scenario: default call type is unchanged

- GIVEN a model `User` with scalar fields and a declared relation `posts`
- WHEN a caller writes `db.user.findMany()` with no options
- THEN the inferred element type MUST be the model's full scalar row type
- AND MUST NOT include a `posts` property
- AND this MUST be identical to the pre-`include`/pre-narrowing return type

### Requirement: Accepted fallback — optional relation fields on `Row` if full narrowing is intractable

If, during implementation, full `GetPayload`-style conditional type narrowing
for `select`/`include` combinations proves intractable (e.g. excessive
compile-time cost, TypeScript generic-depth limits, or unreasonable
maintenance burden), the accepted, user-confirmed implementation-time
deviation is to add relation fields as optional properties on the base `Row`
type instead of full conditional narrowing. This fallback is weaker (it does
not make excluded relations compile errors to access) but remains shippable
and MUST be resolved as a concrete, single implementation choice in the design
and tasks phases — not left as two simultaneously-supported behaviors in the
shipped code. If the fallback is exercised, the "compile-time error on
excluded relation" scenario above no longer holds for relations (though it
MUST still hold for excluded scalar fields via `select`, which is unaffected
by this fallback), and this MUST be called out explicitly wherever the
fallback is adopted.

#### Scenario: fallback is an explicit, documented choice, not silent scope reduction

- GIVEN implementation work on this capability
- WHEN full conditional narrowing is abandoned in favor of the optional-fields
  fallback
- THEN that decision MUST be recorded in the change's design/tasks artifacts
- AND the shipped behavior MUST NOT silently claim full compile-time relation
  narrowing while only providing the weaker optional-fields shape
</content>
