# Schema Printing Specification

## Purpose

Deterministic emission of `.indigo` source text from a `ResolvedSchema` IR — the inverse
direction of `parse`. Enables round-tripping (`resolve(parse(print(ir))) == ir`) for the
in-scope IR subset and underpins `db pull`.

## Requirements

### Requirement: Deterministic Text Emission

The printer MUST be a pure function `print(resolved: ResolvedSchema): string` with no I/O,
producing byte-identical output for identical input on repeated calls.

#### Scenario: Same IR prints identical text twice
- GIVEN a `ResolvedSchema` IR value `ir`
- WHEN `print(ir)` is called twice
- THEN both calls return byte-identical strings

### Requirement: Round-Trip Fidelity for In-Scope IR

For any `ResolvedSchema` built only from in-scope constructs (models, scalar/enum fields,
nullability, defaults, native-type overrides, `@id`, `@unique`, `@@index`, `@@unique`,
composite primary keys, `@@realtime`, raw foreign-key constraints), the system MUST satisfy
`resolve(parse(print(ir))) == ir`.

#### Scenario: Round-trip equality holds
- GIVEN a `ResolvedSchema` `ir` using only in-scope constructs
- WHEN the system computes `resolve(parse(print(ir)))`
- THEN the result is deeply equal to `ir`

### Requirement: Table and Column Printing

The printer MUST emit one `model` block per table, with one field line per column including
its scalar type, nullability marker, `@default(...)` when present, and a native-type
attribute (`@db.X`) when the column declares a native-type override.

#### Scenario: Column with default and native type
- GIVEN a resolved column with type `Decimal`, a default value, and native type `Numeric(10,2)`
- WHEN the schema is printed
- THEN the emitted field line includes the scalar type, `@default(...)`, and `@db.Numeric(10, 2)`

#### Scenario: Nullable column
- GIVEN a resolved column marked nullable
- WHEN the schema is printed
- THEN the field type is suffixed with `?`

### Requirement: Identity Attribute Printing

The printer MUST emit `@id` on single-column primary keys and `@unique` on columns marked
unique, and MUST emit a `@@id([...])` block-level attribute for composite primary keys.

#### Scenario: Single-column primary key
- GIVEN a table with a single-column primary key
- WHEN the schema is printed
- THEN the corresponding field carries `@id`

#### Scenario: Composite primary key
- GIVEN a table with a two-column primary key
- WHEN the schema is printed
- THEN the model emits `@@id([col1, col2])` and neither column carries `@id` individually

### Requirement: Enum Printing With Member Mapping

The printer MUST emit one `enum` block per resolved enum, and MUST emit `@map("...")` on
enum members whose resolved database value differs from the printed member identifier.

#### Scenario: Enum member requiring @map
- GIVEN a resolved enum with a member whose database value differs from its identifier
- WHEN the schema is printed
- THEN that member line includes `@map("<db-value>")`

#### Scenario: Enum member not requiring @map
- GIVEN a resolved enum member whose database value equals its identifier
- WHEN the schema is printed
- THEN that member line omits `@map(...)`

### Requirement: Index Printing With Name and Type Arguments

The printer MUST emit `@@index([...])` and `@@unique([...])` block attributes, including
`name: "..."` when the index has a non-default name and `type: ...` when the index type is
not the implicit default.

#### Scenario: Named typed index
- GIVEN a resolved index with an explicit name and a non-default index type
- WHEN the schema is printed
- THEN the emitted `@@index([...])` includes both `name: "..."` and `type: ...` arguments

### Requirement: @@realtime Printing

The printer MUST emit `@@realtime` on models resolved with realtime enabled.

#### Scenario: Realtime model
- GIVEN a resolved table with `@@realtime` enabled
- WHEN the schema is printed
- THEN the emitted model block includes `@@realtime`

### Requirement: Raw Foreign Key Output (No Relation Synthesis)

The printer MUST emit foreign-key-backed columns as plain scalar columns carrying their FK
constraint data in structural/comment form, and MUST NOT synthesize `@relation(...)` fields,
infer relation field names, or infer cardinality. This is documented, intended behavior for
this change, not a gap.

#### Scenario: Table with a foreign key prints as raw FK, not a relation field
- GIVEN a resolved table with a column carrying a foreign-key constraint to another table
- WHEN the schema is printed
- THEN the output contains that column as a plain scalar field with its FK constraint data captured
- AND the output does NOT contain a synthesized `@relation(...)` field for that foreign key
- AND the absence of relation-field synthesis is documented as expected behavior for this change, not a defect to silently fix

### Requirement: Loud Failure on Unmappable Constructs

The printer MUST throw a clear, actionable error rather than emit partial or best-guess
output when given IR containing constructs it cannot represent losslessly.

#### Scenario: Unsupported construct in IR
- GIVEN a `ResolvedSchema` containing a construct the printer cannot represent
- WHEN `print` is called
- THEN the system throws an error identifying the offending construct
- AND no partial `.indigo` text is returned
