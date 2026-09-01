# Delta for Client Query Type Safety

## MODIFIED Requirements

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
(Previously: this requirement did not constrain `UpdateArgs`/`DeleteArgs`'s
`where` type; `<Model>UpsertWhereInput` existed and was scoped to `upsert`
only.)

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
</content>
