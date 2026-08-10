# Proposal: Fix .indigo Compiler Correctness

## Intent

The `.indigo` compiler silently accepts constructs it then discards or mis-resolves — no parse error, no validation error. The schema file lies about what the database will do. Because `@indigodb/core`'s `ResolvedSchema` is the single contract every consumer reads (migrator, generator, client, realtime, studio), one wrong IR corrupts every downstream artifact at once. Eight confirmed defects share this failure mode. After this change, every in-scope construct either works or fails loudly with an actionable message.

## Scope

### In Scope

| Sev | Defect | Resolution |
|-----|--------|------------|
| Blocker | Unquoted `onDelete: Cascade` discarded (`resolve.rs:116` accepts only `String`) | Also accept `AttributeValue::Reference` |
| Blocker | No attribute whitelist / arity / argument-type check | `@uniqe`, `@deafult`, `@default("nope")` on `Int` all become diagnostics |
| Blocker | Implicit many-to-many resolves to zero DDL | **Reject** it; the error names the explicit join-model remedy |
| Major | String literals never unescaped | Unescape escape sequences during lexing/parsing |
| Major | One lexer error aborts the pass, hiding all parser diagnostics | Recover; report both classes in one pass |
| Major | `@map` on enum values parsed then dropped | Carry the physical label into the IR |
| Major | No `onUpdate` referential action | Parse, validate, emit |
| Major | `datasource.provider` unvalidated; extra blocks dropped | Validate provider; error on duplicate blocks |

### Out of Scope

AST source spans; native type attributes (`@db.VarChar` — needs a `.` lexer token); scalar list fields; views, multi-schema, check constraints, RLS; the CI floor; every migrator, client, CLI and Studio defect. Each is its own later change.

## Constraints

- **Both suites currently ratify defects.** `fixtures/snapshots/03-quirks-values.json` froze the discarded `onDelete`; the Rust test `quirk_strings_are_not_unescaped` asserts the unescaping bug. Fixing them REQUIRES regenerating snapshots and inverting that test — expected, reviewable churn, not accidental breakage. Per CLAUDE.md the snapshot diff is the review artifact.
- **WASM rebuild is mandatory.** Any `crates/` edit requires `pnpm --filter @indigodb/compiler build:wasm`, a committed `packages/compiler/wasm/`, then a rerun of `pnpm test`. Rust/binary drift is structurally undetectable today.
- **Strict TDD is active.** `cd crates && cargo test` and `pnpm test`, both GREEN at `55ed913` on a clean tree. This package needs no new harness — that is why the change is sequenced first.
- **New diagnostics are an intended behavior change.** Schemas that compiled silently may now fail. Every new error MUST name the construct, its 1-based location, and the remedy; the change MUST ship a release note listing all new rejection classes.

## Capabilities

### New Capabilities
- `referential-actions`: `onDelete`/`onUpdate` accepted quoted or bare, validated, emitted to the IR
- `attribute-validation`: known-attribute whitelist, arity, and argument-type rules per target
- `relation-validation`: implicit many-to-many rejected with an actionable explicit-join-model error
- `compiler-diagnostics`: lexer errors recover instead of suppressing parser diagnostics
- `string-literals`: escape-sequence semantics for string literals
- `enum-value-mapping`: `@map` on enum values honored in the resolved IR
- `datasource-validation`: `provider` value validated; duplicate `datasource` blocks rejected

### Modified Capabilities
- None — `openspec/specs/` is empty; this is the first spec set.

## Approach

All work lands in `crates/indigo-compiler`; the TS wrapper and the serde JSON contract stay stable except for the added `onUpdate` and enum `dbName` keys. Sequence: (1) lexer/parser — escapes, error recovery, bare referential-action values; (2) `validate.rs` — attribute table, provider check, m-n rejection; (3) `resolve.rs` — emit the recovered values; (4) rebuild WASM and regenerate goldens as the final reviewable step.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `crates/indigo-compiler/src/{lexer,parser}.rs` | Modified | Unescaping, error recovery, referential-action values |
| `crates/indigo-compiler/src/validate.rs` | Modified | Attribute table, provider, m-n and duplicate-block errors |
| `crates/indigo-compiler/src/{resolve,ir}.rs` | Modified | `onDelete`/`onUpdate`, enum `dbName` in the IR |
| `crates/indigo-compiler/tests/fixtures.rs` | Modified | Invert `quirk_strings_are_not_unescaped`; add RED tests |
| `fixtures/`, `fixtures/snapshots/` | Modified | New/updated cases; regenerated goldens |
| `packages/compiler/wasm/` | Modified | Rebuilt committed artifact (mandatory) |
| `packages/core/src/ir.ts` | Modified | Type-only mirror of new IR keys |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Existing user schemas stop compiling | High (intended) | Errors name construct, location and remedy; release note lists every new rejection class |
| Snapshot churn hides a real regression | Med | Regenerate goldens in one isolated final commit; diff reviewed as the artifact |
| Rust source and committed WASM drift | Med | `build:wasm` + `pnpm test` in the same commit; verify gate re-runs both suites |
| Over-strict attribute whitelist rejects valid schemas | Med | Whitelist derived from what `resolve.rs` actually consumes; every fixture must still compile |
| IR key additions break downstream consumers | Low | Additive keys only; absent ≡ `undefined`; `pnpm build` + `pnpm lint` across the workspace |

## Rollback Plan

Self-contained in `crates/`, `fixtures/`, `packages/compiler/wasm/` and `packages/core/src/ir.ts` — no data migration, no persisted state. Revert the change commits (or the merge commit) and re-run `pnpm --filter @indigodb/compiler build:wasm` to restore the prior artifact, then `cd crates && cargo test` and `pnpm test`. If only one defect fix regresses, revert its slice: the work units are independent per capability except that goldens regenerate last.

## Dependencies

- Rust toolchain with `wasm32-unknown-unknown` and `wasm-pack` (required for `build:wasm`).
- Baseline `55ed913`, clean tree, both suites GREEN.

## Success Criteria

- [ ] Each of the 8 defects has a test that was RED before its fix and is GREEN after.
- [ ] `cd crates && cargo test` and `pnpm test` GREEN with the rebuilt, committed WASM artifact.
- [ ] Unquoted `onDelete: Cascade` and any `onUpdate` action appear in the resolved IR and the emitted DDL.
- [ ] `@uniqe`, `@deafult`, `@default("nope")` on `Int`, `provider = "mysql"`, a duplicate `datasource`, and an implicit m-n relation each produce a located, actionable error.
- [ ] A file with one lexer error still reports its parser diagnostics.
- [ ] Golden snapshot diff is limited to intentional contract changes and reviewed as the artifact.
- [ ] `pnpm build` and `pnpm lint` pass across the workspace.
