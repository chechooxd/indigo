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
nullability, defaults, native-type overrides, `@id`, `@unique`, `@@index`, `@@unique`, composite
primary keys, `@@realtime` with or without `columns`, `@@allow`, `TableGroup` blocks, relation
fields backed by relation metadata, and raw foreign-key constraints with no relation metadata),
the system MUST satisfy `resolve(parse(print(ir))) == ir` when compared against the full IR,
excluding only differences named in this requirement. Every excluded field MUST be justified with
an inline code comment in the comparison logic naming the field and the reason it is
unrepresentable, and any exclusion beyond the one named below MUST be reported in the change's
verify report.
(Previously: asserted round-trip equality without defining "in-scope subset" or naming any
exclusion; the reference implementation's comparison silently zeroed `foreignKeys`, `relations`,
`tableGroups`, `color`, `group`, `allow`, and `realtimeColumns` on both sides before comparing.)

#### Scenario: Round-trip equality holds over the full IR

- GIVEN a `ResolvedSchema` `ir` using only in-scope constructs, including populated `relations`,
  `allow`, `tableGroups`, and `realtimeColumns` (including an empty array)
- WHEN the system computes `resolve(parse(print(ir)))`
- THEN the result is deeply equal to `ir`, with no field deleted or zeroed before comparison,
  except the one named index-ordering exclusion below

#### Scenario: The one permitted exclusion is index re-bucketing, and it is documented

- GIVEN the round-trip comparison encounters `@@index`/`@@unique` entries that the printer emits
  grouped by `unique: true` before `unique: false` (each group preserving original relative order)
- WHEN the comparison normalizes index order before comparing
- THEN the comparison logic carries an inline comment naming the field (`indexes`) and the reason
  (fixed emission-order grouping is not a data loss)
- AND no other field is normalized away before comparison

#### Scenario: A deleted normalization exclusion fails the suite

- GIVEN the round-trip comparison in its current, fully-restored form (no `foreignKeys`,
  `relations`, `tableGroups`, `color`, `group`, `allow`, or `realtimeColumns` exclusion remains
  beyond index re-bucketing)
- WHEN any single one of those fields differs between the original and re-resolved IR because the
  printer failed to emit it
- THEN the round-trip test fails, demonstrating the printer's guarantee is falsifiable

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

The printer MUST emit `@@realtime` on models resolved with realtime enabled and no column
allowlist, and MUST emit `@@realtime(columns: [...])` when `realtimeColumns` is defined,
including when it is an empty array.
(Previously: emitted only bare `@@realtime`, with no column-allowlist form.)

#### Scenario: Realtime model without column allowlist

- GIVEN a resolved table with `table.realtime` true and `realtimeColumns` undefined
- WHEN the schema is printed
- THEN the emitted model block includes bare `@@realtime`

#### Scenario: Realtime model with a non-empty column allowlist

- GIVEN a resolved table with `realtimeColumns: ["id", "status"]`
- WHEN the schema is printed
- THEN the emitted model block includes `@@realtime(columns: [id, status])`

#### Scenario: Realtime model with an empty column allowlist prints the empty list, not bare `@@realtime`

- GIVEN a resolved table with `realtimeColumns: []`
- WHEN the schema is printed
- THEN the emitted model block includes `@@realtime(columns: [])`
- AND re-resolving the printed text yields `realtimeColumns: []`, not `undefined`

### Requirement: Raw Foreign Key Output (No Relation Synthesis)

The printer MUST emit `@relation(...)` for a relation field whenever the IR carries relation
metadata (`ResolvedTable.relations` is populated), and MUST emit a foreign key with no matching
relation metadata as a plain scalar column carrying its FK constraint data in comment form
(`// @fk(...)`) — it MUST NOT synthesize a relation field name, infer cardinality, or guess a
counterpart for FK-only metadata. This dual behavior is documented, intended behavior, not a gap:
the `// @fk(...)` fallback remains the correct and only representation for introspected
(`db pull`) schemas, which resolve with `relations: []` by design, until a future
`db-pull-relation-synthesis` change adds field-name synthesis for that path.
(Previously: unconditionally forbade `@relation(...)` output and always emitted the `// @fk(...)`
comment form for every foreign key, with no relation-metadata branch.)

#### Scenario: FK-holding relation field prints `@relation(...)`

- GIVEN a resolved table with a relation field whose `fkColumns` is non-empty, paired with its
  target model, `refColumns`, and optionally `relationName`
- WHEN the schema is printed
- THEN the field line emits `@relation(fields: [...], references: [...])`, including
  `"relationName"` as the first positional argument when `relationName` is present
- AND `onDelete`/`onUpdate` arguments are included when the cross-referenced `ForeignKey` carries them

#### Scenario: Inverse relation field prints without `fields`/`references`

- GIVEN a resolved table with a relation field whose `fkColumns` is empty (the inverse/back-reference side)
- WHEN the schema is printed
- THEN the field line emits the target type with list/optional suffix as applicable
- AND emits `@relation("...")` only when `relationName` is present; otherwise no `@relation(...)` clause is emitted

#### Scenario: Relation-free FK metadata still prints `// @fk(...)` (the `db pull` shape)

- GIVEN a resolved table with `foreignKeys` populated and `relations` empty or absent (introspection shape)
- WHEN the schema is printed
- THEN the corresponding column prints as a plain scalar field with its FK constraint data in
  `// @fk(...)` comment form
- AND the output does NOT contain a synthesized `@relation(...)` field for that foreign key

#### Scenario: Ambiguous FK-to-relation cross-reference throws

- GIVEN a resolved table with two relation fields whose `fkColumns` are identical column sets
  targeting the same table, such that `onDelete`/`onUpdate` cannot be attributed to a single
  `ForeignKey` unambiguously
- WHEN the schema is printed
- THEN the system throws `IndigoPrintError` naming the table and the ambiguous column set
- AND no partial `.indigo` text is returned, and no first-match is silently picked

### Requirement: Loud Failure on Unmappable Constructs

The printer MUST throw a clear, actionable error rather than emit partial or best-guess
output when given IR containing constructs it cannot represent losslessly.

#### Scenario: Unsupported construct in IR
- GIVEN a `ResolvedSchema` containing a construct the printer cannot represent
- WHEN `print` is called
- THEN the system throws an error identifying the offending construct
- AND no partial `.indigo` text is returned

### Requirement: @@allow Printing

The printer MUST emit one `@@allow(action, left == right)` block-level attribute line per
resolved `AllowRule`, in IR order, never re-collapsing the expanded `write`/`all` action sugar
back into an alias. Each operand MUST print as `this.<fieldName>` for a `{kind: "field"}`
operand, using the schema field name (not the physical `dbName`), or `auth.<name>` for a
`{kind: "claim"}` operand. The comparison operator MUST print as `==`.

#### Scenario: Multiple allow rules print as separate lines in IR order

- GIVEN a resolved table with two `AllowRule` entries under the `read` action, in a specific order
- WHEN the schema is printed
- THEN the model block emits two `@@allow(read, ...)` lines, in the same order as the IR

#### Scenario: Field operand prints the schema field name, not the mapped column name

- GIVEN a resolved table with an `AllowRule` whose field operand refers to a field mapped via
  `@map` to a different physical column name
- WHEN the schema is printed
- THEN the emitted operand is `this.<schemaFieldName>`, not `this.<dbName>`

#### Scenario: Claim operand prints as `auth.<name>`

- GIVEN a resolved table with an `AllowRule` whose operand is `{kind: "claim", name: "userId"}`
- WHEN the schema is printed
- THEN the emitted operand is `auth.userId`

#### Scenario: `write`/`all` sugar is never re-collapsed

- GIVEN a resolved table whose `allow.create`, `allow.update`, and `allow.delete` all carry an
  identical rule that originated from a single authored `@@allow(write, ...)`
- WHEN the schema is printed
- THEN the output emits three separate `@@allow(create, ...)`, `@@allow(update, ...)`,
  `@@allow(delete, ...)` lines, not one collapsed `@@allow(write, ...)` line

### Requirement: TableGroup Printing

The printer MUST emit one `TableGroup "<name>" { color = "<color>" <table> ... }` block per
entry in `ResolvedSchema.tableGroups`, printed verbatim from that array — not derived from
`table.color`/`table.group` — after all `model`/`enum` blocks, preserving IR order including any
group-membership overlap the array carries.

#### Scenario: TableGroup blocks print after model/enum blocks

- GIVEN a `ResolvedSchema` with one non-empty `tableGroups` entry
- WHEN the schema is printed
- THEN the printed text contains a `TableGroup "..." { ... }` block after all `model`/`enum` blocks

#### Scenario: "Last group wins" overlap round-trips faithfully

- GIVEN a `ResolvedSchema.tableGroups` where the same table name appears listed under two
  declared groups (mirroring the declared source verbatim, not deduplicated to final ownership)
- WHEN the schema is printed and re-resolved
- THEN the re-resolved `tableGroups` array is identical to the original
- AND every table's derived `color`/`group` on the re-resolved IR matches the original

#### Scenario: TableGroup source, not derived fields, drives printing

- GIVEN a `ResolvedSchema` where `table.color`/`table.group` were hand-set to values inconsistent
  with `tableGroups`
- WHEN the schema is printed
- THEN the printed `TableGroup` blocks reflect `tableGroups`, not the inconsistent derived fields
