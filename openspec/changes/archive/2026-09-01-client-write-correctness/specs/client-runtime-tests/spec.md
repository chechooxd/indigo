# Delta for Client Runtime Tests

## ADDED Requirements

### Requirement: pglite suites cover the write-precondition and unique-selector guards

The test suite MUST gain pglite-backed coverage for `client-write-preconditions`
and `client-unique-write-selector`, exercising every guard at every affected
site, plus the flipped nested-write zero-match case.

#### Scenario: Empty-SET suite covers both the direct path and the relation-ops-guarded path

- GIVEN the PGlite-backed executor adapter and a seeded `User` table
- WHEN the empty-`SET` suite runs
- THEN it MUST assert `db.user.update({ where, data: { name: undefined } })`
  (no relation ops) throws `IndigoArgumentError` with `code: "EMPTY_UPDATE_DATA"`
  before any SQL is issued
- AND it MUST assert the pre-existing relation-ops-only empty-scalar guard
  still throws its own error unchanged (regression pin)

#### Scenario: Not-found suite covers all three write sites

- GIVEN the PGlite-backed executor adapter and a seeded `User`/`Post` schema
  with no row matching a chosen id
- WHEN the not-found suite runs
- THEN it MUST assert a zero-row `update` on the direct scalar path throws
  `IndigoNotFoundError` with `code: "RECORD_NOT_FOUND"`
- AND it MUST assert a zero-row `delete` throws the same error
- AND it MUST assert a zero-row `update` whose `data` contains only relation
  operations (no scalar fields) also throws the same error

#### Scenario: nested-writes-update.mjs C1.4c is rewritten to assert the throw

- GIVEN `packages/client/test/nested-writes-update.mjs` case C1.4c, which
  previously asserted `result === undefined` for a zero-match
  relation-ops-only `update`
- WHEN the suite runs after this change
- THEN C1.4c MUST assert the call rejects with `IndigoNotFoundError` and
  `code: "RECORD_NOT_FOUND"`
- AND MUST NOT retain any assertion that the call resolves with `undefined`

#### Scenario: Unique-selector suite covers accept, reject, and ambiguous-target interaction

- GIVEN the PGlite-backed executor adapter and a model whose generated
  `__meta.uniqueGroups` declares a group with no matching database-level
  unique constraint, seeded with two rows sharing that value
- WHEN the unique-selector suite runs
- THEN it MUST assert `update`/`delete` with a `where` matching the declared
  unique group succeeds
- AND it MUST assert an `as any` bypass with a `where` matching no declared
  unique group throws `IndigoArgumentError` with `code: "NO_MATCHING_UNIQUE_CONSTRAINT"`
  before any SQL is issued
- AND it MUST assert `update` with both relation ops and a `where` that
  passes the unique-shape check but matches multiple rows still throws
  `IndigoNestedWriteError` with `code: "AMBIGUOUS_UPDATE_TARGET"`, unshadowed
  by the unique-selector guard

#### Scenario: findUnique and *Many where semantics are pinned as non-regressions

- GIVEN the PGlite-backed executor adapter and a model with a non-unique
  field
- WHEN the regression suite runs
- THEN it MUST assert `findUnique` still accepts a non-unique `where` and
  returns `Payload | null`
- AND it MUST assert `updateMany`/`deleteMany` still accept a non-unique,
  potentially multi-row-matching `where`
</content>
