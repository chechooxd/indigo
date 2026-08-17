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
name) changes, and `prev` carries recoverable logical names (a `.indigo`-
sourced or snapshot-sourced schema), the system MUST emit `ALTER TABLE ...
RENAME COLUMN` and MUST NOT emit `DROP COLUMN`/`ADD COLUMN` for that field,
preserving existing data.

When `prev` is derived via shadow-replay-then-introspect (see
`schema-introspection`), it carries no recoverable logical names — every
introspected column's `name` equals its physical `dbName`. Column matching
therefore falls back to physical-name matching only (`dbName` stability
across `prev`/`next`). A genuine `@map` physical rename changes `dbName`
between `prev` and `next` by definition, so it MUST be emitted as
`DROP COLUMN`/`ADD COLUMN` rather than a rename in this case. This is
accepted, documented behavior, not a bug: it is the known fidelity boundary
of introspection-derived `prev`, and it is most visible as a one-time cost
on the first migration generated after adopting shadow-replay-diff for a
schema that already has an established `@map`.

(Previously: rename detection assumed `prev` always carried recoverable
logical names; the physical-only-`prev` case did not exist.)

#### Scenario: Physical rename via @map with schema-sourced prev

- GIVEN field `createdAt` has `@map("created_at")` in the previous schema and `@map("creation_date")` in the next schema, with the field name unchanged, and `prev` is `.indigo`- or snapshot-sourced
- WHEN a migration is generated
- THEN the only statement for that field is `ALTER TABLE ... RENAME COLUMN "created_at" TO "creation_date";`

#### Scenario: @map rename degrades to drop+add with shadow-replay-derived prev (accepted, documented)

- GIVEN a schema already has field `createdAt @map("created_at")` applied to the real database, shadow-replay-diff has just been adopted, and the schema is then edited to `createdAt @map("creation_date")`
- WHEN `migrate dev` builds `prev` via shadow-replay-then-introspect and generates a migration
- THEN the emitted statements are `ALTER TABLE ... DROP COLUMN "created_at"` and `ALTER TABLE ... ADD COLUMN "creation_date" ...` for that field, not a `RENAME COLUMN`
- AND this is the documented, expected behavior of introspection-derived `prev`, not a defect to be filed or mitigated

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

### Requirement: Index identity includes name and method, not just columns

`diffResolved`'s index-matching signature MUST include the index's resolved
`name` and `type` (method) in addition to its uniqueness flag and column
set. Two indexes with identical columns but a different name and/or a
different method MUST NOT be treated as unchanged.

(Previously undocumented: `indexSignature` computed identity as
`${unique ? "u" : "i"}:${columns.join(",")}` only — name and type changes on
an otherwise-identical index produced zero diff statements, a silent no-op.)

#### Scenario: Method-only change is diffed, not a no-op

- GIVEN table `T` has `@@index([tags])` (btree, implicit) in the previous schema and `@@index([tags], type: gin)` in the next schema
- WHEN a migration is generated
- THEN the emitted statements drop the previous index and create the new one `USING gin`, and the diff is not empty

#### Scenario: Name-only change is diffed, not a no-op

- GIVEN table `T` has `@@index([a])` (auto-derived name) in the previous schema and `@@index([a], name: "a_custom_idx")` in the next schema
- WHEN a migration is generated
- THEN the emitted statements rename or drop-and-recreate the index under `"a_custom_idx"`, and the diff is not empty

#### Scenario: Unchanged index (same columns, name, and method) remains a no-op

- GIVEN table `T`'s index declaration is byte-identical between the previous and next schema
- WHEN a migration is generated
- THEN no DDL statement is emitted for that index, matching current behavior
