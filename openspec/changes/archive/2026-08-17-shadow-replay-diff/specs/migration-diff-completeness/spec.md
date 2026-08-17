# Delta for Migration Diff Completeness

## MODIFIED Requirements

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
and next schema, the rename target is ambiguous. The system MUST detect
this and produce an actionable diagnostic naming the model and field
instead of emitting DDL. It MUST NOT emit `RENAME COLUMN` (which could
rename the wrong data) and MUST NOT emit `DROP COLUMN`/`ADD COLUMN` (which
would silently discard data).

This ambiguity requirement applies when `prev` carries recoverable logical
names. When `prev` is shadow-replay-derived, logical names are never
recoverable, so this specific ambiguity condition cannot arise on the
`prev` side; such an edit instead falls under the physical-rename
degradation documented above.

#### Scenario: Field renamed and remapped in the same edit (schema-sourced prev)

- GIVEN field `createdAt @map("created_at")` becomes `creationDate @map("creation_date")` in the next schema, and `prev` is `.indigo`- or snapshot-sourced
- WHEN a migration is generated
- THEN no DDL statement is emitted for that field, and an actionable diagnostic identifies the model, the old field/`@map` pair, and the new field/`@map` pair
- AND migration generation for this schema pair does not silently succeed with partial DDL
