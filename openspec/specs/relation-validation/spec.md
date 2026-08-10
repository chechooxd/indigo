# Relation Validation Specification

## Purpose

Rejects implicit many-to-many relations — reciprocal list fields with no explicit `@relation(fields:, references:)` on either side — instead of silently resolving them into two disconnected one-to-many relations with zero DDL. This is a deliberate product non-goal: the resolver's accidental "do nothing" position becomes a loud, actionable error.

## Requirements

### Requirement: Implicit many-to-many is a validation error

The compiler MUST reject a pair of reciprocal list-typed relation fields between two models when neither field declares `@relation(fields: [...], references: [...])`. The diagnostic MUST name both model names and MUST instruct the user to define an explicit join model with two one-to-many `@relation` fields.

#### Scenario: Reciprocal list fields with no explicit FK

- GIVEN `Table Post { tags Tag[] }` and `Table Tag { posts Post[] }`, neither field carrying `@relation(fields:, references:)`
- WHEN the schema is validated
- THEN a diagnostic is produced naming `"Post"` and `"Tag"` and instructing the user to introduce an explicit join model with two `@relation` fields

#### Scenario: Diagnostic message names the remedy

- GIVEN the same schema as above
- WHEN the diagnostic is produced
- THEN its message text names both models, states that implicit many-to-many relations are not supported, and names "explicit join model" as the remedy

### Requirement: Explicit one-to-many relations are unaffected

A list field on one side paired with a singular FK-holding field on the other side (declaring `@relation(fields:, references:)`) MUST continue to resolve as a valid one-to-many relation with no diagnostic.

#### Scenario: Explicit FK-holding relation is valid

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) }` and `Table User { posts Post[] }`
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced

### Requirement: An explicit join model is a valid remedy

Two one-to-many relations chained through an explicit join model (each leg declaring `@relation(fields:, references:)`) MUST resolve without a many-to-many diagnostic.

#### Scenario: Explicit join model compiles clean

- GIVEN `Table Post`, `Table Tag`, and `Table PostTag { postId Int tagId Int post Post @relation(fields: [postId], references: [id]) tag Tag @relation(fields: [tagId], references: [id]) }`
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced for `Post`, `Tag`, or `PostTag`
