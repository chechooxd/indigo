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

### Requirement: Ambiguous unnamed relation pairing is a validation error

When a model declares two or more relation fields targeting the same model, and none of those fields (on either side of the pairing) carries an explicit `@relation("Name")`, the compiler MUST reject the schema with a validation ERROR naming both model names and instructing the user to disambiguate with `@relation("Name")`. This is independent of the existing implicit-many-to-many check: it applies even when the relations are valid one-to-many/many-to-one shapes (each carries `fields:`/`references:`), and fires because pairing itself is indeterminate, not because the relation shape is unsupported.

#### Scenario: Two unnamed FK-holding relations to the same target

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) reviewerId Int reviewer User @relation(fields: [reviewerId], references: [id]) }` and `Table User { posts Post[] }`
- WHEN the schema is validated
- THEN a validation ERROR is produced naming `"Post"` and `"User"`
- AND the schema fails to compile

#### Scenario: Naming one side is not sufficient

- GIVEN two relation fields from `Post` to `User`, only one of which declares `@relation("Name")`
- WHEN the schema is validated
- THEN the unnamed relation MUST still be reported as ambiguous
- AND the schema fails to compile

### Requirement: Unresolvable named relation is a validation error

When a field declares `@relation("Name", ...)` but no field on the target model declares the matching name, the compiler MUST reject the schema with a diagnostic naming the relation name and both model names, rather than falling back to an implicit match.

#### Scenario: Relation name has no counterpart

- GIVEN `Post.author` declares `@relation("PostAuthor", ...)` and no field on `User` declares `@relation("PostAuthor")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming `"PostAuthor"`, `"Post"`, and `"User"`
- AND the resolver does not silently pair it with an unrelated field on `User`

### Requirement: Explicit one-to-many relations are unaffected

A list field on one side paired with a singular FK-holding field on the other side (declaring `@relation(fields:, references:)`) MUST continue to resolve as a valid one-to-many relation with no diagnostic, provided the pairing between the two fields is deterministic — i.e. either it is the only relation between the two models, or an explicit `@relation("Name")` disambiguates it from siblings targeting the same model.
(Previously: unaffected by any name/pairing distinction — this scope was undefined before cross-model pairing existed.)

#### Scenario: Explicit FK-holding relation is valid

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) }` and `Table User { posts Post[] }`
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced

#### Scenario: Explicit FK-holding relation is valid when disambiguated by name

- GIVEN two `Post` → `User` relations, each side carrying a distinct `@relation("Name")` pairing its FK-holding field to its list field
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced for either pair

### Requirement: An explicit join model is a valid remedy

Two one-to-many relations chained through an explicit join model (each leg declaring `@relation(fields:, references:)`) MUST resolve without a many-to-many diagnostic.

#### Scenario: Explicit join model compiles clean

- GIVEN `Table Post`, `Table Tag`, and `Table PostTag { postId Int tagId Int post Post @relation(fields: [postId], references: [id]) tag Tag @relation(fields: [tagId], references: [id]) }`
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced for `Post`, `Tag`, or `PostTag`
