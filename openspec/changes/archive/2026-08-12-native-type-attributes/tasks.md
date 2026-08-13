# Tasks: Native Type Attributes (`@db.X`)

## Review Workload Forecast

| PR | Estimated changed lines | 800-line budget risk | Focus |
|----|--------------------------|-----------------------|-------|
| PR A — parse-only | ~180-260 (lexer/parser/ast Rust + TS mirror + fixture + snapshot + WASM binary excluded) | Low | Lexer `Dot`, parser namespace grammar, AST field + guard, whitelist-open-only-for-`db` |
| PR B — semantic | ~320-420 (rules.rs matrix, validate.rs diagnostics, resolve/ir, ir.ts mirror, migrator branch, 2 fixtures incl. fixture 14 regen, migrator DDL tests) | Medium | Compatibility matrix, IR `nativeType`, `renderColumn` override, full snapshot regen twice (A and B) |

Decision needed before apply: No — design's chained-PR split is explicit and user-confirmed.
Chained PRs recommended: Yes (per design's "two chained PRs, split by layer").
Chain strategy: PR A merges first; PR B stacks on PR A's merged AST shape and cannot land independently (its validate.rs/resolve.rs edits assume `Attribute.namespace` exists).
800-line budget risk: Low-Medium overall; WASM binary diff explicitly excluded from authored-line count per proposal.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Rollback boundary |
|------|------|----|-----------------------|---------------------|
| 1 | Lexer `Dot` token | A | `cd crates && cargo test lexer` | Revert cleanly; no downstream consumer yet |
| 2 | Parser namespaced `parse_attribute` | A | `cd crates && cargo test parser` | Revert cleanly; grammar is additive |
| 3 | AST `namespace` field + `get_attr`/`has_attr` guard | A | `cd crates && cargo test ast` | Revert cleanly; optional field, guarded lookups |
| 4 | TS `@indigodb/ast` mirror | A | `pnpm --filter @indigodb/ast build` | Same-PR lockstep with Unit 3, revert together |
| 5 | validate.rs `db`-namespace-only whitelist | A | `cd crates && cargo test validate` | Revert cleanly; PR B tightens further |
| 6 | Fixture 14 + snapshot + WASM rebuild + parity | A | `pnpm test` | Revert requires steps 2-4 of toolchain sequence to restore prior WASM/snapshots |
| 7 | rules.rs `NATIVE_TYPE_RULES` matrix | B | `cd crates && cargo test rules` | Additive table; revert cleanly |
| 8 | validate.rs full `@db.X` diagnostics | B | `cd crates && cargo test validate` | Depends on Unit 7 |
| 9 | resolve.rs + ir.rs `nativeType`, i64 stringification fix | B | `cd crates && cargo test resolve` | Depends on Unit 7-8 |
| 10 | ir.ts mirror | B | `pnpm --filter @indigodb/core build` | Same-PR lockstep with Unit 9 |
| 11 | Fixture 15 + fixture 14 re-regen + WASM rebuild + parity | B | `pnpm test` | Revert requires full toolchain sequence |
| 12 | Migrator `renderNativeType` + `renderColumn` branch + DDL tests | B | `node --test packages/migrator/test/*.mjs` (or existing suite) | Additive branch after autoincrement check; revert cleanly, `mapScalarToPg` untouched |

## PR A — Parse-only (lexer, parser, AST, namespace-only whitelist)

### Phase A1: Lexer — `Dot` token (RED → GREEN)

- [x] A1.1 RED: `crates/indigo-compiler/src/lexer.rs` `#[cfg(test)]` — assert a bare `.` lexes to `TokenKind::Dot`; assert `describe()` returns `"'.'"`. (Spec: "Namespaced attribute syntax parses" — lexer prerequisite, not itself a scenario but required for the parser scenarios below.)
- [x] A1.2 GREEN: add `#[token(".")] Dot` to `RawToken`, `TokenKind::Dot`, and its `describe()` arm in `lexer.rs`.

### Phase A2: Parser — optional namespaced attribute name (RED → GREEN)

- [x] A2.1 RED: `crates/indigo-compiler/src/parser.rs` `#[cfg(test)]` — `parse_attribute` on `@db.VarChar(255)` yields `Attribute { namespace: Some("db"), name: "VarChar", args: [255] }` (spec scenario: "Namespaced attribute with arguments").
- [x] A2.2 RED: same file — `@db.Uuid` yields `Attribute { namespace: Some("db"), name: "Uuid", args: [] }` (spec scenario: "Namespaced attribute without arguments").
- [x] A2.3 RED: same file — `@unique` yields `Attribute { namespace: None, name: "unique", args: [] }`, byte-identical to pre-change parse (spec scenario: "Non-namespaced attribute is unaffected").
- [x] A2.4 RED: same file — a stray trailing `.` with no identifier after it (e.g. `@db.`) exercises existing recovery path (`parse_attribute` returns `None`, declaration-level sync unaffected); assert no panic and existing sync-set behavior holds (design: "Dot is not added to any sync set").
- [x] A2.5 GREEN: implement the optional-`Dot` branch in `parse_attribute` per design's grammar snippet — `expect_identifier` first, then conditionally consume `Dot` + second `expect_identifier`; make A2.1-A2.4 pass.

### Phase A3: AST — `namespace` field + guarded lookups (RED → GREEN)

- [x] A3.1 RED: `crates/indigo-compiler/src/ast.rs` `#[cfg(test)]` — `Attribute` struct serializes with `namespace: None` to a JSON payload with no `"namespace"` key (`skip_serializing_if = "Option::is_none"`); serializes with `namespace: Some("db")` to include `"namespace":"db"`, declared as the FIRST key (spec: "AST namespace representation stays additive", both scenarios).
- [x] A3.2 RED: same file — `Attribute` deserializes correctly from JSON lacking a `namespace` key (the `default` attribute, required because resolve/validate deserialize AST JSON back into Rust per design decision #1).
- [x] A3.3 RED: same file — `has_attr(attrs, "map")` returns `false` when the only matching-named attribute has `namespace: Some("db")` (i.e. `@db.map` does not satisfy a bare `has_attr(attrs, "map")` lookup); `get_attr` analogous (design decision #3 — CRITICAL fix, guards against a future `@db.map` hijacking `@map` resolution).
- [x] A3.4 GREEN: add `pub namespace: Option<String>` as the first field of `Attribute` with `#[serde(skip_serializing_if = "Option::is_none", default)]`; add `a.namespace.is_none()` guard to both `get_attr` and `has_attr`; make A3.1-A3.3 pass.

### Phase A4: TS `@indigodb/ast` mirror (same-slice lockstep)

- [x] A4.1 GREEN: `packages/ast/src/index.ts` — add `namespace?: string` as the first declared property on the `Attribute` interface, matching Rust field order (design decision #2). No standalone RED here — TS types have no runtime test; correctness is proven by the parity harness in A6.

### Phase A5: validate.rs — namespace-only whitelist (RED → GREEN)

- [x] A5.1 RED: `crates/indigo-compiler/src/validate.rs` `#[cfg(test)]` — a field attribute with `namespace: Some("db")` and any `name` produces NO unrecognized-attribute diagnostic (PR A does not check the type name yet — that's PR B) (design decision #4).
- [x] A5.2 RED: same file — a field attribute with `namespace: Some("orm")` (any namespace other than `"db"`) produces the unrecognized-attribute diagnostic naming model/field, exactly as today's bare-unknown-attribute path (spec `attribute-validation` scenario: "Unknown namespace" — namespace-rejection half only; the "Unknown native type name" scenario for `db.Foo` is PR B's responsibility since PR A does not check names).
- [x] A5.3 GREEN: extend the whitelist branch in `validate.rs` to admit `namespace == Some("db")` unconditionally (any name), reject any other `Some(_)` namespace with the existing unrecognized-attribute diagnostic path; make A5.1-A5.2 pass.

### Phase A6: Fixture, snapshot regen, WASM rebuild, parity (closing verification)

- [x] A6.1 Create `fixtures/14-native-type-attributes.indigo` — a model using `@db.VarChar(255)`, `@db.Uuid`, `@db.Numeric(10,2)` on compatible-looking scalar fields (exact scalar compatibility is unchecked in PR A; any scalar is fine since PR B adds the matrix). Golden must show `validation: []` and `resolved` output with NO `nativeType` key anywhere (PR A does not populate IR) — per design's File Changes table.
- [x] A6.2 Confirm all 13 pre-existing fixtures still produce zero new diagnostics and byte-identical snapshots (spec `attribute-validation`: "Pre-existing corpus is unaffected").
- [x] A6.3 Toolchain sequence: `cd crates && cargo test` (all Rust unit + fixture-corpus tests green, including A1-A5 and A6.2) → `pnpm --filter @indigodb/compiler build:wasm` (rebuild and commit `packages/compiler/wasm/`) → `node packages/compiler/test/regen-snapshots.mjs` (review the diff — fixture 14 is new, 01-13 must show zero diff) → `pnpm test` (TS parity harness green, proving AST + TS mirror lockstep).
- [x] A6.4 `pnpm build && pnpm lint` at repo root green (typecheck-as-lint across all packages, including `@indigodb/ast`'s new optional field).

## PR B — Semantic (rules, validate, resolve, IR, migrator)

Depends on PR A merged. Builds on `Attribute.namespace` existing in the AST.

### Phase B1: rules.rs — `NATIVE_TYPE_RULES` compatibility matrix (RED → GREEN)

- [x] B1.1 RED: `crates/indigo-compiler/src/rules.rs` `#[cfg(test)]` — matrix lookup: `VarChar` → valid scalar `String`, arity exactly 1 integral arg; `Uuid` → valid scalar `String`, arity 0; `Numeric` → valid scalars `Decimal`|`Float`, arity 0 or 2 integral args (design's Compatibility Matrix table, next to existing `ATTRIBUTE_RULES` pattern).
- [x] B1.2 RED: same file — lookup of an unknown native type name (e.g. `"Foo"`) returns `None`/not-found from the matrix.
- [x] B1.3 GREEN: add `NATIVE_TYPE_RULES` table + lookup function mirroring `attribute_rule`'s shape; make B1.1-B1.2 pass.

### Phase B2: validate.rs — full `@db.X` diagnostics (RED → GREEN)

- [x] B2.1 RED: `crates/indigo-compiler/src/validate.rs` — `@db.Foo` (unknown native type name, valid `db` namespace) produces a diagnostic naming model, field, `"db.Foo"` (spec `attribute-validation`: "Unknown native type name").
- [x] B2.2 RED: same file — `@orm.hint` (unknown namespace, PR A already covers this — regression-proof it still holds after B's changes) (spec: "Unknown namespace").
- [x] B2.3 RED: same file — `count Int @db.VarChar(255)` (scalar mismatch) produces a diagnostic naming model, field, `"VarChar"`, and `"Int"` (spec `attribute-validation`: "Native type on an incompatible scalar").
- [x] B2.4 RED: same file — `id String @db.Uuid` (compatible scalar) produces NO diagnostic (spec: "Native type on a compatible scalar").
- [x] B2.5 RED: same file — wrong-arity cases: `@db.VarChar` with 0 args, `@db.VarChar(255, 10)` with 2 args, `@db.Uuid(1)` with 1 arg, `@db.Numeric(10)` with 1 arg — all produce arity diagnostics (design Compatibility Matrix "Errors" row: "wrong arity/arg type").
- [x] B2.6 RED: same file — `@db.X` on an enum-typed field and on a relation field both produce diagnostics (design Compatibility Matrix "Errors" row).
- [x] B2.7 GREEN: wire `NATIVE_TYPE_RULES` lookup into `validate_attributes`, checked before the existing bare-name `attribute_rule` lookup per design's Data Flow — full name + arity + scalar-compatibility diagnostics, model/field always populated; make B2.1-B2.6 pass. Verify A5.1/A5.2 (PR A's coarser namespace-only checks) still pass unchanged.

### Phase B3: resolve.rs + ir.rs — structured `nativeType` (RED → GREEN)

- [x] B3.1 RED: `crates/indigo-compiler/src/ir.rs` `#[cfg(test)]` (or resolve.rs, matching existing convention) — `ResolvedColumn.native_type` serializes to `nativeType: { name, args }` when present, omitted (not `null`) when absent, per `skip_serializing_if = "Option::is_none"` appended AFTER `note` (spec: "Resolving a field with/without a native type override", both scenarios; design's Interfaces section — field ordering).
- [x] B3.2 RED: `crates/indigo-compiler/src/resolve.rs` — CRITICAL bug design flagged: a field with `@db.VarChar(255)` where `255` arrives as `AttributeValue::Number(255.0)` resolves to `nativeType.args == ["255"]`, never `["255.0"]` — assert i64-formatted stringification for integral values (design decision #6).
- [x] B3.3 RED: same file — `@db.Numeric(10,2)` resolves to `nativeType: { name: "Numeric", args: ["10", "2"] }` (two-arg case, also integral-stringified).
- [x] B3.4 RED: same file — `@db.Uuid` (zero args) resolves to `nativeType: { name: "Uuid", args: [] }`.
- [x] B3.5 GREEN: add `ResolvedNativeType { name, args }` struct and `ResolvedColumn.native_type: Option<ResolvedNativeType>` to `ir.rs`; populate in `resolve_column` from a validated `@db.X` attribute, using explicit integral (`i64`) formatting for `AttributeValue::Number` args (design decision #6, NOT bare `f64::to_string()`); make B3.1-B3.4 pass.

### Phase B4: `packages/core/src/ir.ts` mirror (same-slice lockstep)

- [x] B4.1 GREEN: add `nativeType?: { name: string; args: string[] }` to `ResolvedColumn` in `ir.ts`, matching Rust field order (appended after `note`). Correctness proven by the parity harness in B6.

### Phase B5: Migrator — `renderNativeType` + `renderColumn` branch (RED → GREEN)

- [x] B5.1 RED: new/existing migrator DDL test file (e.g. `packages/migrator/test/*.mjs`) — `renderColumn` on a `ResolvedColumn` with `nativeType: { name: "VarChar", args: ["255"] }` emits `"bio" VARCHAR(255)` (spec `migration-ddl-ordering`: "Column with a native type override").
- [x] B5.2 RED: same file — `nativeType: { name: "Uuid", args: [] }` emits `"id" UUID` (bare name, no parens) (spec: "Column with a zero-argument native type override").
- [x] B5.3 RED: same file — a column with no `nativeType` renders exactly as `mapScalarToPg` produces today, unchanged (spec: "Column without a native type override" — regression proof).
- [x] B5.4 RED: same file — a column that is BOTH `autoincrement: true` AND carries a `nativeType` still renders `GENERATED BY DEFAULT AS IDENTITY` (IDENTITY wins; native type override does not apply) — this is design's explicit ordering requirement ("branch inserted AFTER the autoincrement/IDENTITY check").
- [x] B5.5 RED: `renderPushSql`-level test — a `CREATE TABLE` statement for a table containing a `nativeType`-overridden column reflects the override (spec: "Column with a native type override", full-statement level).
- [x] B5.6 RED: `renderMigrationSql`/`migrate.ts`-level test — `ALTER TABLE ... ADD COLUMN "bio" VARCHAR(255)` is emitted for a new column carrying `nativeType` (spec `migration-ddl-ordering`: "Versioned migration ADD COLUMN honors the override"); confirm this is free via the shared `renderColumn` used by both `postgres.ts` and `migrate.ts` (no separate implementation needed).
- [x] B5.7 GREEN: implement `renderNativeType(n)` in `packages/migrator/src/postgres.ts` per design's Interfaces snippet (`{VarChar:"VARCHAR", Uuid:"UUID", Numeric:"NUMERIC"}[n.name]`, joined args or bare name); insert the branch in `renderColumn` immediately AFTER the existing `column.autoincrement` check, falling back to `mapScalarToPg` otherwise; make B5.1-B5.6 pass.

### Phase B6: Fixtures, full snapshot regen (twice), WASM rebuild, parity (closing verification)

- [x] B6.1 Create `fixtures/15-rejected-native-types.indigo` — includes an unknown `@db.Foo` and a scalar-incompatible `@db.VarChar` on an `Int` field. Golden `validation[]` asserts both diagnostics, placed as an ordinary fixture (NOT under `fixtures/errors/`, since these are validation failures, not parse failures — design decision #7 / spec `attribute-validation`: "New rejected-case fixture").
- [x] B6.2 IMPORTANT — re-regenerate fixture 14's golden snapshot in THIS slice: its `resolved` output now gains `nativeType` for the `@db.VarChar(255)`/`@db.Uuid`/`@db.Numeric(10,2)` fields, changing the golden a second time (once in PR A with no `nativeType`, once here with it populated). Reviewers must diff BOTH regenerations, not just PR B's fixture-15 addition (proposal + design both flag this explicitly).
- [x] B6.3 Confirm all 13 pre-existing fixtures (01-13) still produce zero diagnostics and byte-identical snapshots (spec: "Pre-existing corpus is unaffected" — still holds after PR B).
- [x] B6.4 Toolchain sequence: `cd crates && cargo test` (all Rust unit + fixture-corpus tests green, including B1-B5 and B6.3) → `pnpm --filter @indigodb/compiler build:wasm` (rebuild and commit) → `node packages/compiler/test/regen-snapshots.mjs` (review the diff — fixture 14 changes again, fixture 15 is new, 01-13 must show zero diff) → `pnpm test` (TS parity harness green).
- [x] B6.5 `pnpm build && pnpm lint` at repo root green (typecheck-as-lint, including `@indigodb/core`'s `ir.ts` mirror and `@indigodb/migrator`'s new branch).
- [x] B6.6 Run migrator DDL tests standalone to confirm B5.1-B5.6 pass in the built package, not just source-level.

## Known Follow-up (explicitly deferred, not silently dropped)

- [ ] FOLLOW-UP (not in this change): `packages/migrator/src/migrate.ts::alterColumn`/`diffResolved` does NOT diff a column whose `nativeType` changes between schema versions (e.g. `@db.VarChar(255)` → `@db.VarChar(500)`, or adding/removing `@db.X` on an existing column). Per proposal Success Criteria and design's Migration/Rollout section, this is a user-confirmed deferred follow-up change. Adding `@db.X` to an existing schema today produces DDL only via `renderPushSql`/`CREATE TABLE`, with no corresponding versioned migration until that follow-up lands. Flag this to reviewers so it is not mistaken for an oversight.
</content>
