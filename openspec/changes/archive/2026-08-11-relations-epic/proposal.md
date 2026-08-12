# Proposal: Relations Epic — Slice 1: Relation Identity & Pairing in the IR

## Intent

`@relation("Name", ...)` is parsed and kept in the AST, but `resolve.rs::resolve_relations` never reads the positional name; `ResolvedRelation.name` is the schema *field* name. There is also **no cross-model pairing step at all** — each relation field resolves independently, so an inverse-side field (`User.posts`) carries empty `fkColumns`/`refColumns` and is matched to nothing. When a model has two relations to the same target, no consumer can tell which pairs with which, and no diagnostic fires. This blocks every relation-traversal feature (`include`, `select`, `_count`) downstream: codegen cannot trust which FK belongs to which relation.

## Split Decision (resolved)

**Two separate SDD changes.** This change ships slice 1 only. `include`/`select`/`_count` becomes a distinct follow-up change (`relations-include-select`) because it is XL/greenfield (no JOIN construction exists anywhere in `packages/`), needs its own JOIN-vs-N+1 design decision, and must resolve the pre-existing `SelectInput` non-narrowing gap. Slice 1 delivers correctness value alone and is a hard prerequisite.

## Decisions (user-confirmed, post-proposal)

1. **Ambiguity policy**: hard ERROR. An unnamed multi-relation-to-same-target set fails to compile — this is a breaking change for any schema relying on today's silent, indeterminate output, and that's the point: it's the bug this change closes.
2. **Inverse-side IR shape**: populate, not just link. The inverse side (`User.posts`) gets the paired relation's real `fkColumns`/`refColumns`, not merely a name/id pointing at its counterpart. Higher snapshot churn, but consumers (e.g. the Studio ERD) get complete data without a second lookup.
3. **Fallback rule**: stays opt-in. A model with exactly one relation to a given target never requires `@relation("Name")` — implicit match by unique target continues to work unchanged. Naming is required only when it's needed to resolve genuine ambiguity, not schema-wide the moment any named relation appears.

## Scope

### In Scope
- Read the positional `@relation` name in `resolve.rs`; add `relationName?` to `ResolvedRelation` (`ir.rs` + `ir.ts` mirror, `skip_serializing_if` so absent ≡ `undefined`).
- Cross-model pairing: link each relation to its inverse side; populate the inverse side's `fkColumns`/`refColumns` from its paired counterpart (Decision 2), not just a name reference. Match by explicit name first, fall back to unique target-model match (Decision 3 — no name needed when unambiguous).
- New validation ERROR (Decision 1) for genuinely ambiguous unnamed relation sets (two+ relations to one target with no `@relation("Name")` on both sides).
- New fixture + goldens covering named pairing and the ambiguous-unnamed error.

### Out of Scope
- `include` / `select` / `_count` codegen, JOIN building, `SelectInput` narrowing (follow-up change).
- `RelationType::ManyToMany` — still a dead variant; implicit m2m stays rejected.
- Self-relation false-positive m2m diagnostic (documented in `fixtures/08-self-relation.indigo`) unless pairing work makes it free.

## Capabilities

### New Capabilities
- `relation-identity`: `@relation` name retention in the IR and deterministic cross-model relation pairing.

### Modified Capabilities
- `relation-validation`: adds an ambiguous-unnamed-relation diagnostic.

## Approach

Add a post-pass in `resolve()` (after tables are built, where all models are visible) that pairs relations across models; `resolve_relations` stays per-model and gains only the name read. Validation for ambiguity lives in `validate.rs` alongside the existing relation checks.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `crates/indigo-compiler/src/resolve.rs` | Modified | Read `@relation` name; new pairing pass |
| `crates/indigo-compiler/src/ir.rs` | Modified | New optional field(s) on `ResolvedRelation` |
| `crates/indigo-compiler/src/validate.rs` | Modified | Ambiguity diagnostic |
| `packages/core/src/ir.ts` | Modified | TS mirror + corrected doc comments |
| `packages/compiler/wasm/` | Modified | Rebuilt artifact (committed) |
| `fixtures/`, `fixtures/snapshots/` | New/Modified | New named-relation fixture + regenerated goldens |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Golden snapshot churn across all fixtures | High | Additive optional IR fields only; regen diff is the review artifact |
| WASM artifact byte drift vs CI | Med | Rebuild + `parity.mjs` locally; CI `wasm-drift` self-heals on `main` push |
| New error breaks existing valid schemas | Med | Error fires only on true ambiguity; single-relation-per-target unaffected |
| `fixtures/05-relations.indigo` is a poor regression case | High | It is already an *error* fixture (duplicate `User`, invalid `ghost` refs) — add a clean new fixture instead of repurposing it |

## Rollback Plan

Revert the change commits (Rust + TS + fixtures) and re-run `pnpm --filter @indigodb/compiler build:wasm` to restore the prior artifact; IR additions are optional fields, so consumers ignoring them are unaffected.

## Dependencies

- Rust toolchain (`rust-toolchain.toml`), `wasm32-unknown-unknown`, `wasm-pack` for the artifact rebuild.
- Snapshot regeneration (`regen-snapshots.mjs`) is intentional here and must be called out in review.

## Success Criteria

- [ ] `ResolvedRelation` carries the `@relation` name when declared.
- [ ] Every relation resolves to a determinate inverse side or a validation error.
- [ ] Ambiguous unnamed multi-relation schemas produce an error, not silent output.
- [ ] `cargo test` + `packages/compiler/test/parity.mjs` green; goldens regenerated deliberately.
