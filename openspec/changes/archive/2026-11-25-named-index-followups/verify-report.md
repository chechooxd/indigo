# Verify Report: named-index-followups

**Date**: 2026-11-25
**Branch**: `named-index-followups`
**Verdict**: PASS — archive-ready

## Task Completion

All tasks across Phases 1-4 complete (`tasks.md`).

## Verification Evidence

- **Rust compiler**: `cd crates && cargo test --locked` → **107/107 passed**.
- **WASM artifact & golden parity**: `pnpm --filter @indigodb/compiler build:wasm` rebuilt
  `packages/compiler/wasm/` + `wasm-sources.sha256`; `regen-snapshots.mjs` added snapshots 23 &
  24 and updated only the expected `Known arguments: name, type, where, expression.` lines in
  fixtures 17 & 21 (all other fixtures 01-16, 18-20, 22 byte-identical);
  `pnpm --filter @indigodb/compiler test` → **all green** (`wasm-freshness` + 24/24 parity +
  3 error fixtures + spans).
- **Core IR & printer**: `pnpm --filter @indigodb/core test` → **all green** (including
  round-trip of `23-partial-expression-indexes.indigo` and `24-rejected-partial-expression-indexes.indigo`).
- **Migrator**: `pnpm --filter @indigodb/migrator test` → **all 11 suites green** (47 golden
  fixtures, `index-ddl.mjs` including partial/expression DDL, diff on `where`/`expression`,
  `printSchema`, and real PGlite push + introspect round-trip proving partial unique indexes are
  never folded into `col.unique`, plus `appliability`, `replay`, `introspect`, `shadow`,
  `pull-roundtrip`).
- **Generator**: `pnpm --filter @indigodb/generator test` → **all 8 suites green** (including
  new `index-emission.mjs`: `uniqueGroups` + `<Model>WhereUniqueInput` exclude partial/expression
  uniques; `__meta[Model].indexes` emits all declared indexes with schema field names).
- **Client**: `index-awareness.mjs` (live PGlite `EXPLAIN (FORMAT JSON)` proving both `Seq Scan`
  with `usesIndex: false` and `account_email_idx` with `usesIndex: true`), `typecheck.mjs`, and
  `upsert.mjs` → **all green**.
- **Studio**: `ddl-generator.test.ts` → **14/14 passed** (including partial and expression index
  DDL display).
- **Workspace build & lint**: `pnpm build && pnpm lint` → **exit 0** (11/11 build, 21/21 lint).
