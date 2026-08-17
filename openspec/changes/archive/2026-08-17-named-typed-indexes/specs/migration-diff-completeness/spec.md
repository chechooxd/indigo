# Delta for Migration Diff Completeness

## ADDED Requirements

### Requirement: Index identity includes name and method, not just columns

`diffResolved`'s index-matching signature MUST include the index's resolved
`name` and `type` (method) in addition to its uniqueness flag and column
set. Two indexes with identical columns but a different name and/or a
different method MUST NOT be treated as unchanged.

(Previously undocumented: `indexSignature` computed identity as
`${unique ? "u" : "i"}:${columns.join(",")}` only — name and type changes on
an otherwise-identical index produced zero diff statements, a silent no-op.)

#### Scenario: Method-only change is diffed, not a no-op

- GIVEN table `T` has `@@index([tags])` (btree, implicit) in the previous schema and `@@index([tags], type: gin)` in the next schema
- WHEN a migration is generated
- THEN the emitted statements drop the previous index and create the new one `USING gin`, and the diff is not empty

#### Scenario: Name-only change is diffed, not a no-op

- GIVEN table `T` has `@@index([a])` (auto-derived name) in the previous schema and `@@index([a], name: "a_custom_idx")` in the next schema
- WHEN a migration is generated
- THEN the emitted statements rename or drop-and-recreate the index under `"a_custom_idx"`, and the diff is not empty

#### Scenario: Unchanged index (same columns, name, and method) remains a no-op

- GIVEN table `T`'s index declaration is byte-identical between the previous and next schema
- WHEN a migration is generated
- THEN no DDL statement is emitted for that index, matching current behavior
