# Delta for Client Query Type Safety

## ADDED Requirements

### Requirement: `CreateInput`/`UpdateInput` accept typed relation members

Generated `<Model>CreateInput`/`<Model>UpdateInput` types MUST include an
optional member per declared relation, typed as a union of the supported
sub-operations for that relation's cardinality (`create`/`connect`/
`connectOrCreate` for to-one; those plus `disconnect`/`set` for to-many, and
`disconnect`/`set` also for optional to-one). Composite-key relations MUST
continue to be omitted, matching existing `<Model>Relations` exclusion.

#### Scenario: relation member appears on CreateInput

- GIVEN model `Post` with to-one relation `author` and model `User` with
  to-many relation `posts`
- WHEN the client is generated
- THEN `PostCreateInput` MUST accept an optional `author` member typed
  `{ create: ... } | { connect: ... } | { connectOrCreate: ... }`
- AND `UserCreateInput` MUST accept an optional `posts` member additionally
  typed to allow `create`/`connect`/`connectOrCreate` in array form

#### Scenario: composite-key relation is omitted from the relation union

- GIVEN a relation whose FK is a composite key, already excluded from
  `<Model>Relations`
- WHEN `<Model>CreateInput`/`<Model>UpdateInput` are generated
- THEN no member for that relation MUST appear on either input type

### Requirement: `__meta` relation entries carry the `optional` flag

Generated `__meta.relations[<name>]` MUST include an `optional: boolean`
field reflecting whether the relation's foreign key is nullable, sourced
from the same `RelationInfo.optional` value `core`'s resolver already
computes. This closes a gap where `optional` was computed but dropped
before reaching generated `__meta`, leaving the runtime with no way to
distinguish a required to-one relation from an optional one.

#### Scenario: required relation is flagged non-optional

- GIVEN `Post.author` is backed by a non-nullable FK column
- WHEN the client is generated
- THEN `Post.__meta.relations.author.optional` MUST be `false`

#### Scenario: optional relation is flagged optional

- GIVEN `Post.editor` is backed by a nullable FK column
- WHEN the client is generated
- THEN `Post.__meta.relations.editor.optional` MUST be `true`
</content>
