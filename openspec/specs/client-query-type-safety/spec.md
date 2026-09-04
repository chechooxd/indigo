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

## ADDED from nested-writes

### Requirement: `CreateInput`/`UpdateInput` accept typed relation members

Generated `<Model>CreateInput`/`<Model>UpdateInput` types MUST include an
optional member per declared relation, typed as a union of the supported
sub-operations for that relation's cardinality (`create`/`connect`/
`connectOrCreate` for to-one; those plus `disconnect`/`set` for to-many, and
`disconnect`/`set` also for optional to-one). Composite-key relations MUST
continue to be omitted, matching existing `<Model>Relations` exclusion.

#### Scenario: relation member appears on CreateInput

- GIVEN model `Post` with to-one relation `author` and model `User` with
  to-many relation `posts`
- WHEN the client is generated
- THEN `PostCreateInput` MUST accept an optional `author` member typed
  `{ create: ... } | { connect: ... } | { connectOrCreate: ... }`
- AND `UserCreateInput` MUST accept an optional `posts` member additionally
  typed to allow `create`/`connect`/`connectOrCreate` in array form

#### Scenario: composite-key relation is omitted from the relation union

- GIVEN a relation whose FK is a composite key, already excluded from
  `<Model>Relations`
- WHEN `<Model>CreateInput`/`<Model>UpdateInput` are generated
- THEN no member for that relation MUST appear on either input type

### Requirement: `__meta` relation entries carry the `optional` flag

Generated `__meta.relations[<name>]` MUST include an `optional: boolean`
field reflecting whether the relation's foreign key is nullable, sourced
from the same `RelationInfo.optional` value `core`'s resolver already
computes. This closes a gap where `optional` was computed but dropped
before reaching generated `__meta`, leaving the runtime with no way to
distinguish a required to-one relation from an optional one.

#### Scenario: required relation is flagged non-optional

- GIVEN `Post.author` is backed by a non-nullable FK column
- WHEN the client is generated
- THEN `Post.__meta.relations.author.optional` MUST be `false`

#### Scenario: optional relation is flagged optional

- GIVEN `Post.editor` is backed by a nullable FK column
- WHEN the client is generated
- THEN `Post.__meta.relations.editor.optional` MUST be `true`

## ADDED Requirements (client-batch-aggregate)

### Requirement: Generated arg interfaces for batch, cursor, aggregation, and upsert operations

Generated client code MUST include one arg interface per new operation —
`<Model>CreateManyArgs`, `<Model>UpdateManyArgs`, `<Model>DeleteManyArgs`,
`<Model>AggregateArgs`, `<Model>GroupByArgs`, `<Model>UpsertArgs` — plus a
`distinct` member on the existing `findMany` args interface. These interfaces
MUST be additive: existing generated interfaces (`FindManyArgs`,
`CreateInput`, `UpdateInput`, etc.) MUST remain unchanged in shape for
callers not using the new options. `<Model>UpdateArgs`/`<Model>DeleteArgs`
(single-row `update`/`delete`) additionally type their `where` member as
`<Model>WhereUniqueInput` — the generated union of declared unique-group
shapes, renamed from `<Model>UpsertWhereInput` and now shared across
`upsert`, `update`, and `delete` — instead of the full `WhereInput<Row>`.

#### Scenario: New arg interfaces are emitted per model

- GIVEN a model `Order`
- WHEN the client is generated
- THEN `OrderCreateManyArgs`, `OrderUpdateManyArgs`, `OrderDeleteManyArgs`,
  `OrderAggregateArgs`, `OrderGroupByArgs`, and `OrderUpsertArgs` MUST all be
  emitted
- AND existing `OrderFindManyArgs` MUST additionally accept `cursor`,
  `distinct` members without breaking any existing caller's compile

#### Scenario: Existing generated clients keep compiling unchanged

- GIVEN a client generated before this capability existed, calling only
  pre-existing methods (`findMany`, `create`, `update`, `delete`, `count`)
- WHEN the client is regenerated with this capability's generator changes
- THEN the pre-existing call sites MUST continue to type-check with no
  changes required

#### Scenario: UpdateArgs/DeleteArgs where is typed as the shared unique-selector type

- GIVEN model `User` with a declared unique constraint on `email`
- WHEN the client is generated
- THEN `UserUpdateArgs["where"]` and `UserDeleteArgs["where"]` MUST both be
  typed as `UserWhereUniqueInput`
- AND MUST NOT be typed as the full `UserWhereInput`

### Requirement: `__meta` gains a numeric-scalar tag and unique-constraint groups

Generated `__meta.fields[<name>]` MUST include a `numeric: boolean` field
tagging columns whose scalar type is numeric, sourced from `core`'s resolved
IR type information. Generated `__meta` MUST also include a
`uniqueGroups: string[][]` entry listing each declared unique constraint
(single-column or composite) as an array of its field names. Both additions
MUST be purely additive to the existing `__meta` shape.

#### Scenario: Numeric field is tagged

- GIVEN model `Order` with a numeric field `total` and a text field `status`
- WHEN the client is generated
- THEN `Order.__meta.fields.total.numeric` MUST be `true`
- AND `Order.__meta.fields.status.numeric` MUST be `false`

#### Scenario: Unique groups are listed, including composites

- GIVEN model `Membership` with a composite unique constraint on
  `(userId, orgId)` and model `User` with a single-column unique constraint
  on `email`
- WHEN the client is generated
- THEN `Membership.__meta.uniqueGroups` MUST include `["userId", "orgId"]`
- AND `User.__meta.uniqueGroups` MUST include `["email"]`

#### Scenario: __meta additions do not break existing generated fixture compile

- GIVEN a previously generated client fixture used by
  `packages/client/test/typecheck.mjs`
- WHEN the fixture is regenerated with the new `__meta` fields present
- THEN the fixture MUST still type-check successfully

## ADDED Requirements (client-type-honesty)

### Requirement: BigInt scalar columns are typed as `string`

Generated Row/Create/Update interfaces MUST map `ScalarType.BigInt` columns
to TypeScript `string`, not `bigint`, because pg's default int8 result
parser returns a JS `string` at runtime with no `setTypeParser` override
present anywhere in the client. This is a type-only correction; no runtime
behavior changes.

#### Scenario: Generated Row type maps BigInt to string

- GIVEN a model with a field of scalar type `BigInt`
- WHEN the client is generated
- THEN the field's type in the generated `Row` interface MUST be `string`
- AND MUST NOT be `bigint`

#### Scenario: No runtime change accompanies the type fix

- GIVEN a query returns a BigInt-typed column value
- WHEN the value is read at runtime
- THEN the returned JS value MUST remain a `string`, unchanged from
  pre-existing runtime behavior

### Requirement: Generated enums emit as a const object with a paired type

Generated enum types MUST be emitted as `export const X = {...} as const`
paired with `export type X = typeof X[keyof typeof X]`, sharing the name
`X` for both the value-position const and the type-position alias, instead
of a nominal `export enum X {...}`. This MUST compile under
`isolatedModules`/`erasableSyntaxOnly` consumers of the generated client.

#### Scenario: Value-position usage compiles

- GIVEN a generated enum `Status` with member `Active`
- WHEN calling code writes `Status.Active`
- THEN this MUST type-check and resolve to the correct literal value

#### Scenario: Type-position usage compiles in function signatures

- GIVEN a generated enum `Status`
- WHEN a generated or hand-written function signature declares a parameter
  or return type as `Status` (e.g. `function setStatus(s: Status): void`)
- THEN this MUST type-check as a valid type reference
- AND MUST NOT require importing a separately-named type (no `StatusValue`
  or similar split name)

#### Scenario: Enum-bearing model compiles under erasableSyntaxOnly

- GIVEN a generated client containing at least one enum column
- WHEN the generated file is type-checked with `erasableSyntaxOnly` enabled
- THEN compilation MUST succeed with no errors attributable to the enum
  emission

### Requirement: `select` scalar narrowing remains correct (regression guard)

`SelectedScalars` MUST continue to narrow via TypeScript's `Pick` utility
type so that a `select`-scoped read method's inferred return type contains
exactly the requested scalar fields. This requirement records verification
of pre-existing, already-correct behavior — no code change accompanies it —
and exists so the guarantee stays covered by an automated regression check
going forward.

#### Scenario: select narrowing remains verified by the typecheck fixture

- GIVEN `packages/client/test/typecheck.mjs`'s `tsc --noEmit` fixture
- WHEN the fixture is run against a `select`-scoped `findMany` call
- THEN excluded scalar fields MUST remain compile errors to access
- AND this MUST hold with no change to `SelectedScalars`'s implementation
