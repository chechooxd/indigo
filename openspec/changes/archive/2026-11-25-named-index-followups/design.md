# Design: Named-Index Follow-Ups

## Technical Approach

Resolve `where` and `expression` ONCE in `crates/indigo-compiler` (`ResolvedIndex`), mirror into
`@indigodb/core`, and consume across `@indigodb/migrator`, `@indigodb/generator`, `@indigodb/client`,
and `@indigodb/studio`.

## Architecture Decisions

### Decision 1: `@@index([], expression: "lower(email)", name: "users_lower_email_idx")` (zero parser churn)

| Option | Tradeoff | Decision |
|---|---|---|
| Allow SQL expressions inside `[...]` array syntax | Requires lexer/parser changes for arbitrary SQL call syntax, casts, operators | Rejected |
| Named `expression: "..."` string argument with empty `[]` and mandatory explicit `name: "..."` | Zero parser/AST changes, clean validation boundary, guaranteed deterministic index name for `DROP`/`RENAME`/introspection | **Chosen** |

### Decision 2: `where:` and `expression:` validation in `validate.rs`

- `where:` MUST be a string literal whose trimmed content is non-empty and contains no control chars.
- `expression:` MUST be a string literal whose trimmed content is non-empty and contains no control chars.
- When `expression:` is present: positional array MUST be empty (`[]`) AND `name:` MUST be present.
- When `expression:` is absent: positional array MUST be non-empty (preserving existing behavior).
- `where:` MAY combine with either columns (`@@index([email], where: "deleted_at IS NULL")`) OR
  `expression:` (`@@index([], expression: "lower(email)", where: "deleted_at IS NULL", name: "...")`).

### Decision 3: Partial and expression unique indexes excluded from `uniqueGroups`

In PostgreSQL, `INSERT ... ON CONFLICT ("email") DO UPDATE` fails with `42P10` ("there is no unique
or exclusion constraint matching the ON CONFLICT specification") if the only unique index on
`"email"` is a partial index (`WHERE deleted_at IS NULL`) or an expression index (`(lower(email))`).
`uniqueGroups(table)` in `packages/generator/src/client.ts` therefore skips any index where
`idx.where !== undefined || idx.expression !== undefined`. Those indexes remain visible in
`__meta[Model].indexes` (`delegate.indexes`).

### Decision 4: `ModelDelegate.explain(args)` shares `buildFindManyQuery(args)`

Extract `buildFindManyQuery(args)` from `findManyImpl` so `explain(args)` executes
`EXPLAIN (FORMAT JSON) ${sql}` with the exact same `params.values` through `this.exec`, guaranteeing
zero SQL drift between `findMany` and `explain`. Walk the returned JSON plan tree recursively
(collecting every `Node Type` into `scanTypes` and every `Index Name` into `indexNames`) and derive
`usesIndex = indexNames.length > 0 || scanTypes.some(t => t.includes("Index"))`.

## File Changes

| File | Action |
|---|---|
| `crates/indigo-compiler/src/{rules,ir,validate,resolve}.rs` | Modify |
| `packages/compiler/wasm/*`, `packages/compiler/wasm-sources.sha256` | Rebuild |
| `fixtures/23-partial-expression-indexes.indigo`, `fixtures/24-rejected-partial-expression-indexes.indigo`, `fixtures/snapshots/*` | Add / Update |
| `packages/core/src/{ir,print}.ts` | Modify |
| `packages/migrator/src/{postgres,migrate,introspect}.ts` | Modify |
| `packages/migrator/test/index-ddl.mjs`, `packages/migrator/test/introspect.mjs` | Modify |
| `packages/client/src/{types,delegate}.ts` | Modify |
| `packages/generator/src/client.ts` | Modify |
| `packages/client/test/index-awareness.mjs`, `packages/client/package.json` | Create / Modify |
| `apps/studio/src/features/docs/lib/ddl-generator.ts`, `ddl-generator.test.ts` | Modify |
