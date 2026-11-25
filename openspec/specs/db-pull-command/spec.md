# db pull Command Specification

## Purpose

CLI command surface (`indigodb db pull`) that introspects a live Postgres database and writes
a printed `.indigo` schema file, without requiring a pre-existing schema file.

## Requirements

### Requirement: Connection Resolution Without a Pre-Existing Schema File

The command MUST resolve a database connection string from an explicit `--url` flag when
provided, or otherwise from `DATABASE_URL` loaded from `.env`, without requiring any existing
`schema.indigo` file to be present.

#### Scenario: --url flag provided
- GIVEN no `schema.indigo` file exists in the working directory
- WHEN the user runs `db pull --url <dsn>`
- THEN the command connects using `<dsn>` without erroring on a missing schema file

#### Scenario: DATABASE_URL from .env
- GIVEN no `--url` flag is passed and `.env` defines `DATABASE_URL`
- WHEN the user runs `db pull`
- THEN the command connects using the `.env`-sourced `DATABASE_URL`

#### Scenario: No connection source available
- GIVEN no `--url` flag is passed and no `DATABASE_URL` is resolvable
- WHEN the user runs `db pull`
- THEN the command fails with a clear, actionable error naming the missing connection input

### Requirement: Introspect and Print

The command MUST introspect the target database via `introspectResolvedSchema`, print the
resulting IR via the schema printer, and produce `.indigo` text that both parses and resolves
successfully.

#### Scenario: db pull output is valid .indigo
- GIVEN a reachable Postgres database with an in-scope schema
- WHEN the user runs `db pull --url <dsn>`
- THEN the written file's contents, when parsed and resolved, succeed without error

### Requirement: Output Path Resolution

The command MUST write the printed schema to `schema.indigo` in the working directory by
default, or to the path given by `--schema` when provided.

#### Scenario: Default output path
- GIVEN no `--schema` flag is passed
- WHEN the user runs `db pull --url <dsn>`
- THEN the printed schema is written to `./schema.indigo`

#### Scenario: Custom output path
- GIVEN `--schema custom/path.indigo` is passed
- WHEN the user runs `db pull --url <dsn> --schema custom/path.indigo`
- THEN the printed schema is written to `custom/path.indigo`

### Requirement: Overwrite Existing Schema File By Default

The command MUST overwrite an existing schema file at the resolved target path by default,
with no confirmation prompt and no `--force` flag required in this slice.

#### Scenario: Existing schema.indigo is overwritten silently
- GIVEN a `schema.indigo` file already exists at the target path with different content
- WHEN the user runs `db pull --url <dsn>` targeting that same path
- THEN the command overwrites the existing file with the newly introspected and printed schema
- AND no confirmation prompt is shown
- AND no `--force` or equivalent flag is required for the overwrite to proceed

### Requirement: Loud Failure on Unmappable Types; Partial and Expression Indexes Introspected

The command MUST fail loudly and never emit a silent partial schema when the underlying
introspection encounters an unmappable PostgreSQL type, inheriting the "throw, never guess"
invariant of `introspectResolvedSchema`. Partial (`where:`) and expression (`expression:`)
indexes MUST be introspected and printed instead of rejected.
(Previously: expression indexes threw an error because `expression:` was not yet supported in
the `.indigo` schema language.)

#### Scenario: Unmappable column type
- GIVEN a target database containing a column of a PostgreSQL type the introspector cannot map
- WHEN the user runs `db pull --url <dsn>`
- THEN the command fails with a clear, actionable error identifying the unmappable type and its location
- AND no schema file is written or an existing one is left unmodified

#### Scenario: Partial and expression indexes present
- GIVEN a target database containing a partial index and an expression index
- WHEN the user runs `db pull --url <dsn>`
- THEN both indexes are introspected with `where` / `expression` populated and printed as valid
  `@@index` / `@@unique` attributes in `.indigo`

### Requirement: Relation-Field Synthesis Out of Scope

The command MUST NOT synthesize `@relation(...)` fields, relation field names, or cardinality
during `db pull`; this is a named follow-up, not a silent omission.

#### Scenario: Pulled schema has no synthesized relations
- GIVEN a target database with foreign-key-backed columns
- WHEN the user runs `db pull --url <dsn>`
- THEN the written schema contains raw FK columns per the schema-printing spec
- AND the written schema contains no synthesized `@relation(...)` fields
- AND this limitation is documented as a named follow-up for a future change
