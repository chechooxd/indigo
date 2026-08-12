# Relation Identity Specification

## Purpose

`@relation("Name", ...)`'s positional name is parsed but discarded, and no
pass links a relation field to its inverse side across models. This spec
establishes: the `@relation` name is retained in the IR, every relation
field is deterministically paired with its inverse counterpart (by explicit
name, or by unique target when unambiguous), and the inverse side is
populated with the paired relation's real FK/reference column data. Client
`include`/`select`/`_count` codegen is out of scope.

## Requirements

### Requirement: `@relation` name is retained in the IR

`ResolvedRelation` MUST carry an optional `relationName` field holding the
positional string literal from `@relation("Name", ...)` when the schema
declares one. When no name is declared, `relationName` MUST be absent
(`skip_serializing_if`/`undefined`), not an empty string or null.

#### Scenario: Named relation carries its name

- GIVEN `author User @relation("PostAuthor", fields: [authorId], references: [id])`
- WHEN the schema is resolved
- THEN the resolved relation for `author` MUST have `relationName: "PostAuthor"`

#### Scenario: Unnamed relation omits the field

- GIVEN `author User @relation(fields: [authorId], references: [id])`
- WHEN the schema is resolved
- THEN the resolved relation for `author` MUST NOT include a `relationName` key

### Requirement: Cross-model relation pairing

After all models are resolved, a pairing pass MUST link every relation
field to its inverse-side field on the target model. Matching MUST first
try explicit `@relation` name equality between the two candidate fields.
When a model has exactly one relation field targeting a given model (no
explicit name required on either side), that pair MUST resolve
unambiguously via implicit match on the target model alone.

#### Scenario: Single unnamed relation to a target pairs implicitly

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) }` and `Table User { posts Post[] }`, with `Post` having exactly one relation to `User`
- WHEN the schema is resolved
- THEN `Post.author` and `User.posts` MUST be resolved as paired inverse sides
- AND no `@relation` name is required on either side

#### Scenario: Named relation pairs correctly among multiple relations to the same target

- GIVEN `Table Post { authorId Int author User @relation("PostAuthor", fields: [authorId], references: [id]) reviewerId Int reviewer User @relation("PostReviewer", fields: [reviewerId], references: [id]) }` and `Table User { authoredPosts Post[] @relation("PostAuthor") reviewedPosts Post[] @relation("PostReviewer") }`
- WHEN the schema is resolved
- THEN `Post.author` MUST pair with `User.authoredPosts`
- AND `Post.reviewer` MUST pair with `User.reviewedPosts`

#### Scenario: Named relation with no matching counterpart name

- GIVEN `Post.author` declares `@relation("PostAuthor", ...)` but no field on `User` declares `@relation("PostAuthor")`
- WHEN the schema is resolved
- THEN a diagnostic MUST be produced naming `"PostAuthor"` and both model names, stating no counterpart field declares that relation name
- AND the resolver MUST NOT silently fall back to an implicit match on `User`

### Requirement: Inverse side is populated with real FK/reference data

The paired inverse-side relation (the list/back-reference field, e.g.
`User.posts`) MUST be populated with the same `fkColumns`/`refColumns`
values as its counterpart's FK-declaring side (e.g. `Post.author`), not
merely a name or identifier pointing at the counterpart.

#### Scenario: Inverse side carries the counterpart's FK/ref columns

- GIVEN `Post.author` resolves with `fkColumns: ["author_id"]`, `refColumns: ["id"]`
- WHEN pairing resolves `User.posts` as its inverse
- THEN `User.posts` MUST also carry `fkColumns: ["author_id"]` and `refColumns: ["id"]`

### Requirement: Ambiguous unnamed relation sets are a hard error

When a model declares two or more relation fields targeting the same model
and none of them (on either side) carries an explicit `@relation("Name")`,
the pair cannot be resolved deterministically. The compiler MUST reject
this with a validation ERROR (schema fails to compile), not a warning or
silent best-effort pairing.

#### Scenario: Two unnamed relations to the same target

- GIVEN `Table Post { authorId Int author User @relation(fields: [authorId], references: [id]) reviewerId Int reviewer User @relation(fields: [reviewerId], references: [id]) }` and `Table User { posts Post[] }`, with no `@relation` names declared anywhere
- WHEN the schema is validated
- THEN a validation ERROR MUST be produced naming `"Post"` and `"User"` and stating the relation set is ambiguous
- AND the schema MUST NOT compile

#### Scenario: Ambiguity error names the remedy

- GIVEN the same schema as above
- WHEN the diagnostic is produced
- THEN its message MUST instruct the user to disambiguate with `@relation("Name")` on the conflicting fields
