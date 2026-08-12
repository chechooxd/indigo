# Client Relation Loading Specification

## Purpose

Generated `ModelDelegate`s MUST support loading related-model data alongside a
model's own scalar columns via an `include` option on `findMany`, `findFirst`,
and `findUnique`, one level deep. Relation data MUST be fetched with a bounded,
batched-by-parent-ID strategy — never a per-row query — and stitched onto the
parent rows with cardinality-correct shapes (object/`null` for singular
relations, array/`[]` for list relations). Nested `include` (depth ≥ 2),
`_count`, and relation-scoped `where`/`orderBy`/`take` are explicitly out of
scope for this capability; see the sibling `relations-count-aggregate` and
future depth-2 changes.

## Requirements

### Requirement: `include` accepted on read operations, one level deep

`findMany`, `findFirst`, and `findUnique` MUST accept an `include` option shaped
`{ [relationName]: true | { select: {...} } }`, where each key names a relation
declared on the model (per `__meta`). `include` MUST NOT accept a nested
`include` inside a relation's own options in this slice — only a boolean `true`
or a `select` object are valid per-relation values.

#### Scenario: include on findMany with a boolean flag

- GIVEN a model `User` with a declared list relation `posts`
- WHEN `db.user.findMany({ include: { posts: true } })` is called
- THEN each returned user row MUST include a `posts` key
- AND `posts` MUST contain that user's full-shape post rows

#### Scenario: nested include is not accepted

- GIVEN a model `User` with relation `posts`, and `Post` with relation `comments`
- WHEN a caller writes `include: { posts: { include: { comments: true } } }`
- THEN this MUST NOT be a valid `include` shape for this slice
- AND only `true` or `{ select: {...} }` are accepted as a relation's value

### Requirement: Nested scalar `select` inside an included relation

When a relation's `include` value is `{ select: {...} }`, the returned rows for
that relation MUST be narrowed to exactly the selected scalar fields, the same
way top-level `select` narrows a model's own row shape.

#### Scenario: nested select narrows the included relation's shape

- GIVEN a model `User` with list relation `posts` (fields include `id`, `title`, `body`)
- WHEN `db.user.findMany({ include: { posts: { select: { title: true } } } })` is called
- THEN each post object under `posts` MUST contain only the `title` field
- AND MUST NOT contain `body` or other non-selected scalar fields

### Requirement: Batched-by-parent-ID loading, bounded round trips

Included relations MUST be loaded via a batched follow-up query per included
relation, keyed on the set of parent primary keys already resolved by the
parent query — never via one query per parent row. The parent query itself
(including any `LIMIT`/`OFFSET`/`where`/`orderBy` on the base model) MUST be
issued and evaluated unaffected by the presence of `include`. Total round trips
for a single call MUST equal `1 + (number of distinct included relations)`,
regardless of how many parent rows are returned.

#### Scenario: parent pagination is unaffected by include

- GIVEN a model `User` with 100 rows and list relation `posts`
- WHEN `db.user.findMany({ take: 10, skip: 20, include: { posts: true } })` is called
- THEN the parent query MUST apply `LIMIT 10 OFFSET 20` (or equivalent) exactly
  as it would without `include`
- AND exactly 10 user rows MUST be returned, each with its `posts` stitched in

#### Scenario: round trips scale with relation count, not row count

- GIVEN a model `User` with list relations `posts` and `comments`
- WHEN `db.user.findMany({ include: { posts: true, comments: true } })` returns 50 user rows
- THEN exactly 3 queries MUST be issued in total: 1 for the parent `User` rows,
  1 batched query for `posts` keyed on all 50 parent IDs, 1 batched query for
  `comments` keyed on all 50 parent IDs
- AND no per-row query MUST be issued for either relation

### Requirement: Cardinality-correct stitching, including empty/null cases

Stitching MUST honor each relation's declared cardinality:
- One-to-many (list) relations MUST stitch as an array, resolving to `[]`
  (never `undefined` or a missing key) when no child rows match.
- One-to-one and many-to-one (singular) relations MUST stitch as a single
  object or `null` (never `undefined` or a missing key) when no matching row
  exists or the foreign key is null.

#### Scenario: list relation with no matching rows resolves to empty array

- GIVEN a model `User` with list relation `posts`, and a user with zero posts
- WHEN that user is fetched with `include: { posts: true }`
- THEN `user.posts` MUST be `[]`
- AND MUST NOT be `undefined`, `null`, or an absent key

#### Scenario: singular relation with a null foreign key resolves to null

- GIVEN a model `Post` with many-to-one relation `author` backed by a nullable
  foreign key, and a post whose `authorId` is null
- WHEN that post is fetched with `include: { author: true }`
- THEN `post.author` MUST be `null`
- AND MUST NOT be `undefined` or an absent key

#### Scenario: one-to-one relation stitches a single object when present

- GIVEN a model `User` with one-to-one relation `profile`
- WHEN a user with a matching profile row is fetched with `include: { profile: true }`
- THEN `user.profile` MUST be that single profile object, not an array

#### Scenario: many-to-one relation stitches correctly across multiple parents

- GIVEN a model `Post` with many-to-one relation `author`, and several posts
  sharing the same author
- WHEN those posts are fetched with `include: { author: true }`
- THEN every post row MUST carry its own correctly-matched `author` object
- AND posts sharing an author MUST resolve to equal (by identity of data)
  `author` payloads without issuing one query per post

### Requirement: `include` does not accept relation-scoped filtering, ordering, or pagination

In this slice, `include`'s per-relation options MUST NOT accept `where`,
`orderBy`, or `take` (or `skip`) to filter, order, or paginate the included
relation's rows independently of the parent query. Only `true` or
`{ select: {...} }` are valid.

#### Scenario: relation-scoped where is not accepted

- GIVEN a model `User` with list relation `posts`
- WHEN a caller writes `include: { posts: { where: { published: true } } }`
- THEN this MUST NOT be a valid `include` shape for this slice
- AND all matching child rows MUST be returned unfiltered by relation-scoped
  criteria

### Requirement: `_count` is not part of this capability

`include` MUST NOT accept a `_count` key or produce any aggregate count output
in this slice. Count aggregation over relations is deferred to a separate
follow-up capability.

#### Scenario: _count is not a valid include key

- GIVEN a model `User` with list relation `posts`
- WHEN a caller writes `include: { _count: { select: { posts: true } } }`
- THEN this MUST NOT be a valid `include` shape for this slice

### Requirement: Realtime partial refetch stays flat

`RealtimeModelDelegate`'s NOTIFY-driven partial refetch (re-querying a single
changed row via its primary key, e.g. `findFirst({ where: <pk> })`) MUST remain
a flat query with no `include`, regardless of the fact that `include` now
exists on the model delegate's general API surface. The realtime refetch path
MUST NOT implicitly gain relation loading as a side effect of this change.

#### Scenario: NOTIFY-driven refetch issues no relation queries

- GIVEN a `@@realtime` model `User` with list relation `posts`, subscribed via
  `RealtimeModelDelegate`
- WHEN a NOTIFY event for a single row arrives and triggers the internal
  partial refetch (`findFirst({ where: event.pk })`)
- THEN that refetch MUST NOT include an `include` option
- AND MUST NOT issue any follow-up batched relation query
- AND the emitted realtime payload MUST contain only that user's own scalar
  fields, unchanged from pre-`include` behavior

### Requirement: Existing calls without `include`/`select` are unaffected

Calling `findMany`, `findFirst`, or `findUnique` without an `include` option
MUST behave exactly as before this change: no relation queries are issued, and
returned rows carry only their own scalar fields.

#### Scenario: no include means no behavior change

- GIVEN a model `User` with list relation `posts`
- WHEN `db.user.findMany()` is called with no `include` option
- THEN exactly one query MUST be issued
- AND returned rows MUST NOT contain a `posts` key
- AND the SQL and row shape MUST be identical to the pre-`include` behavior
</content>
