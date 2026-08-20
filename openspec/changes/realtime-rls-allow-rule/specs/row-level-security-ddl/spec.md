# Row-Level Security DDL Specification

## Purpose

Defines how resolved `@@allow` rules are rendered into Postgres DDL: enabling RLS, emitting
policies, deriving casts, and keeping both `db push` and versioned migrations idempotent and
diff-complete.

## Requirements

### Requirement: RLS is enabled and forced for models with `@@allow`

For every table whose resolved IR carries at least one allow rule, the migrator MUST emit
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
Tables without `@@allow` MUST NOT receive RLS DDL.

#### Scenario: Enable + force emitted for a protected model

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)`
- WHEN `db push` DDL is rendered
- THEN the output includes both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
  for that table

#### Scenario: No RLS DDL for unprotected models

- GIVEN a model with no `@@allow` declarations
- WHEN `db push` DDL is rendered
- THEN no RLS DDL is emitted for that table

### Requirement: One idempotent `CREATE POLICY` per rule per action

The migrator MUST emit one `CREATE POLICY ... AS PERMISSIVE` per resolved allow rule, following
the existing drop-if-exists-then-create idempotency pattern used for realtime triggers, with a
stable, distinct policy name per rule so repeated `db push` runs converge without error.

#### Scenario: Two rules produce two named policies

- GIVEN a model with two `@@allow(read, ...)` rules
- WHEN `db push` DDL is rendered
- THEN two distinct `CREATE POLICY` statements are emitted, each with a stable, unique name

#### Scenario: Re-running push is a no-op

- GIVEN a schema whose policies were already applied
- WHEN `db push` is run again unchanged
- THEN the rendered DDL drops and recreates identical policies without error

### Requirement: The `current_setting` cast matches the compared field's scalar type

The migrator MUST derive the Postgres cast applied to `current_setting('app.user_id')` from the
scalar type of the `this.<field>` side of the rule's equality, never a hardcoded type.

#### Scenario: Integer owner key

- GIVEN `@@allow(read, auth.userId == this.ownerId)` where `ownerId` is `Int`
- WHEN the policy is rendered
- THEN the `USING` clause casts `current_setting('app.user_id')` to `::int`

#### Scenario: String/UUID owner key

- GIVEN `@@allow(read, auth.userId == this.ownerId)` where `ownerId` is `String`
- WHEN the policy is rendered
- THEN the `USING` clause does not apply an `::int` cast

### Requirement: Versioned migrations diff policies completely

`diffResolved`/`renderMigrationSql` MUST emit `CREATE POLICY` for added rules, `DROP POLICY`
for removed rules, and drop-then-create for altered rules (condition or action change), matched
against the previous snapshot.

#### Scenario: Adding `@@allow` to an existing model

- GIVEN a previously migrated model with no `@@allow`
- WHEN `@@allow(read, auth.userId == this.ownerId)` is added and diffed
- THEN the migration includes `ENABLE`/`FORCE ROW LEVEL SECURITY` and the new `CREATE POLICY`

#### Scenario: Removing `@@allow`

- GIVEN a previously migrated model with an allow rule
- WHEN the `@@allow` declaration is removed and diffed
- THEN the migration includes the matching `DROP POLICY`

### Requirement: Deny-by-default requires no extra DDL

The specification relies on native Postgres semantics: an RLS-enabled table with no policy
matching the current operation returns zero rows. The migrator MUST NOT emit any additional
deny-path DDL or error handling for this case.

#### Scenario: No matching policy yields zero rows, not an error

- GIVEN a table with RLS enabled and only a `read` policy
- WHEN an `INSERT` is attempted with no matching policy
- THEN Postgres rejects the row via its native RLS check, and no IndigoDB-authored DDL is
  responsible for that denial
