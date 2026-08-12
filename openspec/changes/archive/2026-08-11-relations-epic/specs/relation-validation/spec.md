# Delta for Relation Validation

## ADDED Requirements

### Requirement: Ambiguous unnamed relation pairing is a validation error

When a model declares two or more relation fields targeting the same
model, and none of those fields (on either side of the pairing) carries an
explicit `@relation("Name")`, the compiler MUST reject the schema with a
validation ERROR naming both model names and instructing the user to
disambiguate with `@relation("Name")`. This is independent of the existing
implicit-many-to-many check: it applies even when the relations are valid
one-to-many/many-to-one shapes (each carries `fields:`/`references:`), and
fires because pairing itself is indeterminate, not because the relation
shape is unsupported.

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

When a field declares `@relation("Name", ...)` but no field on the target
model declares the matching name, the compiler MUST reject the schema with
a diagnostic naming the relation name and both model names, rather than
falling back to an implicit match.

#### Scenario: Relation name has no counterpart

- GIVEN `Post.author` declares `@relation("PostAuthor", ...)` and no field on `User` declares `@relation("PostAuthor")`
- WHEN the schema is validated
- THEN a diagnostic is produced naming `"PostAuthor"`, `"Post"`, and `"User"`
- AND the resolver does not silently pair it with an unrelated field on `User`

## MODIFIED Requirements

### Requirement: Explicit one-to-many relations are unaffected

A list field on one side paired with a singular FK-holding field on the
other side (declaring `@relation(fields:, references:)`) MUST continue to
resolve as a valid one-to-many relation with no diagnostic, provided the
pairing between the two fields is deterministic — i.e. either it is the
only relation between the two models, or an explicit `@relation("Name")`
disambiguates it from siblings targeting the same model.
(Previously: unaffected by any name/pairing distinction — this scope was
undefined before cross-model pairing existed.)

#### Scenario: Explicit FK-holding relation is valid

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) }` and `Table User { posts Post[] }`
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced

#### Scenario: Explicit FK-holding relation is valid when disambiguated by name

- GIVEN two `Post` → `User` relations, each side carrying a distinct `@relation("Name")` pairing its FK-holding field to its list field
- WHEN the schema is validated
- THEN no relation-validation diagnostic is produced for either pair
