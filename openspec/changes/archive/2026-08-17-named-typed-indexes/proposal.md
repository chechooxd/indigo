# Proposal: Named and Typed Indexes

## Intent

`@@index`/`@@unique` accept exactly one positional field array today (`rules.rs` `ArgShape::OneReferenceArray`). `ResolvedIndex.name` is always `None` — `resolve.rs:7` documents that index names are "never emitted", so every index name is auto-derived (`${table}_${cols}_idx`). Users cannot name an index to match an existing database, and cannot select a Postgres index method, so GIN/GIST workloads (JSON, text search, geometry) are unreachable from the schema language. This is the first Phase 3 change ("Query performance and indexing hints") and the smallest slice that makes indexing intentional rather than implicit.

## Scope

### In Scope
- `@@index`/`@@unique` accept named args: `name: "..."` (explicit index name) and `type: <method>`.
- `type` is a closed enum: `btree | gin | gist | hash`, `btree` as default/omitted.
- Grammar (`rules.rs`) → `resolve.rs` → IR (`ir.rs` + `packages/core/src/ir.ts`: `ResolvedIndex.type`, honoured `name`).
- Migrator: `postgres.ts` push DDL and `migrate.ts` versioned diff emit `USING <method>` and the explicit name; `indexSignature` MUST include `name` and `type` so a type-only or name-only change diffs as drop+recreate/rename.
- Validation: unknown `type`, duplicate/conflicting explicit index names within a table, invalid name literal, `name`/`type` on unsupported targets.
- Fixture corpus additions (accepted + rejected), `build:wasm` rebuild, golden snapshot regen.

### Out of Scope (follow-up Phase 3 changes)
- Partial/expression indexes (`where:` predicates) and per-column sort direction.
- `@@fulltext`.
- Studio index surfacing, including the pre-existing `apps/studio/src/features/docs/lib/ddl-generator.ts` hardcoded-`id`-index bug.
- Any client-side query-plan, EXPLAIN, or index-awareness work.

## Capabilities

### New Capabilities
- `index-hints`: declaring explicit index names and Postgres index methods on `@@index`/`@@unique`, and the DDL they produce.

### Modified Capabilities
- `attribute-validation`: model-attribute whitelist gains named args (`name`, `type`) on `@@index`/`@@unique`, with `type` restricted to a closed method enum.
- `migration-diff-completeness`: index diffing MUST detect name-only and method-only changes instead of treating them as unchanged.

## Approach

Mirror the proven `native-type-attributes` pattern: extend the attribute grammar with a bounded named-arg shape, validate against a small closed set, resolve once into the IR, and let the migrator read the IR. No new AST shape is needed — `AttributeArg.name` already carries named args. `type` is resolved to lowercase SQL-ready text in the compiler (same "compiler owns SQL-readiness" rule as `ForeignKey.onDelete`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `crates/indigo-compiler/src/rules.rs` | Modified | Named-arg shape for `@@index`/`@@unique` |
| `crates/indigo-compiler/src/resolve.rs` | Modified | `resolve_indexes` reads `name`/`type` |
| `crates/indigo-compiler/src/validate.rs` | Modified | Method enum + name uniqueness diagnostics |
| `crates/indigo-compiler/src/ir.rs`, `packages/core/src/ir.ts` | Modified | `ResolvedIndex.type`, `name` now populated |
| `packages/migrator/src/postgres.ts` | Modified | `USING <method>` + explicit name in push DDL |
| `packages/migrator/src/migrate.ts` | Modified | `createIndex`/`indexName`/`indexSignature` |
| `crates/fixtures/*.indigo`, `packages/compiler/fixtures/snapshots/` | New/Modified | Corpus + golden regen |
| `packages/compiler/wasm/` | Modified | Rebuilt artifact (committed) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `indexSignature` not extended → silent missed diffs | Med | Spec requirement + fixture for method-only and name-only change |
| Explicit name collides with auto-derived name | Med | Validate table-scoped name uniqueness against derived names too |
| Golden snapshot churn hides real regressions | Med | Require pre-existing snapshots byte-identical; only new fixtures change |
| WASM artifact drift vs. CI bytes | Med | Run `build:wasm` + harness locally; `wasm-drift` self-heals `main` |
| `gin`/`hash` on an unsupported column type fails at apply time | Low | Compiler validates the enum only; Postgres reports the rest (documented) |

## Rollback Plan

Compiler and migrator changes are additive: omitting `name`/`type` reproduces today's DDL byte-for-byte. Revert the change commit(s), re-run `pnpm --filter @indigodb/compiler build:wasm`, re-run `packages/compiler/test/parity.mjs`, and restore the pre-change snapshots. Schemas already using the new args stop compiling — an explicit, non-silent failure. Already-applied migration files are unaffected (they are frozen SQL); no database rollback is required.

## Dependencies

- Rust toolchain + `wasm32-unknown-unknown` + `wasm-pack` for `build:wasm` (per `CLAUDE.md`, any `crates/` change requires rebuild + regression-harness rerun).
- Phase 2 closed (`archive/2026-08-12-native-type-attributes`) — no functional dependency, pattern precedent only.

## Success Criteria

- [ ] `@@index([a, b], name: "custom_idx", type: gin)` compiles and resolves with `name` and `type` populated in the IR.
- [ ] `db push` and `migrate dev` both emit `CREATE INDEX "custom_idx" ... USING gin (...)`.
- [ ] Changing only `type` or only `name` produces DDL (drop+recreate / rename), not a no-op.
- [ ] Unknown method, duplicate explicit name, and malformed name each produce a located diagnostic.
- [ ] Every pre-existing golden snapshot is byte-identical; `cargo test`, `pnpm test`, `pnpm build`, `pnpm lint` green.

## Proposal question round

Execution mode is `auto`, so these were resolved as assumptions rather than asked. Flag any that are wrong before spec/design:
1. `type` is the closed set `btree | gin | gist | hash` (no `brin`, no `spgist`) — deliberately narrow, extendable later.
2. Method names are lowercase bare identifiers (`type: gin`), not string literals or PascalCase enum members.
3. An explicit `name` overrides the auto-derived name entirely; auto-derivation stays the default for unnamed indexes (no behavior change for existing schemas).
4. Explicit names are validated for uniqueness per table only, not globally per schema/database.
5. Compatibility of a method with a column's type is Postgres's job at apply time, not compile-time validation.
