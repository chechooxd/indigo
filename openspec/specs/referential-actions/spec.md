# Referential Actions Specification

## Purpose

Defines how `onDelete` and `onUpdate` referential actions on `@relation` attributes are parsed, validated, and carried into the resolved IR's `ForeignKey`.

## Requirements

### Requirement: Bare and quoted referential action values are both accepted

The compiler MUST resolve `onDelete` and `onUpdate` values written as a bare identifier (e.g. `onDelete: Cascade`, an `AttributeValue::Reference`) identically to the quoted string form (e.g. `onDelete: "Cascade"`).

#### Scenario: Bare onDelete reaches the foreign key

- GIVEN a `@relation` attribute with `onDelete: Cascade` (bare identifier)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` for that relation carries `onDelete: "Cascade"`

#### Scenario: Quoted onDelete reaches the foreign key

- GIVEN a `@relation` attribute with `onDelete: "Cascade"` (quoted string)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` carries `onDelete: "Cascade"`, matching the bare form

#### Scenario: Bare onUpdate reaches the foreign key

- GIVEN a `@relation` attribute with `onUpdate: Restrict` (bare identifier)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` carries `onUpdate: "Restrict"`

#### Scenario: Absent referential action stays absent

- GIVEN a `@relation` attribute with no `onDelete` and no `onUpdate`
- WHEN the schema is resolved
- THEN the `ForeignKey` carries neither key (absent, not null or empty string)

### Requirement: Referential action values are validated against a fixed domain

The compiler MUST accept only `Cascade`, `Restrict`, `SetNull`, `SetDefault`, and `NoAction` for `onDelete`/`onUpdate`, in either bare or quoted form. Any other value MUST produce a diagnostic naming the field, the invalid value, and the allowed set.

#### Scenario: Invalid referential action value

- GIVEN a `@relation` attribute with `onDelete: Nonsense`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, `"Nonsense"`, and the five allowed values

#### Scenario: Case-sensitive rejection

- GIVEN a `@relation` attribute with `onDelete: cascade` (lowercase)
- WHEN the schema is validated
- THEN a diagnostic is produced, since the domain is case-sensitive PascalCase
