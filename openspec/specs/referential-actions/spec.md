# Referential Actions Specification

## Purpose

Defines how `onDelete` and `onUpdate` referential actions on `@relation` attributes are parsed, validated, and carried into the resolved IR's `ForeignKey`.

## Requirements

### Requirement: Bare and quoted referential action values are both accepted

The compiler MUST resolve `onDelete` and `onUpdate` values written as a bare identifier (e.g. `onDelete: Cascade`, an `AttributeValue::Reference`) identically to the quoted string form (e.g. `onDelete: "Cascade"`).

#### Scenario: Bare onDelete reaches the foreign key

- GIVEN a `@relation` attribute with `onDelete: Cascade` (bare identifier)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` for that relation carries `onDelete: "Cascade"`

#### Scenario: Quoted onDelete reaches the foreign key

- GIVEN a `@relation` attribute with `onDelete: "Cascade"` (quoted string)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` carries `onDelete: "Cascade"`, matching the bare form

#### Scenario: Bare onUpdate reaches the foreign key

- GIVEN a `@relation` attribute with `onUpdate: Restrict` (bare identifier)
- WHEN the schema is resolved
- THEN the resulting `ForeignKey` carries `onUpdate: "Restrict"`

#### Scenario: Absent referential action stays absent

- GIVEN a `@relation` attribute with no `onDelete` and no `onUpdate`
- WHEN the schema is resolved
- THEN the `ForeignKey` carries neither key (absent, not null or empty string)

### Requirement: Referential action values are validated against a fixed domain

The compiler MUST accept only `Cascade`, `Restrict`, `SetNull`, `SetDefault`, and `NoAction` for `onDelete`/`onUpdate`, in either bare or quoted form. Any other value MUST produce a diagnostic naming the field, the invalid value, and the allowed set.

#### Scenario: Invalid referential action value

- GIVEN a `@relation` attribute with `onDelete: Nonsense`
- WHEN the schema is validated
- THEN a diagnostic is produced naming the model, the field, `"Nonsense"`, and the five allowed values

#### Scenario: Case-sensitive rejection

- GIVEN a `@relation` attribute with `onDelete: cascade` (lowercase)
- WHEN the schema is validated
- THEN a diagnostic is produced, since the domain is case-sensitive PascalCase

### Requirement: Referential actions reach emitted foreign key DDL

Both the versioned migration renderer (`packages/migrator/src/migrate.ts`)
and the idempotent push renderer (`packages/migrator/src/postgres.ts`) MUST
emit `ON DELETE` and `ON UPDATE` clauses on `ADD CONSTRAINT ... FOREIGN KEY`
statements from `ForeignKey.onDelete`/`ForeignKey.onUpdate` when present, and
omit the corresponding clause when absent.

#### Scenario: Both actions present, versioned migration

- GIVEN a `ForeignKey` with `onDelete: "Cascade"` and `onUpdate: "Restrict"`
- WHEN a migration is generated for the table's initial creation
- THEN the `ADD CONSTRAINT ... FOREIGN KEY` statement includes `ON DELETE CASCADE ON UPDATE RESTRICT`

#### Scenario: Both actions present, db push

- GIVEN the same `ForeignKey`
- WHEN `renderPushSql` renders the schema
- THEN the guarded `DO $$` foreign key block includes `ON DELETE CASCADE ON UPDATE RESTRICT`

#### Scenario: Only onDelete present

- GIVEN a `ForeignKey` with `onDelete: "Cascade"` and no `onUpdate`
- WHEN DDL is rendered (either path)
- THEN the statement includes `ON DELETE CASCADE` and no `ON UPDATE` clause

#### Scenario: Neither action present

- GIVEN a `ForeignKey` with no `onDelete` and no `onUpdate`
- WHEN DDL is rendered (either path)
- THEN the statement includes no referential-action clause (regression)

### Requirement: A referential-action change alone is detected and re-issued

The migration diff MUST detect when only `onDelete` and/or `onUpdate`
changes on an otherwise-unchanged foreign key (same columns, same referenced
table/columns) and emit a `DROP CONSTRAINT` followed by an `ADD CONSTRAINT
... FOREIGN KEY` carrying the new referential action(s). An unchanged
foreign key (including its referential actions) MUST NOT produce DDL.

#### Scenario: onDelete changes

- GIVEN a foreign key's `onDelete` changes from `"Cascade"` to `"SetNull"` between previous and next schema, with columns and referenced table unchanged
- WHEN a migration is generated
- THEN the statements drop the existing constraint and add a new one with `ON DELETE SET NULL`

#### Scenario: onUpdate changes

- GIVEN a foreign key's `onUpdate` changes from absent to `"Cascade"`, with columns and referenced table unchanged
- WHEN a migration is generated
- THEN the statements drop the existing constraint and add a new one with `ON UPDATE CASCADE`

#### Scenario: No referential-action change

- GIVEN a foreign key is unchanged, including `onDelete`/`onUpdate`
- WHEN a migration is generated
- THEN no DDL statement is emitted for that foreign key (regression pinning current matching behavior)
