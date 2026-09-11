# Studio Docs DDL Specification

## Purpose

The Studio docs view (`apps/studio/src/features/docs/`) renders a display-only `CREATE TABLE`
DDL snippet per table. Every statement and clause in that rendered DDL MUST correspond to
data actually present in the resolved schema's IR (`ResolvedTable`/`ResolvedIndex`,
`packages/core/src/ir.ts:90-104, 186-198`). No index, index property, or primary-key column
MAY be fabricated, defaulted, or hardcoded.

## Requirements

### Requirement: Resolved index data survives the adapter boundary
`Table` (`apps/studio/src/types.ts:26-40`) MUST carry an `indexes` field populated from
`ResolvedTable.indexes` (`ir.ts:198`). `resolvedToTables` (`apps/studio/src/lib/schema-adapter.ts:70-99`)
MUST map each table's `indexes` array, preserving `columns` order, `unique`, `name`, and `type`
for every `ResolvedIndex` entry. This field MUST NOT be silently dropped for any table.

#### Scenario: Indexes reach the adapted Table
- GIVEN a `ResolvedTable` with `indexes: [{ columns: ["email"], unique: true }]`
- WHEN `resolvedToTables` maps it
- THEN the resulting `Table.indexes` contains exactly one entry with `columns: ["email"]`
  and `unique: true`

#### Scenario: A table with no indexes maps to an empty array
- GIVEN a `ResolvedTable` with `indexes: []`
- WHEN `resolvedToTables` maps it
- THEN the resulting `Table.indexes` is `[]`, not `undefined` and not a fabricated entry

### Requirement: Rendered DDL contains no fabricated index statement
`generateTableDDL` (`apps/studio/src/features/docs/lib/ddl-generator.ts`) MUST render exactly
one `CREATE INDEX` or `CREATE UNIQUE INDEX` statement per entry in `table.indexes`, and MUST NOT
emit any index statement that does not correspond to an entry in that array. A table whose
`indexes` array is empty MUST render no `CREATE INDEX` statement at all.

#### Scenario: No indexes renders no CREATE INDEX
- GIVEN a table with `indexes: []`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains zero occurrences of `CREATE INDEX`
- AND zero occurrences of `idx_`

#### Scenario: One index renders exactly one statement
- GIVEN a table `posts` with `indexes: [{ columns: ["authorId"], unique: false }]`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains exactly one `CREATE INDEX` statement referencing
  `authorId`, and no `CREATE UNIQUE INDEX` statement

#### Scenario: Composite index preserves column order
- GIVEN a table with `indexes: [{ columns: ["authorId", "createdAt"], unique: false }]`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains `(authorId, createdAt)` in that exact order,
  not `(id)` and not a reordered column list

#### Scenario: Unique index renders CREATE UNIQUE INDEX
- GIVEN a table with `indexes: [{ columns: ["email"], unique: true }]`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains `CREATE UNIQUE INDEX`
- AND does not contain a plain `CREATE INDEX` for that same index

#### Scenario: Index columns unrelated to the primary key render as declared
- GIVEN a table whose `primaryKey` is `["id"]` and `indexes: [{ columns: ["slug"], unique: false }]`
- WHEN `generateTableDDL(table)` is called
- THEN the rendered index statement references `slug`, not `id`

### Requirement: `USING <method>` is emitted only when the index declares a type
Rendered index DDL MUST NOT include a `USING` clause when `ResolvedIndex.type` is absent,
because `ir.ts:97-102` canonicalizes an explicit `type: btree` to absent so it never diffs
against an implicit btree index. When `type` is present, the rendered clause MUST be
`USING <type>` with that exact value.

#### Scenario: Absent type renders no USING clause
- GIVEN an index with `columns: ["email"], unique: true` and no `type` property
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains no `USING` clause for that index

#### Scenario: Explicit non-btree type renders its USING clause
- GIVEN an index with `columns: ["tags"], unique: false, type: "gin"`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains `USING gin` for that index

### Requirement: Primary-key clauses derive from `table.primaryKey`, never a hardcoded column
Rendered `PRIMARY KEY` markers MUST reference exactly the columns in `table.primaryKey`, in
its order, and MUST NOT assume or hardcode a column named `id`. A composite `primaryKey`
MUST mark every listed column, not only the first.

#### Scenario: Non-id primary key renders correctly
- GIVEN a table whose `primaryKey` is `["uuid"]` and no column is named `id`
- WHEN `generateTableDDL(table)` is called
- THEN the returned string contains no reference to a column named `id`
- AND the `uuid` column's line is marked as the primary key

#### Scenario: Composite primary key marks every column
- GIVEN a table whose `primaryKey` is `["tenantId", "userId"]`
- WHEN `generateTableDDL(table)` is called
- THEN both the `tenantId` and `userId` column lines are marked as primary key
