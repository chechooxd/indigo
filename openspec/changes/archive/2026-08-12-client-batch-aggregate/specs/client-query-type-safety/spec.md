# Delta for client-query-type-safety

## ADDED Requirements

### Requirement: Generated arg interfaces for batch, cursor, aggregation, and upsert operations

Generated client code MUST include one arg interface per new operation —
`<Model>CreateManyArgs`, `<Model>UpdateManyArgs`, `<Model>DeleteManyArgs`,
`<Model>AggregateArgs`, `<Model>GroupByArgs`, `<Model>UpsertArgs` — plus a
`distinct` member on the existing `findMany` args interface. These interfaces
MUST be additive: existing generated interfaces (`FindManyArgs`,
`CreateInput`, `UpdateInput`, etc.) MUST remain unchanged in shape for
callers not using the new options.

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
</content>
