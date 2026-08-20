# Delta for Attribute Validation

## MODIFIED Requirements

### Requirement: Known-attribute whitelist per target

The compiler MUST recognize only attributes actually consumed by the resolver, and MUST reject
any other attribute name with a diagnostic naming the model/field and the unrecognized
attribute.

Recognized field attributes (`@`): `id`, `unique`, `default`, `map`, `note`, `relation`.
Recognized model attributes (`@@`): `map`, `unique`, `index`, `note`, `realtime`, `allow`.
Recognized enum-value attributes (`@`): `map`.

The compiler MUST additionally recognize the `db` namespace on field attributes, restricted to
the closed set `VarChar`, `Uuid`, `Numeric` (e.g. `@db.VarChar`, `@db.Uuid`, `@db.Numeric`). Any
other namespaced name — including any other namespace besides `db`, or any `db.X` outside this
set — MUST be rejected with a diagnostic naming the model, the field, and the unrecognized
attribute, exactly as an unnamespaced unknown attribute is rejected today.

The compiler MUST additionally recognize two optional named arguments, `name` and `type`, on
the model attributes `@@index` and `@@unique`. No other model or field attribute may accept
these named arguments; supplying either on any other attribute MUST be rejected exactly as an
unrecognized/misplaced argument is today.

The whitelist MUST additionally accept `@@allow` as a model attribute with its own `ArgShape`
covering an action list (comma-combinable `create`/`read`/`update`/`delete`/`write`/`all`) plus
one equality-condition argument. `@@allow` MAY appear more than once on the same model.

(Previously: the whitelist recognized only unnamespaced attribute names and had no notion of a
namespace; any namespaced form would have been rejected as unknown by construction once the
parser accepts namespace syntax. `@@index`/`@@unique` accepted exactly one positional
field-array argument and no named arguments. `@@allow` did not exist and any use of it was
rejected as an unrecognized model attribute.)

#### Scenario: Unknown field attribute

- GIVEN a field with `@uniqe` (typo of `@unique`)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and `"uniqe"` as an unrecognized
  attribute

#### Scenario: Unknown model attribute

- GIVEN a model with `@@deafult` (not a real model-level attribute)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the unrecognized attribute

#### Scenario: `@@allow` is recognized on a model

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is validated
- THEN no unrecognized-attribute diagnostic is produced for `allow`

#### Scenario: `@@allow` arity is checked

- GIVEN a model with `@@allow()` (missing both arguments)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the arity mismatch on `allow`

#### Scenario: `@@allow` argument type is checked

- GIVEN a model with `@@allow(read, 123)` (condition is not an equality expression)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the argument-type mismatch on `allow`

#### Scenario: Named args rejected on `@@allow`

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId, name: "x")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the unsupported `name` argument on `allow`
