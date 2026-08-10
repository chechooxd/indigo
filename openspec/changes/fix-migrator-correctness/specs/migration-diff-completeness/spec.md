# Migration Diff Completeness Specification

## Purpose

Defines the DDL (or refusal) required for schema changes that currently
produce zero statements from `diffResolved`: physical field renames via
`@map`, primary key changes, and enum value removal. A silent no-op MUST NOT
occur for any detectable schema change — every change either emits correct
DDL or produces an actionable diagnostic and emits nothing for that change.

## Requirements

### Requirement: An unambiguous `@map`-only rename emits a column rename

When a field's logical name is unchanged but its `@map` (physical column
name) changes, the system MUST emit `ALTER TABLE ... RENAME COLUMN` and MUST
NOT emit `DROP COLUMN`/`ADD COLUMN` for that field, preserving existing data.

#### Scenario: Physical rename via @map

- GIVEN field `createdAt` has `@map("created_at")` in the previous schema and `@map("creation_date")` in the next schema, with the field name unchanged
- WHEN a migration is generated
- THEN the only statement for that field is `ALTER TABLE ... RENAME COLUMN "created_at" TO "creation_date";`

### Requirement: A simultaneous field-name-and-`@map` change is refused

When a field's logical name AND its `@map` both change between the previous
and next schema, the rename target is ambiguous. The system MUST detect this
and produce an actionable diagnostic naming the model and field instead of
emitting DDL. It MUST NOT emit `RENAME COLUMN` (which could rename the wrong
data) and MUST NOT emit `DROP COLUMN`/`ADD COLUMN` (which would silently
discard data).

#### Scenario: Field renamed and remapped in the same edit

- GIVEN field `createdAt @map("created_at")` becomes `creationDate @map("creation_date")` in the next schema
- WHEN a migration is generated
- THEN no DDL statement is emitted for that field, and an actionable diagnostic identifies the model, the old field/`@map` pair, and the new field/`@map` pair
- AND migration generation for this schema pair does not silently succeed with partial DDL

### Requirement: A primary key change is emitted as drop-and-recreate

When the set of primary-key column(s) changes, the system MUST emit a
statement dropping the previous primary key constraint and a statement
adding the new primary key constraint over the new column(s). No data
movement is required or performed.

#### Scenario: Primary key moved to a different column

- GIVEN table `T`'s primary key is on `id` in the previous schema and on `code` in the next schema
- WHEN a migration is generated
- THEN the emitted statements drop the existing primary key constraint on `T` and add a new primary key constraint on `T` (`code`), in that order

### Requirement: Enum value removal is refused, not silently applied

PostgreSQL cannot drop a single enum value without recreating the type, and
recreating the type requires a `USING` cast that fails at migration time if
any row still holds the removed value. The system MUST NOT attempt DDL for a
removed enum value. It MUST instead detect the removal and produce an
actionable diagnostic naming the enum and the removed value(s), explaining
that the change requires a manual data migration.

#### Scenario: Enum value removed

- GIVEN `enum S { A B C }` becomes `enum S { A B }`
- WHEN a migration is generated
- THEN no DDL statement is emitted for the removal of `C`, and an actionable diagnostic names enum `S`, value `C`, and states that manual data migration is required
