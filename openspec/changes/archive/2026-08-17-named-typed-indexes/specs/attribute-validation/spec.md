# Delta for Attribute Validation

## MODIFIED Requirements

### Requirement: Known-attribute whitelist per target

The compiler MUST recognize only attributes actually consumed by the resolver, and MUST reject any other attribute name with a diagnostic naming the model/field and the unrecognized attribute.

Recognized field attributes (`@`): `id`, `unique`, `default`, `map`, `note`, `relation`.
Recognized model attributes (`@@`): `map`, `unique`, `index`, `note`, `realtime`.
Recognized enum-value attributes (`@`): `map`.

The compiler MUST additionally recognize the `db` namespace on field attributes, restricted to the closed set `VarChar`, `Uuid`, `Numeric` (e.g. `@db.VarChar`, `@db.Uuid`, `@db.Numeric`). Any other namespaced name — including any other namespace besides `db`, or any `db.X` outside this set — MUST be rejected with a diagnostic naming the model, the field, and the unrecognized attribute, exactly as an unnamespaced unknown attribute is rejected today.

The compiler MUST additionally recognize two optional named arguments, `name` and `type`, on the model attributes `@@index` and `@@unique`. No other model or field attribute may accept these named arguments; supplying either on any other attribute MUST be rejected exactly as an unrecognized/misplaced argument is today.

(Previously: the whitelist recognized only unnamespaced attribute names and had no notion of a namespace; any namespaced form would have been rejected as unknown by construction once the parser accepts namespace syntax. `@@index`/`@@unique` accepted exactly one positional field-array argument and no named arguments.)

#### Scenario: Unknown field attribute

- GIVEN a field with `@uniqe` (typo of `@unique`)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and `"uniqe"` as an unrecognized attribute

#### Scenario: Unknown model attribute

- GIVEN a model with `@@deafult` (not a real model-level attribute)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the unrecognized attribute

#### Scenario: Recognized native type attribute

- GIVEN a field `bio String @db.VarChar(255)`
- WHEN the schema is validated
- THEN no unrecognized-attribute diagnostic is produced for `db.VarChar`

#### Scenario: Unknown native type name

- GIVEN a field `bio String @db.Foo`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and `"db.Foo"` as an unrecognized attribute

#### Scenario: Unknown namespace

- GIVEN a field `bio String @orm.hint`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and the unrecognized namespaced attribute

#### Scenario: Named args accepted on @@index and @@unique

- GIVEN a model with `@@index([a, b], name: "custom_idx", type: gin)`
- WHEN the schema is validated
- THEN no unrecognized-argument diagnostic is produced for `name` or `type`

#### Scenario: Named args rejected on an unrelated attribute

- GIVEN a field with `@map("col", type: gin)`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and the unsupported `type` argument on `@map`

### Requirement: Attribute arity is checked

The compiler MUST reject an attribute invoked with the wrong number of arguments for its target (e.g. `@id` and `@unique` take zero arguments; `@map` and `@note` take exactly one positional string argument).

#### Scenario: Extra argument on a zero-arity attribute

- GIVEN a field with `@id("x")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and the arity mismatch

#### Scenario: Missing argument on a one-arity attribute

- GIVEN a field with `@map()`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and the missing argument

### Requirement: Attribute argument types are checked

The compiler MUST reject a `@default` value whose literal type does not match the field's scalar type, except that generator function calls (`autoincrement()`, `now()`, `uuid()`, `cuid()`) and, for enum-typed fields, a bare enum-member reference are always accepted.

#### Scenario: String default on an Int field

- GIVEN a field `count Int @default("nope")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and the type mismatch (expected a number)

#### Scenario: Valid function default is accepted regardless of type

- GIVEN a field `id Int @id @default(autoincrement())`
- WHEN the schema is validated
- THEN no diagnostic is produced for that field

#### Scenario: Enum reference default is accepted

- GIVEN a field `status Status @default(ACTIVE)` where `Status` is a declared enum with member `ACTIVE`
- WHEN the schema is validated
- THEN no diagnostic is produced for that field

### Requirement: Native type attributes require scalar compatibility

The compiler MUST reject a `@db.X` attribute whose native type is not
logically compatible with the field's declared scalar type. `VarChar` and
`Uuid` are compatible only with `String` fields; `Numeric` is compatible only
with `Float` or `Decimal` fields. A mismatch MUST produce a diagnostic naming
the model, the field, the native type, and the declared scalar type.

#### Scenario: Native type on an incompatible scalar

- GIVEN a field `count Int @db.VarChar(255)`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, `"VarChar"`, and `"Int"` as the mismatch

#### Scenario: Native type on a compatible scalar

- GIVEN a field `id String @db.Uuid`
- WHEN the schema is validated
- THEN no diagnostic is produced for that field

### Requirement: The existing fixture corpus remains valid under namespaced attributes

Every fixture that existed in `fixtures/*.indigo` prior to this change (excluding `fixtures/errors/`) MUST continue to compile with zero attribute-validation diagnostics and MUST produce a byte-identical golden snapshot to its pre-change snapshot. Only newly added fixtures introduced by this change (one accepted `@db.X` usage, one rejected case, plus new named-index-argument fixtures) MAY produce new or different diagnostics/snapshots.

#### Scenario: Pre-existing corpus is unaffected

- GIVEN every fixture that existed before this change shipped
- WHEN each is parsed, validated, resolved, and snapshotted
- THEN no attribute-validation diagnostic is produced and the snapshot bytes are unchanged from before this change

#### Scenario: New accepted-syntax fixture

- GIVEN a new fixture using `@db.VarChar`, `@db.Uuid`, and `@db.Numeric` on compatible fields
- WHEN it is parsed, validated, and resolved
- THEN it compiles with zero diagnostics and produces a new golden snapshot

#### Scenario: New rejected-case fixture

- GIVEN a new fixture using an unknown `@db.X` or a scalar-incompatible `@db.X`
- WHEN it is validated
- THEN it produces the expected diagnostic(s) and is placed under the rejected-fixture convention

## ADDED Requirements

### Requirement: Index `type` argument is restricted to a closed method enum

The compiler MUST reject a `type` argument on `@@index`/`@@unique` whose
value is not one of the closed set `btree`, `gin`, `gist`, `hash`, with a
diagnostic naming the model, the index, and the unrecognized method.

#### Scenario: Unknown index method

- GIVEN `@@index([a], type: bloom)`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the index, and `"bloom"` as an unrecognized index method

### Requirement: Explicit index names are unique per table

The compiler MUST reject an explicit `name` on `@@index`/`@@unique` that
collides with another explicit `name` on the same table, or with the
auto-derived name of another index on that table, with a diagnostic naming
the model/table and the conflicting name.

#### Scenario: Duplicate explicit name

- GIVEN a model with `@@index([a], name: "shared_idx")` and `@@unique([b], name: "shared_idx")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the table and `"shared_idx"` as a duplicate index name

#### Scenario: Explicit name collides with an auto-derived name

- GIVEN a model with `@@index([a])` (auto-derives `Model_a_idx`) and `@@index([b], name: "Model_a_idx")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the table and the colliding name

### Requirement: Explicit index name literal is well-formed

The compiler MUST reject a `name` argument that is not a non-empty string
literal, with a diagnostic naming the model, the index, and the malformed
name.

#### Scenario: Empty name literal

- GIVEN `@@index([a], name: "")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the index, and the malformed (empty) name
