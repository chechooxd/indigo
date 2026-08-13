# Migration DDL Ordering Specification

## Purpose

Defines the required statement ordering guarantees for generated migration SQL:
foreign key constraints relative to the tables they reference, the top-level
category order of a migration, and how enum value additions relate to the
migration's transaction boundary. Applies to `packages/migrator`'s versioned
migration path (`diffResolved`/`renderMigrationSql`); the idempotent `db push`
path (`renderPushSql`) already applies FKs in a dedicated post-table pass and
is unaffected.

## Requirements

### Requirement: Foreign key statements never precede their referenced table

Every `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statement in a
generated migration MUST appear after the `CREATE TABLE` statement of every
table it references, whenever that referenced table is created within the
same migration. This MUST hold regardless of model declaration order in the
`.indigo` source, including self-references and cycles between two or more
newly created tables, and regardless of whether the referencing table is
itself newly created or only altered in the same migration.

#### Scenario: Referenced table declared after the referencing table

- GIVEN `Post` (with an FK to `User`) is declared before `User` in the schema
- WHEN a migration is generated from `null` to this schema
- THEN `CREATE TABLE "User"` appears before the `ALTER TABLE "Post" ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "User"` statement

#### Scenario: Self-referencing table

- GIVEN `Employee` has a `managerId` FK referencing `Employee` itself
- WHEN a migration is generated
- THEN `CREATE TABLE "Employee"` precedes its own FK constraint statement

#### Scenario: Genuine cycle between two new tables

- GIVEN `A` (new) has an FK to `B`, and `B` (new) has an FK to `A`
- WHEN a migration is generated
- THEN both `CREATE TABLE "A"` and `CREATE TABLE "B"` are emitted before either FOREIGN KEY constraint statement, so both constraints satisfy the ordering rule simultaneously

#### Scenario: Existing table altered to reference a new table

- GIVEN table `X` already exists and is altered to add an FK to newly created table `Y` (declared after `X`)
- WHEN a migration is generated
- THEN `CREATE TABLE "Y"` appears before the `ALTER TABLE "X" ADD CONSTRAINT ...` statement referencing it

### Requirement: Top-level statement category order is fixed

A generated migration MUST order statement categories as: (1) enum
creation/`ADD VALUE`, (2) the realtime notify function (only when realtime is
newly introduced), (3) new and altered tables, (4) dropped tables
(`CASCADE`), (5) dropped enums. This order MUST be preserved by future
changes to `packages/migrator`.

#### Scenario: Combined change exercises every category

- GIVEN a schema pair that adds an enum, introduces the first `@@realtime` table, adds a table, drops a table, and drops an unused enum
- WHEN the migration is generated
- THEN the statements appear in the fixed category order above, verifiable by statement index

### Requirement: Enum value additions apply outside the migration transaction

`ALTER TYPE ... ADD VALUE` statements MUST remain in the same migration file
as the rest of the change (no separate migration file) but MUST be
structurally distinguishable from the transactional statements, so the
migration runner executes them outside the `BEGIN`/`COMMIT` block. Because
they are already emitted with `IF NOT EXISTS`, re-running them against a
database where the value already exists MUST be a no-op, not an error.

#### Scenario: Enum value added alongside other changes

- GIVEN a next schema that adds value `"D"` to enum `S` and also adds a column to table `T`
- WHEN the migration is generated
- THEN the `ALTER TYPE "S" ADD VALUE IF NOT EXISTS 'D';` statement is grouped/positioned outside the transactional block containing the `ALTER TABLE "T" ...` statement, within the same file

#### Scenario: Re-running an already-applied enum addition

- GIVEN a migration whose enum `ADD VALUE IF NOT EXISTS` statement was already applied
- WHEN the same statement runs again
- THEN it succeeds without error

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
