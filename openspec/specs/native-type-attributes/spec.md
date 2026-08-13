# Native Type Attributes Specification

## Purpose

Defines the namespaced `@db.X(...)` attribute syntax that lets `.indigo` authors
override the physical Postgres column type the compiler would otherwise derive
from the logical scalar (e.g. `String` → `text`). Covers lexing/parsing, the
AST representation, and the resolved IR shape consumed by the migrator.
Validation rules (whitelist admission, scalar compatibility) live in
`attribute-validation`; DDL emission lives in `migration-ddl-ordering`.

## Requirements

### Requirement: Namespaced attribute syntax parses

The parser MUST accept an attribute name of the form `identifier (Dot identifier)?`,
where the first identifier is the namespace (e.g. `db`) and the second is the
native type name (e.g. `VarChar`), optionally followed by a parenthesized
argument list. Non-namespaced attributes (`@unique`, `@map`, `@@map`, etc.)
MUST continue to parse exactly as before this change, byte-identical in the
resulting AST for those attributes.

#### Scenario: Namespaced attribute with arguments

- GIVEN a field declaration `bio String @db.VarChar(255)`
- WHEN the schema is parsed
- THEN the resulting `Attribute` has name `"VarChar"`, namespace `"db"`, and one positional argument `255`

#### Scenario: Namespaced attribute without arguments

- GIVEN a field declaration `id String @db.Uuid`
- WHEN the schema is parsed
- THEN the resulting `Attribute` has name `"Uuid"`, namespace `"db"`, and no arguments

#### Scenario: Non-namespaced attribute is unaffected

- GIVEN a field declaration `email String @unique`
- WHEN the schema is parsed
- THEN the resulting `Attribute` has name `"unique"` and namespace `None`, matching pre-change parsing exactly

### Requirement: AST namespace representation stays additive

The `Attribute` AST node MUST carry an explicit `namespace: Option<String>`
field rather than a compound string (e.g. not `"db.VarChar"`). The field MUST
serialize with `skip_serializing_if = "Option::is_none"` so that any AST
without a namespaced attribute produces a JSON payload with no `namespace`
key, preserving byte-identical golden snapshots for every fixture that
predates this change.

#### Scenario: Existing fixtures serialize unchanged

- GIVEN any pre-existing fixture that contains no `@db.X` attribute
- WHEN its AST is serialized to the golden snapshot format
- THEN the snapshot bytes are identical to the pre-change snapshot, with no `namespace` key present anywhere

#### Scenario: New fixture serializes the namespace key

- GIVEN a fixture containing `@db.VarChar(255)`
- WHEN its AST is serialized
- THEN the corresponding `Attribute` entry includes `"namespace": "db"`

### Requirement: Resolved IR exposes a structured native type

`ResolvedColumn` (in `ir.rs` and its `packages/core/src/ir.ts` mirror) MUST
gain an optional `nativeType` field shaped as `{ name: string, args: string[] }`
(e.g. `{ name: "VarChar", args: ["255"] }`), populated only when the field
carries a `@db.X` attribute that passed validation. Columns without a native
type override MUST omit this field (or resolve it to `undefined`/absent, not
`null`), keeping the field-level IR additive.

#### Scenario: Resolving a field with a native type override

- GIVEN a field `bio String @db.VarChar(255)`
- WHEN the schema is resolved
- THEN the corresponding `ResolvedColumn.nativeType` is `{ name: "VarChar", args: ["255"] }`

#### Scenario: Resolving a field without a native type override

- GIVEN a field `name String`
- WHEN the schema is resolved
- THEN the corresponding `ResolvedColumn.nativeType` is absent
</content>
</invoke>
