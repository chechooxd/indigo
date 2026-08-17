# Index Hints Specification

## Purpose

Defines the ability to declare an explicit index name and a Postgres index
access method (`btree`, `gin`, `gist`, `hash`) on `@@index`/`@@unique` model
attributes, and the DDL the migrator MUST produce for them. Today `ResolvedIndex.name`
is always `None` (resolve.rs documents names as "never emitted"; auto-derived
as `${table}_${cols}_idx`) and no method can be selected, so GIN/GIST
workloads are unreachable from the schema language.

## Requirements

### Requirement: `@@index`/`@@unique` accept an explicit index name

The compiler MUST accept an optional named argument `name: "<literal>"` on
`@@index`/`@@unique`, and MUST resolve it into `ResolvedIndex.name`. When
`name` is omitted, the system MUST fall back to today's auto-derived name
(`${table}_${cols}_idx`), unchanged.

#### Scenario: Explicit name is honoured

- GIVEN `@@index([a, b], name: "custom_idx")`
- WHEN the schema is resolved
- THEN `ResolvedIndex.name` is `"custom_idx"`

#### Scenario: Omitted name keeps today's derivation

- GIVEN `@@index([a, b])` with no `name` argument
- WHEN the schema is resolved
- THEN `ResolvedIndex.name` matches the current auto-derived value, identical to pre-change behavior

### Requirement: `@@index`/`@@unique` accept an explicit index method

The compiler MUST accept an optional named argument `type: <method>` on
`@@index`/`@@unique`, where `<method>` is a bare (unquoted) lowercase
identifier from the closed set `btree`, `gin`, `gist`, `hash`. The resolved
value MUST be exposed on the IR (`ResolvedIndex.type`) as lowercase
SQL-ready text. When `type` is omitted, the system MUST behave as `btree`
(today's implicit default).

#### Scenario: Explicit method is honoured

- GIVEN `@@index([tags], type: gin)`
- WHEN the schema is resolved
- THEN `ResolvedIndex.type` is `"gin"`

#### Scenario: Omitted type defaults to btree

- GIVEN `@@index([a])` with no `type` argument
- WHEN the schema is resolved
- THEN `ResolvedIndex.type` is `"btree"` and the produced DDL is unchanged from before this change

### Requirement: DDL emits the explicit name and index method

Both `db push` (idempotent DDL) and `migrate dev`/`deploy` (versioned DDL)
MUST emit `CREATE INDEX <name> ... USING <method> (...)` (or the `UNIQUE`
variant for `@@unique`) using the resolved name and method, for any index
that declares `name` and/or `type`.

#### Scenario: Push DDL includes explicit name and method

- GIVEN a model with `@@index([tags], name: "tags_gin_idx", type: gin)`
- WHEN `db push` DDL is rendered
- THEN the emitted statement is `CREATE INDEX IF NOT EXISTS "tags_gin_idx" ... USING gin (...)` (or the guarded push-idempotent equivalent)

#### Scenario: Migration DDL includes explicit name and method

- GIVEN the same model is diffed against an empty previous schema
- WHEN a migration is generated
- THEN the emitted `CREATE INDEX` statement uses `"tags_gin_idx"` and `USING gin`

### Requirement: Omitting name and type reproduces today's DDL byte-for-byte

For any index with neither `name` nor `type` declared, the compiled IR and
the emitted DDL (push and migration) MUST be byte-identical to the DDL
produced before this change shipped.

#### Scenario: Backward-compatible default

- GIVEN a pre-existing fixture using only `@@index([a, b])` or `@@unique([a, b])` with no new arguments
- WHEN it is resolved and DDL is rendered
- THEN the resolved IR and emitted DDL text are unchanged from before this change
