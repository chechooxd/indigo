# Tasks: Relations Epic — Slice 1: Relation Identity & Pairing in the IR

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~450-600 authored (Rust+TS+fixtures source) + large generated golden/WASM diff |
| 800-line budget risk | Medium (authored lines likely under 800; combined with generated goldens the total diff is much larger) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Rust compiler: validate.rs + resolve.rs + ir.rs + fixtures + wasm rebuild + goldens) → PR 2 (TS: ir.ts mirror + Studio fix) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
800-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Rust compiler: relax `@relation` positional-arg validation, add name retention + pairing pass + ambiguity diagnostic, new fixtures, regenerated goldens, rebuilt WASM | PR 1 | `cd crates && cargo test` then `node packages/compiler/test/parity.mjs` | `cargo test` (native corpus) + `parity.mjs` (WASM boundary) — both real, no N/A | Revert Rust/fixture/wasm commits; rerun `build:wasm` to restore prior artifact bytes |
| 2 | TS mirror + Studio consumer fix | PR 2 (based on PR 1 merged to main) | `pnpm build --filter=@indigodb/core && pnpm lint --filter=@indigodb/studio` | `pnpm test` (Turbo-wired parity suite, unaffected but confirms no regression) | Revert `ir.ts` + `relations.ts` commit independently; optional fields mean PR 1 alone is still consistent without PR 2 |

## Phase 1: Compiler Foundation — unblock positional `@relation` names

- [x] 1.1 RED: add a Rust unit test in `crates/indigo-compiler/tests/fixtures.rs` asserting `@relation("Name", fields: [...], references: [...])` produces **zero** validation errors (currently fails: positional-arg rejection).
- [x] 1.2 RED: add a unit test asserting a second positional arg, or a non-string positional, still produces the existing `"does not accept positional arguments"` message verbatim (parity contract).
- [x] 1.3 GREEN: relax `validate_relation_args` in `crates/indigo-compiler/src/validate.rs:266-270` to allow exactly one positional string argument on `@relation`; keep the existing message for any other positional shape.
- [x] 1.4 Verify 1.1/1.2 pass: `cd crates && cargo test`.

## Phase 2: Relation Name Retention in the IR

- [x] 2.1 RED: add a unit test asserting a resolved relation for `author User @relation("PostAuthor", ...)` carries `relation_name: Some("PostAuthor")`.
- [x] 2.2 RED: add a unit test asserting an unnamed relation's resolved output omits the `relationName` key entirely (not `null`/empty string) when serialized to JSON.
- [x] 2.3 GREEN: add `relation_name: Option<String>` to `ResolvedRelation` in `crates/indigo-compiler/src/ir.rs` with `#[serde(skip_serializing_if = "Option::is_none", default)]`.
- [x] 2.4 GREEN: in `resolve.rs`, read the positional name via `positional_arg(rel_attr, 0)` (existing helper, `ast.rs:130`) inside `resolve_relations` and populate `relation_name`.
- [x] 2.5 Verify 2.1/2.2 pass: `cd crates && cargo test`.

## Phase 3: Cross-Model Pairing Pass

- [x] 3.1 RED: add a unit test — single unnamed relation to a unique target (`Post.author` ↔ `User.posts`) pairs implicitly; `User.posts` ends up with `fkColumns`/`refColumns` matching `Post.author`.
- [x] 3.2 RED: add a unit test — two named relations to the same target (`PostAuthor`/`PostReviewer`) pair by name correctly, each inverse side populated with its own counterpart's FK/ref columns.
- [x] 3.3 RED: add a unit test — self-relation (`A == B`) never pairs a field with itself.
- [x] 3.4 RED: add a unit test — inverse side gets `inverse: Some(true)`; the FK-holding side never has `inverse` set.
- [x] 3.5 GREEN: in `crates/indigo-compiler/src/resolve.rs`, convert the `.map(...).collect()` loop (`resolve.rs:219-259`) into a mutable loop; add a post-pass after `tables` is built that indexes relations by `(source_model, target_model)`, computes pairing writes per the design's algorithm (name-match first, then implicit single-unnamed-pair fallback), and applies writes only to inverse sides (empty `fkColumns`).
- [x] 3.6 GREEN: add `inverse: Option<bool>` to `ResolvedRelation` in `ir.rs` (`skip_serializing_if`, `default`; `true` or absent, never `false`).
- [x] 3.7 Verify 3.1-3.4 pass: `cd crates && cargo test`.

## Phase 4: Ambiguity Validation

- [x] 4.1 RED: add a unit test — two unnamed relations from `Post` to `User` (no names anywhere) produce a validation ERROR naming `"Post"` and `"User"`.
- [x] 4.2 RED: add a unit test — naming only one side of two candidate relations still reports the unnamed one as ambiguous.
- [x] 4.3 RED: add a unit test — `@relation("Name")` with no matching counterpart field on the target model produces a diagnostic naming the relation name and both models, and does not silently fall back to implicit match.
- [x] 4.4 RED: add a unit test — the ambiguity diagnostic is deduplicated per `{A,B}` pair (reported once even with 3+ conflicting relations), mirroring `validate_implicit_many_to_many`'s `HashSet` pattern.
- [x] 4.5 GREEN: add `validate_relation_ambiguity` in `crates/indigo-compiler/src/validate.rs`, next to `validate_implicit_many_to_many`, implementing the exact message: `Ambiguous relation between "A" and "B": multiple relation fields target the same model. Disambiguate with @relation("Name", ...) on both sides.`
- [x] 4.6 Verify 4.1-4.4 pass: `cd crates && cargo test`.

## Phase 5: Fixtures & Goldens

- [x] 5.1 Create `fixtures/12-relation-naming.indigo`: two named `User<->Post` relations (`PostAuthor`/`PostReviewer`) + one unnamed `User<->Profile` relation — expect zero validation errors.
- [x] 5.2 Create `fixtures/13-ambiguous-relations.indigo`: two unnamed relations from one model to the same target — expect the new ambiguity ERROR in the fixture's golden `validation` array (NOT `fixtures/errors/`, which is parse-failures only). Also exercises a partial-naming ambiguous pair (Comment/User).
- [x] 5.3 Update `crates/indigo-compiler/tests/fixtures.rs`'s pinned approval test `corpus_validation_errors_are_unchanged_by_new_rules` (lines 291-323) to deliberately include the new ambiguity error now expected on `fixtures/05-relations.indigo` (`Post.author`/`Post.ghost` both target `User`, with `User.posts` an observable inverse — this is correct new behavior, not a regression).
- [x] 5.4 Note (no code change): confirm `fixtures/08-self-relation.indigo` is unaffected by this change — one FK leg, no inverse pairing conflict; its pre-existing self-relation m2m false-positive stays explicitly out of scope (lives in `validate_implicit_many_to_many`). Confirmed via a dedicated regression test (`fixture_08_self_relation_is_unaffected`), not just assumed.

## Phase 6: Rebuild & Regenerate (load-bearing order)

- [x] 6.1 Run `cd crates && cargo test` — all Phase 1-4 RED tests green, full native corpus passes.
- [x] 6.2 Run `pnpm --filter @indigodb/compiler build:wasm` — rebuild the committed WASM artifact.
- [x] 6.3 Run `pnpm --filter @indigodb/compiler build` — rebuild the TS package wrapping the artifact.
- [x] 6.4 Run `node packages/compiler/test/regen-snapshots.mjs` — deliberate golden regeneration; the diff (including `05-relations.indigo`'s new ambiguity error and the new `12`/`13` fixtures) is the review artifact.
- [x] 6.5 Run `node packages/compiler/test/parity.mjs` — confirm WASM boundary parity against the regenerated goldens.
- [ ] 6.6 Commit the rebuilt `packages/compiler/wasm/` artifact; CI's `wasm-drift` job self-heals byte-level drift on `main` push, so do not hand-verify local bytes against committed ones. (Left uncommitted for orchestrator review, per batch instructions.)

## Phase 7: TypeScript Mirror & Studio Consumer

- [x] 7.1 Update `packages/core/src/ir.ts`: add `relationName?: string; inverse?: boolean;` to the `ResolvedRelation` interface; correct the `fkColumns`/`refColumns` doc comments to note the inverse-side caveat (`inverse` typed as `?: true` to mirror the Rust `Option<bool>` "never `false`" contract; `name` doc comment was additionally clarified — not left unchanged as originally noted — to distinguish it from the new `relationName`, since both now sit next to each other on the same interface).
- [x] 7.2 RED (Studio): added `apps/studio/src/features/docs/lib/relations.test.ts` with a case asserting `getRelationDetail` on an inverse-side relation (`inverse: true`, populated `fkColumns`/`refColumns`) does not render `"Foreign Key:"`.
- [x] 7.3 GREEN: updated `getRelationDetail` in `apps/studio/src/features/docs/lib/relations.ts` to branch on `rel.inverse`, rendering `Referenced by {targetModel} via {fkColumns} → {refColumns}` instead of the FK-ownership line.
- [x] 7.4 Verify: `pnpm build --filter=@indigodb/core` and `pnpm lint --filter=@indigodb/studio` (typecheck-as-lint) both pass.

## Phase 8: Full Suite Verification

- [x] 8.1 Run `pnpm build` from repo root — full workspace build order (`ast` → `parser`/`core` → consumers) succeeds (10/10 tasks).
- [x] 8.2 Run `pnpm test` from repo root — Turbo-wired `parity.mjs` regression suite green, plus studio (26/26), migrator, generator suites all green (16/16 tasks).
- [x] 8.3 Run `pnpm lint` from repo root — all packages' `tsc --noEmit` pass (18/18 tasks).
