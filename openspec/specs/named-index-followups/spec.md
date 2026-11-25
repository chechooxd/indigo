# Named-Index Follow-Ups Specification

## Purpose

Adds partial (`where:`) and expression (`expression:`) indexes to `.indigo` schemas, DDL,
migrations, introspection, schema printing, and Studio docs, plus client-side index awareness
(`ModelMeta.indexes`, `uniqueGroups` exclusion for partial/expression uniques, and
`ModelDelegate.explain()`).

## Requirements

### Requirement: `@@index` and `@@unique` accept `where:` and `expression:` arguments

The compiler MUST recognize `where` and `expression` in `INDEX_ARG_KEYS` on `@@index`/`@@unique`.
`where:` MUST be a non-empty string literal without control characters. `expression:` MUST be a
non-empty string literal without control characters, MUST be paired with an empty column list `[]`,
and MUST declare an explicit `name:`. When `expression:` is absent, the column list MUST be
non-empty.

#### Scenario: Partial index and expression index compile into `ResolvedIndex`

- GIVEN a model declaring `@@index([email], where: "deleted_at IS NULL")` and
  `@@unique([], expression: "lower(email)", name: "user_lower_email_key")`
- WHEN compiled through `parse` + `validate` + `resolve`
- THEN validation returns zero errors and `ResolvedIndex` carries `where: "deleted_at IS NULL"`
  on the first index and `columns: [], expression: "lower(email)", name: "user_lower_email_key"`
  on the second

#### Scenario: Invalid `where:` or `expression:` combinations are rejected with diagnostics

- GIVEN an index with `expression:` plus non-empty columns `[email]`, OR `expression:` without
  `name:`, OR empty `where: ""`, OR non-string `where: 1`
- WHEN validated
- THEN each produces a clear `ValidationError` naming the model and rule

### Requirement: Migrator renders, diffs, and introspects partial and expression indexes

`renderIndexDdl` MUST emit `(${index.expression})` when `expression` is set and
` WHERE ${index.where}` when `where` is set, while keeping plain indexes byte-identical.
`planMigration` MUST emit `DROP INDEX` + `CREATE INDEX` when `where` or `expression` changes,
and `ALTER INDEX RENAME` when only `name` changes. `introspectResolvedSchema` MUST populate
`where` from `pg_get_expr(ix.indpred, ix.indrelid)` and `expression` from
`pg_get_expr(ix.indexprs, ix.indrelid)` and MUST NOT fold a partial unique index into `col.unique`.

#### Scenario: Partial and expression indexes apply to PostgreSQL and round-trip via introspection

- GIVEN a schema with a partial index, a partial unique index, and an expression index
- WHEN pushed via `renderPushSql` into PostgreSQL (PGlite) and introspected via
  `introspectResolvedSchema`
- THEN PostgreSQL creates all three indexes without error, introspection returns all three in
  `table.indexes` with `where` / `expression` populated, and the partial unique index does NOT
  set `col.unique = true`

#### Scenario: Changing `where` or `expression` diffs as DROP + CREATE

- GIVEN a migration diff where an index's `where` predicate changes from `"deleted_at IS NULL"`
  to `"active = true"`
- WHEN `planMigration` runs
- THEN it emits `DROP INDEX` followed by `CREATE INDEX ... WHERE active = true;`

### Requirement: Client is index-aware (`delegate.indexes`, `uniqueGroups` safety, `delegate.explain()`)

`@indigodb/generator` MUST emit `indexes` on `__meta[Model]` and MUST exclude partial (`where`)
and expression (`expression`) unique indexes from `uniqueGroups` / `<Model>WhereUniqueInput`.
`ModelDelegate` MUST expose `readonly indexes: readonly IndexMeta[]` and
`explain(args?): Promise<ExplainResult>` executing `EXPLAIN (FORMAT JSON)` on the exact
parameterized `findMany` SQL.

#### Scenario: Partial unique index is exposed in `delegate.indexes` and excluded from `uniqueGroups`

- GIVEN a model with `@id`, a regular `@@unique([orgId, slug])`, and a partial
  `@@unique([email], where: "deleted_at IS NULL", name: "active_email_key")`
- WHEN generated via `generateClient`
- THEN `uniqueGroups` includes `["id"]` and `["orgId", "slug"]` ONLY (NOT `["email"]`)
- AND `delegate.indexes` contains both indexes including `where: "deleted_at IS NULL"`

#### Scenario: `delegate.explain()` runs PostgreSQL EXPLAIN and reports index usage

- GIVEN a table populated in PostgreSQL (PGlite) with an index on `email`
- WHEN `delegate.explain({ where: { email: "a@b.com" } })` runs (with `enable_seqscan = off`
  or indexed lookup)
- THEN `ExplainResult` returns the exact parameterized `sql` and `params`, `scanTypes`,
  `indexNames` containing the index name, `usesIndex: true`, and raw `plan`
