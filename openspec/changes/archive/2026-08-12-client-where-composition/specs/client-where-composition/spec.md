# Client Where Composition Specification

## Purpose

Enable `@indigodb/client` `where` clauses to express boolean composition
(`AND`/`OR`/`NOT`), to-many relation filters (`some`/`every`/`none`), and
JSON path filters on `Json`/`jsonb` columns — replacing the flat AND-only
`WhereInput` that crashes on structural keys like `OR`.

## Requirements

### Requirement: Recursive per-model WhereInput type
The generator MUST emit a per-model `<Model>WhereInput` interface (in place
of the flat generic `WhereInput<Row>`) with optional self-referential
`AND?: <Model>WhereInput[]`, `OR?: <Model>WhereInput[]`, and
`NOT?: <Model>WhereInput` fields alongside per-field predicates. This is an
intentional breaking change to the public generated type surface, not a
regression.

#### Scenario: Generated type replaces flat WhereInput
- GIVEN a schema with model `Post`
- WHEN the client is generated
- THEN `indigo.ts` exports `PostWhereInput` with `AND?`, `OR?`, `NOT?`
  self-references and per-field predicate keys
- AND no generic flat `WhereInput<Row>` type is exported for `Post`

#### Scenario: NOT accepts a single object only
- GIVEN `PostWhereInput`
- WHEN a caller supplies `NOT`
- THEN the type only accepts a single `PostWhereInput` object, not an array

### Requirement: Structural keys resolved before field loop
`buildWhere` MUST check `AND`, `OR`, and `NOT` as structural keys before
iterating field metadata, and MUST NOT resolve them as column names via
`meta.fields`.

#### Scenario: OR no longer crashes
- GIVEN `where: { OR: [{ a: 1 }, { b: 2 }] }`
- WHEN `buildWhere` compiles the clause
- THEN it produces valid parenthesized SQL joining the two branches with `OR`
- AND no `column "OR" does not exist` error occurs

### Requirement: Correct recursive parenthesization and shared param numbering
`buildWhere` MUST recurse into nested `AND`/`OR`/`NOT` clauses, wrapping each
composed sub-clause in parentheses, and MUST thread one shared `Params`
accumulator through the entire recursion so `$N` placeholders stay
sequential with no collisions or gaps.

#### Scenario: Nested AND/OR/NOT numbering stays sequential
- GIVEN `where: { AND: [{ a: 1 }, { OR: [{ b: 2 }, { NOT: { c: 3 } }] }] }`
- WHEN `buildWhere` compiles the clause
- THEN the resulting SQL text is correctly parenthesized per nesting level
- AND params are `[1, 2, 3]` bound to `$1, $2, $3` in that order with no
  reused or skipped numbers

### Requirement: Empty AND/OR identity semantics
An empty `AND: []` MUST compile as a tautology (matches all rows) and an
empty `OR: []` MUST compile as a contradiction (matches no rows), matching
standard boolean identity rather than raising an error.

#### Scenario: Empty AND matches all rows
- GIVEN `where: { AND: [] }`
- WHEN `buildWhere` compiles the clause
- THEN the compiled SQL condition is always-true (e.g. `TRUE`) and adds no
  params

#### Scenario: Empty OR matches no rows
- GIVEN `where: { OR: [] }`
- WHEN `buildWhere` compiles the clause
- THEN the compiled SQL condition is always-false (e.g. `FALSE`) and adds no
  params

### Requirement: To-many relation filters via correlated subqueries
For to-many relations, the generated `WhereInput` MUST expose `some`,
`every`, and `none` filter keys accepting a nested `WhereInput` for the
related model. `buildWhere` MUST compile each into a correlated
`EXISTS`/`NOT EXISTS` subquery against the related table, joined on the
relation's foreign key, reusing `resolveRelationInfo`'s `{target, list,
from, to}` metadata. To-one relation filters are out of scope.

#### Scenario: some compiles to EXISTS
- GIVEN `where: { comments: { some: { flagged: true } } }` on `Post`
- WHEN `buildWhere` compiles the clause
- THEN it emits `EXISTS (SELECT 1 FROM comments WHERE comments.post_id =
  posts.id AND comments.flagged = $N)`

#### Scenario: none compiles to NOT EXISTS
- GIVEN `where: { comments: { none: { flagged: true } } }` on `Post`
- WHEN `buildWhere` compiles the clause
- THEN it emits `NOT EXISTS (SELECT 1 FROM comments WHERE comments.post_id =
  posts.id AND comments.flagged = $N)`

#### Scenario: every uses vacuous truth
- GIVEN `where: { comments: { every: { flagged: true } } }` on `Post`
- WHEN `buildWhere` compiles the clause
- THEN it emits `NOT EXISTS (SELECT 1 FROM comments WHERE comments.post_id =
  posts.id AND NOT (comments.flagged = $N))`
- AND a `Post` with zero comments satisfies the `every` condition

### Requirement: JSON path filters
For `Json`/`jsonb` columns, the generated `WhereInput` MUST accept a filter
shape `{ path: string[], equals?, gt?, lt?, gte?, lte? }`. `buildWhere` MUST
compile it using Postgres `#>` (path to jsonb), `#>>` (path to text, for
scalar comparisons), and `@>` (containment, for `equals` on jsonb values)
operators. `string_contains`/`array_contains` and other Prisma JSON helpers
are out of scope.

#### Scenario: equals compiles to containment
- GIVEN `where: { metadata: { path: ["status"], equals: "active" } }`
- WHEN `buildWhere` compiles the clause
- THEN it emits a condition using `@>` (or equivalent `#>>` text equality)
  parameterized with the path and value

#### Scenario: gt/lt compile to path text comparison
- GIVEN `where: { metadata: { path: ["score"], gt: 10 } }`
- WHEN `buildWhere` compiles the clause
- THEN it emits `(metadata #>> '{score}')::numeric > $N` (or equivalent
  `#>`/`#>>` cast comparison) with the value parameterized
