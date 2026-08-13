# Delta for Attribute Validation

## MODIFIED Requirements

### Requirement: Known-attribute whitelist per target

The compiler MUST recognize only attributes actually consumed by the resolver, and MUST reject any other attribute name with a diagnostic naming the model/field and the unrecognized attribute.

Recognized field attributes (`@`): `id`, `unique`, `default`, `map`, `note`, `relation`.
Recognized model attributes (`@@`): `map`, `unique`, `index`, `note`, `realtime`.
Recognized enum-value attributes (`@`): `map`.

The compiler MUST additionally recognize the `db` namespace on field attributes, restricted to the closed set `VarChar`, `Uuid`, `Numeric` (e.g. `@db.VarChar`, `@db.Uuid`, `@db.Numeric`). Any other namespaced name — including any other namespace besides `db`, or any `db.X` outside this set — MUST be rejected with a diagnostic naming the model, the field, and the unrecognized attribute, exactly as an unnamespaced unknown attribute is rejected today.

(Previously: the whitelist recognized only unnamespaced attribute names and had no notion of a namespace; any namespaced form would have been rejected as unknown by construction once the parser accepts namespace syntax.)

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

## ADDED Requirements

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

Every fixture that existed in `fixtures/*.indigo` prior to this change (excluding `fixtures/errors/`) MUST continue to compile with zero attribute-validation diagnostics and MUST produce a byte-identical golden snapshot to its pre-change snapshot. Only newly added fixtures introduced by this change (one accepted `@db.X` usage, one rejected case) MAY produce new or different diagnostics/snapshots.

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
</content>
</invoke>
