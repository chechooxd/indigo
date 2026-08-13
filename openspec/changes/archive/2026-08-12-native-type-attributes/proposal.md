# Proposal: Native Type Attributes (`@db.X`)

## Intent

`.indigo` authors cannot control the physical Postgres column type. Every `String` becomes `text`, so `VARCHAR(255)`, `UUID`, and `NUMERIC(10,2)` are unreachable — blocking adoption on existing databases and on schemas with real precision/storage constraints. This is the Rust-compiler half of Phase 2 epic 4/5; `client-driver-adapters` is a separate, independent change.

## Scope

### In Scope
- Lexer: new `Dot` token (confirmed absent in `lexer.rs` today).
- Parser: `parse_attribute` accepts `identifier (Dot identifier)?`; the single-identifier form stays byte-identical for `@unique`, `@@map`, etc.
- AST: `Attribute` gains namespace support (see Approach — open decision).
- Validate: `db` namespace whitelisted; unknown `@db.X`, wrong arity, and scalar/native-type mismatch produce diagnostics.
- Resolve + IR: `ResolvedColumn.nativeType` in `ir.rs` and `packages/core/src/ir.ts`, in lockstep.
- Migrator: `renderColumn` honors `nativeType` before falling back to `mapScalarToPg`.
- New fixtures: one accepted-syntax, one rejected-case; full snapshot regen; WASM rebuild committed.

### Out of Scope
- Native types beyond `VarChar`, `Uuid`, `Numeric` (extensible, not exhaustive).
- `migrate.ts` `ALTER COLUMN TYPE` diffing — deferred follow-up.
- Generator TS row-type changes (`nativeType` is DDL-only).
- Any driver/adapter work.

## Capabilities

### New Capabilities
- `native-type-attributes`: namespaced `@db.X(...)` syntax, its validation rules, and its effect on emitted DDL.

### Modified Capabilities
- `attribute-validation`: the whitelist currently rejects any attribute outside a fixed list; it must admit the `db` namespace without weakening unknown-attribute rejection.
- `migration-ddl-ordering`: `CREATE TABLE` column rendering must honor the override.

## Approach

Two chained PRs:
- **PR A (parse-only)**: lexer + parser + AST + TS `@indigodb/ast` mirror + one fixture + WASM rebuild + snapshot regen. `@db.X` parses; resolved output unchanged.
- **PR B (semantic)**: validate + resolve + `ir.rs`/`ir.ts` + migrator, on PR A's merged AST shape. DDL changes here.

**Open AST decision — needs user confirmation before `sdd-design`:** compound `name: "db.VarChar"` vs. explicit `namespace: Option<String>`. Recommendation: **namespace field**. Verified counter-evidence to the exploration's cost objection — `ast.rs` already uses `#[serde(skip_serializing_if = "Option::is_none", default)]`, so an optional field serializes to *no key* and existing golden snapshots stay byte-identical. The explicit field is more extensible and removes ad-hoc string splitting in validate/resolve at near-zero snapshot cost.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `crates/indigo-compiler/src/lexer.rs` | Modified | `Dot` token |
| `crates/indigo-compiler/src/parser.rs` | Modified | namespaced attribute names |
| `crates/indigo-compiler/src/ast.rs` + `packages/ast/src` | Modified | wire contract, lockstep |
| `crates/indigo-compiler/src/{validate,resolve,ir}.rs` | Modified | rules + `nativeType` |
| `packages/core/src/ir.ts` | Modified | `ResolvedColumn` mirror |
| `packages/migrator/src/postgres.ts` | Modified | override in `renderColumn` |
| `fixtures/`, `fixtures/snapshots/` | New/Modified | 13 existing + new fixtures |
| `packages/compiler/wasm/` | Modified | mandatory rebuild, committed |

## Toolchain Sequence (mandatory, carried into design + tasks)

1. `cd crates && cargo test`
2. `pnpm --filter @indigodb/compiler build:wasm` — rebuild **and commit** the artifact
3. `node packages/compiler/test/regen-snapshots.mjs` — intentional contract change; the diff is the review artifact
4. `pnpm test` — TS parity harness
5. Rely on CI's `wasm-drift` job on push to `main`. **Never** hand-verify local rebuild bytes against committed bytes — they are host-dependent by design.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| TS AST mirror drifts from `ast.rs` | High | Rust + TS AST edits land in the SAME slice (PR A); parity harness gates |
| Snapshot regen hides an unintended contract change | Med | Regen diff is the explicit review artifact; optional-field serde keeps existing snapshots byte-identical |
| `attribute-validation` whitelist rejects `@db.X` | High | Explicitly a Modified Capability; delta spec required |
| PR A merges dead syntax (parses, does nothing) | Med | Stack PR B tightly; PR A ships no user-facing docs |
| Review budget (800 lines) exceeded | Med | Two-slice chain; WASM binary diff excluded from authored-line count |

## Rollback Plan

Per-slice `git revert`. PR B reverts cleanly on its own (additive `nativeType` + migrator branch). Reverting PR A additionally requires re-running steps 2–4 to restore the prior WASM artifact and snapshots. No data migration is involved; emitted DDL only changes for schemas that opt in to `@db.X`.

## Dependencies

- Rust toolchain: rustc 1.93.1, wasm-pack 0.15.0, wasm-bindgen 0.2.126 (`crates/Cargo.lock`).
- No dependency on `client-driver-adapters`.

## Success Criteria

- [ ] `@db.VarChar(255)`, `@db.Uuid`, `@db.Numeric(10,2)` parse, validate, and resolve.
- [ ] All 13 existing fixtures still compile with zero new diagnostics.
- [ ] `renderPushSql` emits `VARCHAR(255)` / `UUID` / `NUMERIC(10,2)` when overridden, prior output otherwise.
- [ ] Unknown `@db.Foo` and scalar mismatch produce diagnostics with model + field names.
- [ ] `cargo test` and `pnpm test` green; WASM artifact rebuilt and committed.

## Proposal question round

Blocked from asking interactively. These need user answers before `sdd-design` locks:

1. **AST shape (blocking):** confirm `namespace: Option<String>` over compound `"db.VarChar"`?
2. Should an unknown `@db.Foo` be a hard error, or a warning for forward-compat with future Postgres types?
3. Is `@db.X` on a mismatched scalar (e.g. `@db.VarChar` on `Int`) an error, or silently ignored?
4. Does `nativeType` belong in the IR as a raw SQL string (`"VARCHAR(255)"`) or as structured `{ name, args }`?
5. Confirm `migrate.ts` `ALTER COLUMN TYPE` is genuinely deferred — existing schemas adding `@db.X` will produce no migration until then.
