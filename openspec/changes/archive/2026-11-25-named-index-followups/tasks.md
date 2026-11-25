# Tasks: Named-Index Follow-Ups

## Phase 1: Rust Compiler + WASM + Core IR & Printer
- [x] 1.1 Update `crates/indigo-compiler/src/{rules,ir,validate,resolve}.rs` with `where` & `expression` support and unit tests (RED -> GREEN).
- [x] 1.2 Add `fixtures/23-partial-expression-indexes.indigo` and `fixtures/24-rejected-partial-expression-indexes.indigo`, run `cd crates && cargo test --locked`, rebuild WASM (`pnpm --filter @indigodb/compiler build:wasm`), regen snapshots (`node packages/compiler/test/regen-snapshots.mjs`), and verify `pnpm --filter @indigodb/compiler test`.
- [x] 1.3 Mirror `where?`/`expression?` in `packages/core/src/ir.ts` and emit them in `packages/core/src/print.ts`.

## Phase 2: Migrator + Studio Docs DDL
- [x] 2.1 Update `packages/migrator/src/{postgres,migrate,introspect}.ts` (DDL rendering, diff identity/definition, introspection of `indpred`/`indexprs` + partial-unique non-folding).
- [x] 2.2 Add RED->GREEN tests in `packages/migrator/test/index-ddl.mjs` and `packages/migrator/test/introspect.mjs` (real PGlite push + diff + introspect round-trip).
- [x] 2.3 Update `apps/studio/src/features/docs/lib/ddl-generator.ts` and `ddl-generator.test.ts` to render `expression` and `WHERE` clauses.

## Phase 3: Generator & Client Index-Awareness
- [x] 3.1 Add `IndexMeta` and `ExplainResult` to `packages/client/src/types.ts` (optional `indexes?` on `ModelMeta` so existing hand-authored delegates stay compatible).
- [x] 3.2 Update `packages/generator/src/client.ts` to emit `indexes` in `__meta` and exclude partial/expression unique indexes from `uniqueGroups`.
- [x] 3.3 Extract `buildFindManyQuery` in `packages/client/src/delegate.ts`, expose `readonly indexes` and `explain(args?)`.
- [x] 3.4 Add `packages/client/test/index-awareness.mjs` (wired into `packages/client/package.json`) testing `__meta.indexes`, `uniqueGroups` exclusion, and live PGlite `explain()` (including mutation proof).

## Phase 4: Verify, Archive, Merge
- [x] 4.1 Run compiler, core, migrator, generator, client, and Studio tests + `pnpm build && pnpm lint`.
- [x] 4.2 Write `verify-report.md` and `archive-report.md`, merge canonical specs, archive, fast-forward `main`, delete branch, and save to Engram.
