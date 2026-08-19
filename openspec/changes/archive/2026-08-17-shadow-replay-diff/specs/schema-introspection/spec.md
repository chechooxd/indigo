# Schema Introspection Specification

## Purpose

Defines `introspectResolvedSchema`: deriving a `ResolvedSchema`-shaped value
from a live PostgreSQL database via `information_schema`/`pg_catalog`,
scoped exactly to the structural facts `planMigration` reads. This is
minimal internal plumbing, not `db pull` — it has explicit fidelity
boundaries and does not attempt byte-for-byte `.indigo` regeneration.

## Requirements

### Requirement: Introspection derives table and column structure

For each table in the target database schema, the system MUST derive its
columns' physical name, SQL type, nullability, and default expression.

#### Scenario: Basic table introspection

- GIVEN a live database with a table containing typed, nullable, and defaulted columns
- WHEN `introspectResolvedSchema` is invoked against that database
- THEN the returned value's table lists each column's physical name, type, nullability, and default expression matching the database

### Requirement: Introspection derives primary keys, foreign keys, and referential actions

The system MUST derive each table's primary key column(s), and each foreign
key's referenced table/column(s) and referential actions (`ON DELETE`/`ON
UPDATE`).

#### Scenario: FK with referential actions

- GIVEN a table with a foreign key declared `ON DELETE CASCADE`
- WHEN the database is introspected
- THEN the returned foreign key carries the referenced table/column and the `CASCADE` delete action

### Requirement: Introspection derives indexes

The system MUST derive each index's columns, uniqueness flag, name, and
method (btree/gin/etc).

#### Scenario: Unique GIN index introspected

- GIVEN a table with a unique GIN index
- WHEN the database is introspected
- THEN the returned index carries the same columns, uniqueness flag, name, and `gin` method

### Requirement: Introspection derives enum types with full member sets

The system MUST derive every enum type used by the schema with its complete,
ordered member list.

#### Scenario: Enum members introspected in order

- GIVEN an enum type with members `A, B, C`
- WHEN the database is introspected
- THEN the returned enum lists `A, B, C` in that order

### Requirement: Introspected `name` equals physical name (fidelity boundary)

Since a live database has no record of `.indigo` logical names, the system
MUST set each introspected table's and column's `name` equal to its
physical `dbName`. Logical names MUST NOT be reconstructed or guessed.

#### Scenario: No logical name recovery

- GIVEN a table whose columns were originally declared with `@map`, so physical and logical names diverge
- WHEN the database is introspected
- THEN every returned column's `name` equals its `dbName`, not the original `.indigo` field name

### Requirement: Introspection excludes non-structural metadata (fidelity boundary)

The system MUST NOT populate `@note` doc comments, table groups, or
datasource metadata — none of these are recoverable from a live database.

#### Scenario: Metadata fields are absent

- GIVEN a live database
- WHEN it is introspected
- THEN the returned value carries no doc-comment, table-group, or datasource metadata

### Requirement: Round-trip fidelity for `planMigration` inputs

For every fixture schema, applying it via `renderPushSql`, introspecting the
result, then calling `planMigration` with the introspected value as `prev`
and the same schema as `next` MUST yield an empty plan.

#### Scenario: Push-introspect-plan round trip

- GIVEN any fixture schema in the corpus
- WHEN the schema is pushed to a fresh database via `renderPushSql`, introspected, and then diffed via `planMigration` against the same schema
- THEN the resulting plan has zero statements and zero diagnostics
