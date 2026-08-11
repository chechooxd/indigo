# Verification Report — relations-epic (Slice 1: Relation Identity & Pairing in the IR)

**Mode**: hybrid (openspec files + Engram). Verified against spec (relation-identity NEW + relation-validation MODIFIED deltas), design, tasks.md, apply-progress.

## Task completeness (tasks.md, 39 items across 8 phases)

All checked except **6.6** (commit the rebuilt WASM artifact), explicitly deferred to the orchestrator per batch instructions (a delivery/commit step, not implementation work). Not committed/pushed at verify time — treated as WARNING, not CRITICAL.

## Build/test evidence (all executed live in this verify pass)

1. `cd crates && cargo test` → **38/38 pass** (4 rules tests + 33 fixtures tests + 1 parser_panic test), including every new pairing/naming/ambiguity test.
2. `node packages/compiler/test/parity.mjs` → **all green**, including new fixtures 12/13.
3. `pnpm build` (root) → **10/10 tasks** pass.
4. `pnpm lint` (root) → **18/18 tasks** pass (`tsc --noEmit` per package).
5. `pnpm test --force` (root, non-cached) → **16/16 tasks** pass, incl. `apps/studio/src/features/docs/lib/relations.test.ts` (4/4).

## Spec compliance matrix

### relation-identity (NEW)

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| `@relation` name retained | Named carries name | PASS | `relation_name_is_retained_in_the_ir` |
| | Unnamed omits key | PASS | `unnamed_relation_omits_relation_name_key` + `#[serde(skip_serializing_if)]` |
| Cross-model pairing | Single unnamed pairs implicitly | PASS | `single_unnamed_relation_pairs_implicitly`; reconfirmed via golden diffs on fixtures 01/02 |
| | Named pairs correctly among multiple relations | PASS | `named_relations_pair_by_name`, fixture 12 |
| | Named relation with no matching counterpart | PASS | `named_relation_with_no_counterpart_is_reported`; fixture 13 golden confirms exact message; `pair_relations` phase-2 provably excludes named-but-unmatched holders from implicit fallback |
| Inverse populated with real FK/ref data | — | PASS | `single_unnamed_relation_pairs_implicitly` asserts `posts.fk_columns == author.fk_columns`; confirmed at JSON level |
| Ambiguous unnamed sets are hard error | Two unnamed relations to same target | PASS | `two_unnamed_relations_to_the_same_target_are_ambiguous`, fixture 13 Post/User pair |
| | Error names the remedy | PASS | message includes `Disambiguate with @relation("Name", ...) on both sides.` |

### relation-validation (MODIFIED delta)

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| Ambiguous unnamed pairing is a validation error | Two unnamed FK-holding relations | PASS | fixture 13 Post/User: `remaining_fk=2, remaining_inverse=1` → ambiguous |
| | Naming one side is not sufficient (partial naming) | PASS | fixture 13 Comment/User group — hand-traced: name-match consumes 0, remaining counts trigger both the ambiguity AND the unresolved-name diagnostic. Deepest spec requirement; genuinely fires, not just the trivial all-unnamed case. |
| Unresolvable named relation is a validation error | Relation name has no counterpart | PASS | same evidence — message includes name + both model names |
| Explicit one-to-many unaffected | Explicit FK-holding relation valid | PASS | fixture 12's `Profile.user` (unnamed, unique target) — zero validation errors |
| | Valid when disambiguated by name | PASS | fixture 12's `PostAuthor`/`PostReviewer` pair — zero validation errors |

## Design coherence

- Three additive edits as designed: `resolve.rs` (`pair_relations`, two-phase: name-match then implicit), `ir.rs` (`relation_name`, `inverse: Option<bool>`), `validate.rs` (`validate_relation_ambiguity` mirroring the same algorithm read-only).
- `validate_relation_args` relaxation: exactly one positional STRING allowed; a second positional or non-string positional keeps the verbatim original message.
- `ir.ts` mirror: `relationName?: string; inverse?: true` — documented, deliberate, harmless deviation from design's `inverse?: boolean`. Only two call sites read `.inverse` (Studio's `getRelationDetail` + its test), both truthy checks. Rust's `Option<bool>` never serializes `false` either, so the stricter TS type is more accurate, not weaker.
- Studio's `getRelationDetail` fix covers all three relation shapes (FK-holding-with-columns, FK-holding-bare-reference, inverse-side); `inverse: true` is only ever written alongside non-empty `fkColumns` in `resolve.rs`, so "inverse + empty fkColumns" is unreachable — no missed case.
- `08-self-relation.indigo` confirmed unaffected (dedicated regression test + source: one FK leg only, no inverse counterpart).
- Golden snapshot scope: 05 deliberately changed (per design), plus new fixtures 12/13. `01-cli-template.json` and `02-studio-initial.json` ALSO changed — not explicitly called out in the original design/apply-progress, but traced and confirmed as the correct, expected effect of implicit pairing now populating previously-empty inverse `fkColumns`/`refColumns` on pre-existing single-relation fixtures. In-scope, correct, not drift.

## Issues

**CRITICAL**: None.

**WARNING**:
1. Task 6.6 (commit rebuilt WASM artifact) was unchecked at verify time — nothing committed/pushed yet. Blocked nothing functionally; resolved by the orchestrator's commit/PR step immediately following this verify pass.

**SUGGESTION**:
1. Document the 01/02 golden snapshot changes explicitly in the PR description — correct, but not called out in the original apply-progress; a reviewer scanning only "05 + 12/13" could be surprised.
2. Add an explicit "inverse + empty fkColumns" defensive test in `relations.test.ts` to future-proof against a resolver regression silently producing a malformed inverse-side render (currently unreachable only by resolver invariant, not by an assertion).

## Final Verdict: PASS WITH WARNINGS

Scope confirmed to match `design.md` and `proposal.md` exactly: `include`/`select`/`_count` (`relations-include-select`) correctly out of scope and untouched; `RelationType::ManyToMany` correctly still unreachable; the self-relation many-to-many false positive correctly left untouched per the design's explicit non-goal.
