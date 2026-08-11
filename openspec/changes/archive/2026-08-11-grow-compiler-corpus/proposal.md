# Proposal: Grow the Compiler Corpus and Add Property-Based Parser Testing

## Intent

The `.indigo` compiler's entire regression surface is **8 fixture files** (5 valid + 3 parse-error). Verified gaps: `BigInt`, `Bytes`, `Restrict`, `SetNull`, `SetDefault`, `NoAction` appear **nowhere** in `fixtures/`; the attributes `fix-compiler-correctness` turned from silent no-ops into hard errors (`@@id`, `@updatedAt`, `@@ignore`, misspelled `@relation` keys) exist only as inline `cargo test` strings, so no golden snapshot pins their diagnostics. And nothing proves the parser never *panics* — a panic in WASM aborts the Studio, the CLI, and every consumer at once. Closes roadmap Phase 1's "Grow the language corpus + fuzz the parser".

## Scope

### In Scope
- New valid fixtures + regenerated snapshots covering: all 9 scalar types, all 5 referential actions (bare and quoted), self-relations, enum `@map`, composite/`@@unique`/`@@index` shapes, datasource/generator provider edge cases.
- New fixtures that parse cleanly but pin a non-empty `ValidationError[]` for the now-rejected attributes (`@@id`, `@updatedAt`, `@@ignore`, unknown `@relation` args).
- New parse-error fixtures for uncovered recovery paths in `fixtures/errors/`.
- `proptest` as a **dev-dependency only**, plus a property test asserting `parse_source` / `resolve` / `validate` never panic, using a custom `Strategy` biased toward `.indigo`-shaped tokens (keywords, braces, identifiers, attributes) rather than uniform random bytes.

### Out of Scope
- `cargo-fuzz` and any nightly toolchain — resolved against; `rust-toolchain.toml` pins stable 1.93.1 for one-toolchain WASM reproducibility. Not open for re-litigation.
- AST source spans (separate, larger change).
- Any `.indigo` language feature, new validation rule, or diagnostic-wording change. Existing compiler behavior stays byte-identical.

## Capabilities

### New Capabilities
- `compiler-corpus-coverage`: what the fixture corpus MUST exercise, and how a fixture pins AST + `ResolvedSchema` + `ValidationError[]`.
- `parser-panic-freedom`: the parser/resolver/validator MUST return errors, never panic, for arbitrary input; property-test strategy shape.

### Modified Capabilities
- None. The 7 compiler specs' requirements are unchanged; this change only widens their executed evidence.

## Approach

Cross-reference each scenario in the 7 compiler capability specs against the corpus; every scenario with no fixture becomes one. Fixtures stay small and single-purpose. Snapshots via `node packages/compiler/test/regen-snapshots.mjs` — the diff is the review artifact. `proptest` lands as a separate test file under `crates/indigo-compiler/tests/`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `fixtures/*.indigo`, `fixtures/errors/` | New | Added fixtures |
| `fixtures/snapshots/*.json` | New | One golden per new valid fixture (generated) |
| `crates/indigo-compiler/tests/fixtures.rs` | Modified | `corpus_validation_errors_are_unchanged_by_new_rules` hardcodes expected messages per filename; must list every new fixture |
| `crates/indigo-compiler/tests/` | New | `proptest` property-test file |
| `crates/indigo-compiler/Cargo.toml` | Modified | `[dev-dependencies] proptest` |

**No `crates/src/` change → the committed WASM artifact is unchanged and `build:wasm` is not required.** If any new fixture reveals a real compiler defect, STOP and report it — fixing it is a different change.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A new fixture exposes a real compiler bug mid-change | Med | Out of scope by rule: report, do not fix here |
| Snapshot regen masks an unintended contract drift | Med | Regen only after new fixtures land; existing 5 goldens MUST be byte-identical in the diff |
| `proptest` finds a genuine panic | Med | A found panic is a success signal; capture the minimized case as a fixture, fix only if trivial, else report |
| `proptest` runtime slows `cargo test` | Low | Bound case count; keep the strategy narrow |

## Rollback Plan

`git revert` the change commit(s). Nothing outside `fixtures/` and `crates/indigo-compiler/{Cargo.toml,tests/}` is touched; no published artifact, no WASM binary, no TS package output. Reverting restores the previous 8-file corpus and green harness with no rebuild.

## Dependencies

- `proptest` crate must resolve on stable 1.93.1 with the offline/CI network policy from `add-ci-floor`.

## Success Criteria

- [ ] Every scenario in the 7 compiler capability specs maps to at least one corpus fixture or a named existing `cargo test`.
- [ ] All 9 scalar types and all 5 referential actions appear in `fixtures/`.
- [ ] At least one fixture pins a non-empty `ValidationError[]` for each newly-rejected attribute.
- [ ] `proptest` property test runs in `cargo test` and passes with no panic.
- [ ] `pnpm test` and `cd crates && cargo test` are green; goldens for the original 5 fixtures are unchanged.
