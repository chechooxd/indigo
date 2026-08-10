# Delta for Enum Value Mapping

## ADDED Requirements

### Requirement: Enum DDL renders from members' `dbName`, not logical names

Both the versioned migration renderer and the idempotent push renderer MUST
render enum values using each `ResolvedEnum` member's `dbName`, not the
logical `values` list, so an enum value's `@map` reaches the database in
`CREATE TYPE`, `ALTER TYPE ... ADD VALUE`, and (via `db push`) the guarded
`CREATE TYPE` block.

#### Scenario: Initial enum creation with a mapped value, versioned migration

- GIVEN `enum Status { ACTIVE @map("active") INACTIVE }`
- WHEN a migration is generated for the enum's initial creation
- THEN `CREATE TYPE "Status" AS ENUM ('active', 'INACTIVE');` is emitted, using each member's `dbName`

#### Scenario: Initial enum creation with a mapped value, db push

- GIVEN the same enum
- WHEN `renderPushSql` renders the schema
- THEN the guarded `CREATE TYPE "Status" AS ENUM ('active', 'INACTIVE');` block uses each member's `dbName`

#### Scenario: Enum value added with a `@map`

- GIVEN enum `Status` previously had members `ACTIVE`/`INACTIVE` and the next schema adds `PENDING @map("pending")`
- WHEN a migration is generated
- THEN `ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'pending';` is emitted, using the new member's `dbName`

#### Scenario: Unmapped member renders its own name

- GIVEN an enum member with no `@map`
- WHEN DDL is rendered (either path)
- THEN its `dbName` equals its own name, and DDL renders that name unchanged (regression)
