# Attribute Validation Specification

## Purpose

Defines the whitelist of attribute names recognized per target (field, model, enum value), their arity, and their argument types — replacing the current absence of any such check in `validate.rs`.

## Requirements

### Requirement: Known-attribute whitelist per target

The compiler MUST recognize only attributes actually consumed by the resolver, and MUST reject any other attribute name with a diagnostic naming the model/field and the unrecognized attribute.

Recognized field attributes (`@`): `id`, `unique`, `default`, `map`, `note`, `relation`.
Recognized model attributes (`@@`): `map`, `unique`, `index`, `note`, `realtime`.
Recognized enum-value attributes (`@`): `map`.

#### Scenario: Unknown field attribute

- GIVEN a field with `@uniqe` (typo of `@unique`)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, and `"uniqe"` as an unrecognized attribute

#### Scenario: Unknown model attribute

- GIVEN a model with `@@deafult` (not a real model-level attribute)
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model and the unrecognized attribute

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

### Requirement: The existing fixture corpus remains valid

Every fixture in `fixtures/*.indigo` (excluding `fixtures/errors/`) MUST continue to compile with zero attribute-validation diagnostics after this change ships.

#### Scenario: Corpus regression check

- GIVEN the full `fixtures/*.indigo` corpus
- WHEN each file is parsed, validated and resolved
- THEN no attribute-validation diagnostic is produced for any of them
