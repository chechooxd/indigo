# Delta for Referential Actions

## ADDED Requirements

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
