# Archive Report: named-index-followups

**Date Archived**: 2026-11-25
**Branch**: `named-index-followups`
**Verdict**: PASS — 3/3 requirements, full stack Rust/WASM -> Core -> Migrator -> Generator -> Client -> Studio verified

## Summary

Completed both follow-ups from `named-typed-indexes`:
1. **Partial (`where:`) and expression (`expression:`) indexes** across the Rust compiler +
   committed WASM artifact, `@indigodb/core` IR + printer, `@indigodb/migrator` DDL rendering,
   diffing, and live PostgreSQL catalog introspection (`pg_get_expr(indpred/indexprs)`), and
   `@indigodb/studio` docs DDL display.
2. **Client-side index awareness** in `@indigodb/generator` + `@indigodb/client`: structured
   `__meta[Model].indexes` (`delegate.indexes`), exclusion of partial/expression unique indexes
   from `uniqueGroups` / `<Model>WhereUniqueInput` (preventing invalid PostgreSQL `ON CONFLICT`
   targets), and `ModelDelegate.explain(args?)` running `EXPLAIN (FORMAT JSON)` over the exact
   parameterized `findMany` SQL.

## Spec Merge

- NEW canonical spec: `openspec/specs/named-index-followups/spec.md` (3 requirements, 6 scenarios).
- MODIFIED canonical spec: `openspec/specs/db-pull-command/spec.md` (updated expression-index
  requirement with `(Previously: ...)` note).
