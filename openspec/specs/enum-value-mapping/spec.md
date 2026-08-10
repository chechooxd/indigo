# Enum Value Mapping Specification

## Purpose

Carries an enum value's `@map("...")` physical label into the resolved IR, using the `dbName` convention already established for models and fields (`packages/core/src/ir.ts:30`, `:101`), instead of discarding it during resolution.

## Requirements

### Requirement: Enum value `@map` reaches the resolved IR as `dbName`

For each enum value, the resolved schema MUST expose a `dbName` equal to the `@map(...)` argument when present, or equal to the enum value's own name when no `@map` is declared.

#### Scenario: Mapped enum value

- GIVEN `enum Status { ACTIVE @map("active") INACTIVE }`
- WHEN the schema is resolved
- THEN the resolved `ACTIVE` value's `dbName` is `"active"`

#### Scenario: Unmapped enum value defaults to its own name

- GIVEN the same enum, for the `INACTIVE` value (no `@map`)
- WHEN the schema is resolved
- THEN the resolved `INACTIVE` value's `dbName` is `"INACTIVE"`

### Requirement: Enum value `@map` is subject to attribute-validation

`@map` on an enum value MUST be checked for arity (exactly one positional argument) and argument type (a string), per the `attribute-validation` capability.

#### Scenario: Wrong-arity map on an enum value

- GIVEN `enum Status { ACTIVE @map() }`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the missing argument

#### Scenario: Wrong-type map on an enum value

- GIVEN `enum Status { ACTIVE @map(1) }`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the type mismatch (expected a string)
