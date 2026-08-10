# Release Notes — Migrator DDL Correctness

## Read this before your next `migrate dev`

Schemas that previously reported **"No schema changes"** may now produce a real
migration, or a refusal explaining why one cannot be generated safely. This is
not new drift: it is pre-existing drift the old diff engine silently missed.
On an existing project, the first `migrate dev` after upgrading may be
unexpectedly large — every change class below that the old engine ignored has
been sitting undetected in your schema history.

`migrate dev` now **refuses to write a migration file** whenever a diagnostic
is raised. Previously, the affected change was simply dropped from the
generated SQL and the command succeeded silently. Fix the flagged field/enum
(or accept the remedy the diagnostic names) and re-run.

Pre-existing files already committed under `migrations/` are unaffected: they
carry no new marker, stay fully transactional, and `migrate deploy` applies
them exactly as before.

## Newly-detected changes (previously silent, now emit DDL)

- **`@map` rename.** Changing a field's `@map` while its schema name stays
  the same is an unambiguous physical rename. It now emits
  `ALTER TABLE ... RENAME COLUMN` instead of doing nothing. Any index or
  foreign-key constraint on that column that uses PostgreSQL's
  auto-derived name is realigned (`ALTER INDEX ... RENAME TO`,
  `ALTER TABLE ... RENAME CONSTRAINT`) so a later `DROP` doesn't miss it.
- **Primary key change.** Moving `@id` from one field to another now emits
  `ALTER TABLE ... DROP CONSTRAINT ... ` followed by
  `ALTER TABLE ... ADD PRIMARY KEY (...)`. No data movement.
- **Foreign key referential actions** (`onDelete`/`onUpdate`) and **enum
  `@map`** fixes landed in the previous PR of this change and are included
  here for completeness — see that PR's notes if you didn't see them.

## New refusals (previously silent no-ops, now explained)

- **Ambiguous column rename** (`ambiguous-column-remap`). If a field's name
  AND its `@map` both change in the same edit, the target is genuinely
  ambiguous — the engine cannot tell "rename" from "drop one field, add
  another". Generation refuses with a diagnostic naming both sides.
  **Remedy**: change the field name and the `@map` in two separate
  migrations.
- **Enum value removed** (`enum-value-removed`). PostgreSQL cannot drop a
  value from an enum type without recreating the type, and that recreation's
  `USING` cast fails at migration time if any row still holds the removed
  value — a data-dependent failure that could leave a half-migrated
  database. Generation refuses instead of shipping DDL that might fail
  against production data. **Remedy**: migrate every row off the value by
  hand, then recreate the enum type manually.
- **Required column without a default** (`required-column-without-default`).
  Adding a `NOT NULL` column with no default to a table that already exists
  fails outright against any table holding rows. Generation now refuses
  instead of emitting DDL guaranteed to fail. A brand-new table's own
  `CREATE TABLE` is unaffected — `NOT NULL` columns in a fresh table are
  legitimate. `autoincrement` columns are exempt (`IDENTITY` backfills
  safely). **Remedy**: declare `@default(...)`, or make the field optional
  and backfill it manually.

## Known limitations (honest, not fixed this change)

- **PK rename assumes PostgreSQL's default constraint naming.** The
  `DROP CONSTRAINT` emitted for a primary-key change targets
  `<table>_pkey` — what an inline `PRIMARY KEY (...)` inside `CREATE TABLE`
  produces. A hand-named PK constraint would not be found.
- **Goldens pin generated SQL text, not appliability.** No PostgreSQL runs
  in this test suite or in CI, so "this DDL is correct" means "a human
  reviewed the generated text against PostgreSQL semantics", not "it was
  executed against a real database". Integration testing against real
  PostgreSQL remains a named follow-up.
