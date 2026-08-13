# Delta for Migration DDL Ordering

## ADDED Requirements

### Requirement: Column type rendering honors a native type override

When rendering a column's SQL type — in both `renderPushSql`'s `CREATE TABLE`
path and `renderMigrationSql`'s `CREATE TABLE`/`ADD COLUMN` paths — the
migrator MUST use `ResolvedColumn.nativeType` (`{ name, args }`) when present,
rendering it as `NAME(arg1, arg2, ...)` (or bare `NAME` when `args` is empty),
instead of the logical-scalar mapping (`mapScalarToPg`). Columns without a
`nativeType` MUST continue to render via `mapScalarToPg`, unchanged from
current behavior. `ALTER COLUMN TYPE` diffing for a column whose native type
changes between schema versions is explicitly deferred to a follow-up change
and is out of scope here.

#### Scenario: Column with a native type override

- GIVEN a `ResolvedColumn` for field `bio` with `nativeType: { name: "VarChar", args: ["255"] }`
- WHEN `db push` DDL is rendered for the containing table
- THEN the column is emitted as `"bio" VARCHAR(255)`, not `"bio" text`

#### Scenario: Column with a zero-argument native type override

- GIVEN a `ResolvedColumn` for field `id` with `nativeType: { name: "Uuid", args: [] }`
- WHEN `db push` DDL is rendered
- THEN the column is emitted as `"id" UUID`

#### Scenario: Column without a native type override

- GIVEN a `ResolvedColumn` for field `name` with no `nativeType`
- WHEN DDL is rendered (either `db push` or a versioned migration)
- THEN the column type is emitted exactly as `mapScalarToPg` would produce today, with no behavior change

#### Scenario: Versioned migration ADD COLUMN honors the override

- GIVEN a migration that adds a new column `bio` with `nativeType: { name: "VarChar", args: ["255"] }`
- WHEN the migration SQL is generated
- THEN the `ALTER TABLE ... ADD COLUMN "bio" VARCHAR(255)` statement is emitted
</content>
</invoke>
