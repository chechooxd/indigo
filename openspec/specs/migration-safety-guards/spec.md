# Migration Safety Guards Specification

## Purpose

Defines guardrails preventing the migrator from emitting DDL that is likely
to fail against a populated database, when the failure is predictable purely
from the schema diff (without requiring runtime knowledge of actual row
data).

## Requirements

### Requirement: Adding a required column without a default is refused

When a migration adds a new column that is non-nullable (`NOT NULL`) and has
no schema-level `@default`, the system MUST NOT emit an unguarded `ALTER
TABLE ... ADD COLUMN ... NOT NULL` statement — this fails against any table
already holding rows (`column "..." contains null values`). It MUST instead
produce an actionable diagnostic naming the table and column, and emit no
DDL for that column, unless the schema declares a `@default` — in which case
PostgreSQL backfills existing rows safely and the column is emitted
unguarded, as today.

#### Scenario: New required column without a default

- GIVEN table `U` gains column `email String` (required, no `@default`) in the next schema
- WHEN a migration is generated
- THEN no DDL statement is emitted for `email`, and an actionable diagnostic names table `U`, column `email`, and explains that a default is required or the field must be added as optional and backfilled manually

#### Scenario: New required column with a default

- GIVEN table `U` gains column `email String @default("")` in the next schema
- WHEN a migration is generated
- THEN `ALTER TABLE "U" ADD COLUMN "email" text NOT NULL DEFAULT '';` is emitted unguarded (regression)

#### Scenario: New optional column

- GIVEN table `U` gains column `email String?` (nullable, no default) in the next schema
- WHEN a migration is generated
- THEN `ALTER TABLE "U" ADD COLUMN "email" text;` is emitted unguarded, with no `NOT NULL` clause (regression)
