# Delta for Studio UI Honesty

## ADDED Requirements

### Requirement: Docs-view DDL never fabricates schema data
The docs surface's rendered DDL (`generateTableDDL`) MUST NOT present any index, index
property, or primary-key reference that does not exist in the resolved schema's IR. This
closes the gap between this spec's Purpose line — which names "docs" as a covered surface —
and its Requirements, which previously specified nothing for that surface.

#### Scenario: A table with zero indexes shows no fabricated index
- GIVEN a table with no `@@index` or `@@unique` declarations, so its resolved `indexes` is `[]`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL contains zero `CREATE INDEX` statements and zero occurrences of `idx_`

#### Scenario: A table with a real index shows exactly that index
- GIVEN a table declaring `@@index([authorId, createdAt])`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL contains one `CREATE INDEX` statement over `(authorId, createdAt)`
  in that column order, and no other index statement

#### Scenario: Primary-key reference matches the declared schema
- GIVEN a table whose primary key is `uuid`, not `id`, and the schema declares no column
  named `id`
- WHEN the docs view renders that table's DDL
- THEN the rendered DDL marks `uuid` as the primary key and contains no reference to a
  column named `id`
