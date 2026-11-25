# Proposal: Named-Index Follow-Ups (Partial/Expression Indexes + Client Index Awareness)

## Intent

`named-typed-indexes` (`2026-08-17`) shipped explicit index names (`name:`) and access methods
(`type: btree|gin|gist|hash`) on `@@index`/`@@unique`, naming two follow-up items on the roadmap:
(1) **partial and expression indexes** (`where:` and `expression:`) across the compiler, IR,
migrator, introspection, printer, and Studio docs DDL, and (2) **client-side index awareness**
(`__meta.indexes`, excluding partial/expression unique indexes from unconditional `upsert`
conflict targets, and `delegate.explain(args)` over real PostgreSQL `EXPLAIN (FORMAT JSON)`).

## Scope

### In Scope
- **Compiler (`crates/indigo-compiler`) + WASM rebuild (`packages/compiler/wasm/`)**:
  - Extend `INDEX_ARG_KEYS` with `where` and `expression`.
  - Validate `where:` (non-empty string literal, no control chars), `expression:` (non-empty string
    literal, no control chars; requires empty column array `[]` and explicit `name:`), and require
    non-empty column array when `expression:` is absent.
  - Add optional `where` and `expression` fields to `ResolvedIndex` (declared after `type`,
    omitted when `None` so existing fixtures 01-16, 18-22 stay byte-identical; fixture 17's
    `Known arguments` diagnostic intentionally updates to list `name, type, where, expression`).
  - Add fixtures `23-partial-expression-indexes.indigo` and `24-rejected-partial-expression-indexes.indigo`.
- **Core (`@indigodb/core`)**: mirror `where?` and `expression?` on `ResolvedIndex` and print
  them in `printIndexAttr` (`print.ts`).
- **Migrator (`@indigodb/migrator`)**:
  - `renderIndexDdl`: render `(${index.expression})` when `expression` is set, and
    ` WHERE ${index.where}` when `where` is set.
  - `migrate.ts`: include `expression` in `indexKey`/`indexShape` and `where` in `indexDefinition`
    so predicate or expression changes emit `DROP INDEX` + `CREATE INDEX` and renames emit
    `ALTER INDEX RENAME`.
  - `introspect.ts`: introspect `pg_get_expr(ix.indpred, ix.indrelid)` into `where` and
    `pg_get_expr(ix.indexprs, ix.indrelid)` into `expression` (instead of throwing on expression
    indexes); never fold a partial unique index into `col.unique = true`.
- **Generator (`@indigodb/generator`) & Client (`@indigodb/client`)**:
  - Exclude partial (`where`) and expression (`expression`) unique indexes from `uniqueGroups` /
    `<Model>WhereUniqueInput` (PostgreSQL rejects unconditional `ON CONFLICT (cols)` targeting a
    partial/expression unique index).
  - Emit structured `indexes: readonly IndexMeta[]` on `__meta[Model]` (field names translated
    from physical `dbName`, plus `unique`, `name?`, `type?`, `where?`, `expression?`).
  - Expose `delegate.indexes` (`readonly IndexMeta[]`) and `delegate.explain(args?)` (runs
    `EXPLAIN (FORMAT JSON)` on the exact parameterized `findMany` SQL and returns
    `{ sql, params, usesIndex, indexNames, scanTypes, totalCost, plan }`).
- **Studio (`@indigodb/studio`)**: render `expression` and `WHERE` in `generateTableDDL`.

### Out of Scope
- Per-column sort direction (`ASC`/`DESC`) or operator classes (`jsonb_path_ops`).
- `@@fulltext` indexes.
- Parsing/validating raw SQL syntax inside `where:`/`expression:` in Rust (PostgreSQL validates
  it on apply/shadow replay).

## Capabilities

### New Capabilities
- `named-index-followups`: partial (`where:`) and expression (`expression:`) indexes end-to-end
  plus client-side index metadata and `explain()`.

### Modified Capabilities
- `index-hints`: adds `where:` and `expression:` arguments.
- `attribute-validation`: extends `INDEX_ARG_KEYS` and adds `where:`/`expression:` validation rules.
- `migration-diff-completeness`: extends index identity/definition to cover `where` and `expression`.
- `db-pull-command`: introspection now supports expression and partial indexes instead of failing.

## Crates / WASM Note

Touches `crates/indigo-compiler/`. Requires `cd crates && cargo test --locked`,
`pnpm --filter @indigodb/compiler build:wasm`, committing `packages/compiler/wasm/` +
`packages/compiler/wasm-sources.sha256`, regenerating golden snapshots, and running
`@indigodb/compiler` tests.

## Rollback Plan

Revert branch commits and rebuild WASM (`build:wasm`). All new IR fields are optional and omitted
when absent.
