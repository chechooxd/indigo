# Verification Report: native-type-attributes (FULL CHANGE — PR A + PR B)

## Mode
Full artifacts present: proposal.md, design.md, 3 spec files (native-type-attributes, attribute-validation delta, migration-ddl-ordering delta), tasks.md. Full verification performed.

## Task Completeness
- Live-grepped `tasks.md`: 48 real task checkboxes, all `[x]` (19 PR A + 29 PR B).
- 1 additional `[ ]` line exists: the `FOLLOW-UP` note under "Known Follow-up (explicitly deferred, not silently dropped)" — this is explicitly NOT a task (no phase/unit ID, documents `migrate.ts::alterColumn`'s deferred `nativeType`-diff follow-up per proposal Success Criteria / design's Migration/Rollout section). Confirmed present and correctly worded — not a silently-dropped requirement.
- Note: apply-progress memory (#588) states "52/52 tasks (18 PR A + 34 PR B)" — this count does not match the live file (48 = 19+29). The file is ground truth and is 100% complete; this is a bookkeeping discrepancy in the apply-progress memory only, not a code/coverage gap (SUGGESTION, not blocking).

## Toolchain Re-run (fresh, this session)
| Command | Result |
|---|---|
| `cd crates && cargo test` | 64/64 passed (30 lib unit + 33 fixture-corpus + 1 panic-fuzz), 0 failed |
| `pnpm --filter @indigodb/compiler build:wasm` | rebuilt cleanly |
| `node packages/compiler/test/regen-snapshots.mjs` | 15 snapshots written; `git status --porcelain fixtures/` shows ONLY 14 and 15 changed (both untracked since never committed) — 01-13 show zero diff |
| `pnpm --filter @indigodb/compiler test` (parity) | all green, incl. fixtures 14 + 15 + 3 error fixtures |
| `pnpm --filter @indigodb/migrator test` | all green: 13 golden fixtures (incl. new `native-type-override`) + `native-type.mjs` (5 unit) + appliability (pglite) + replay-from-zero |
| `pnpm test --force` (full monorepo, all 16 packages) | 16/16 successful |
| `pnpm build --force` | 10/10 successful |
| `pnpm lint --force` | 18/18 successful |

## Spec Compliance Matrix

### native-type-attributes (new capability)
| Scenario | Test | Status |
|---|---|---|
| Namespaced attribute with arguments | `parser.rs::namespaced_attribute_with_arguments_yields_namespace_and_name` | PASS |
| Namespaced attribute without arguments | `parser.rs::namespaced_attribute_without_arguments_yields_namespace_and_name` | PASS |
| Non-namespaced attribute unaffected | `parser.rs::non_namespaced_attribute_has_no_namespace` | PASS |
| Existing fixtures serialize unchanged | fixtures 01-13 byte-identical (regen diff = zero) | PASS |
| New fixture serializes namespace key | fixture 14 golden shows `"namespace":"db"` | PASS |
| Resolving field with native type override | `resolve.rs` unit tests (1-arg/2-arg/0-arg) + fixture 14 `nativeType` populated | PASS |
| Resolving field without override | `resolve.rs` absent-case test + `ir.rs` `skip_serializing_if` omission test | PASS |

### attribute-validation (delta)
| Scenario | Test | Status |
|---|---|---|
| Unknown field attribute | pre-existing `unrecognized_and_misarged_attributes_are_rejected` (fixture corpus) | PASS |
| Unknown model attribute | same | PASS |
| Recognized native type attribute | `validate.rs::db_namespace_recognized_names_on_compatible_scalars_are_admitted` | PASS |
| Unknown native type name | `validate.rs::db_namespace_unknown_name_is_rejected` | PASS |
| Unknown namespace | `validate.rs::non_db_namespace_is_rejected_like_an_unknown_attribute` | PASS |
| Native type on incompatible scalar | `validate.rs::db_namespace_scalar_mismatch_is_rejected` | PASS |
| Native type on compatible scalar | `validate.rs::db_namespace_compatible_scalar_produces_no_diagnostic` | PASS |
| Pre-existing corpus unaffected | fixtures 01-13 zero-diff, confirmed both PR A regen AND PR B regen | PASS |
| New accepted-syntax fixture | fixture 14 golden `validation: []`, `nativeType` populated | PASS |
| New rejected-case fixture | fixture 15 golden — both `db.Foo` and scalar-mismatch diagnostics asserted | PASS |
| (bonus, covered) arity mismatches, enum/relation rejection | `db_namespace_arity_mismatches_are_rejected`, `db_namespace_on_enum_or_relation_field_is_rejected` | PASS |

### migration-ddl-ordering (delta)
| Scenario | Test | Status |
|---|---|---|
| Column with native type override | `native-type.mjs` unit + `native-type-override` golden fixture CREATE TABLE | PASS |
| Zero-arg native type override | `native-type.mjs::"Uuid with zero args renders bare UUID, no parens"` | PASS |
| Column without override (regression) | `native-type.mjs::"column without nativeType renders exactly as mapScalarToPg today"` | PASS |
| Versioned migration ADD COLUMN honors override | `native-type-override/expected.json` — `ALTER TABLE "User" ADD COLUMN "bio" VARCHAR(255);` confirmed in `migrationSql` | PASS |

## Critical Correctness Points (design-flagged)

1. **get_attr/has_attr namespace-blind guard** — CONFIRMED in `ast.rs`: both functions filter `a.namespace.is_none()` before matching by name; `has_attr_ignores_namespaced_attribute_of_the_same_name` unit test proves `@db.map` does not satisfy `has_attr(attrs, "map")`. PASS.
2. **i64-arg-formatting fix** — CONFIRMED in `resolve.rs::format_native_type_arg`: `if value.fract() == 0.0 && value.is_finite() { (value as i64).to_string() } else { value.to_string() }`. Fixture 14's regenerated golden shows args `"255"`, `"10"`, `"2"` — never `"255.0"`. PASS.
3. **IDENTITY wins over nativeType in postgres.ts renderColumn** — CONFIRMED: branch order is `autoincrement → nativeType → mapScalarToPg` fallback, with an explanatory comment. Regression test `native-type.mjs::"autoincrement AND nativeType both present: IDENTITY wins, override is ignored"` passes. The golden fixture's `id Int @id @default(autoincrement())` column with `bio String? @db.VarChar(255)` also exercises this in practice (id renders as IDENTITY, bio as VARCHAR). PASS.
4. **Fixture 14 dual-regen, sole multi-regen fixture** — CONFIRMED: fixture 14's snapshot is empty of `nativeType` conceptually in PR A intent and now (after both PRs applied) shows `nativeType` populated for id/bio/price. `git status --porcelain fixtures/` after a fresh full regen this session shows ONLY fixtures 14 and 15 as changed/untracked; fixtures 01-13 are absent from the status output entirely — i.e. byte-identical, confirmed across the current (post-PR-B) state. Since PR A and PR B are both already merged into this working tree (uncommitted), this run verifies the end state is correct; the task-level historical claim (regenerated once empty, once populated) is corroborated by tasks.md B6.2's explicit note and apply-progress's "Snapshot Diff Scope" section, which this session's fresh regen reproduces exactly (only 14/15 differ, 01-13 zero-diff). PASS.

## Design Coherence
All File Changes / Interfaces / branch-ordering / field-ordering decisions in design.md were checked directly against source and match exactly (confirmed also in apply-progress's "Deviations from Design: None", corroborated by this session's direct source reads of `ast.rs`, `resolve.rs`, `postgres.ts`). No deviations found.

## Known Follow-up Documentation Check
CONFIRMED: `tasks.md`'s "Known Follow-up" section explicitly documents that `migrate.ts::alterColumn`/`diffResolved` does not diff a changed `nativeType` between schema versions, citing proposal Success Criteria and design's Migration/Rollout section as the source of the deferral decision. This is NOT silently dropped — it is flagged for reviewers by design.

## Issues

**CRITICAL**: None.

**WARNING**: None.

**SUGGESTION** (1):
- apply-progress memory (#588) states task totals as "52/52 (18 PR A + 34 PR B)"; the live `tasks.md` file actually contains 48 real task checkboxes (19 PR A + 29 PR B), all complete. Cosmetic bookkeeping mismatch only — does not affect correctness, coverage, or completeness. Recommend correcting the count in future apply-progress summaries for this change if referenced again.

## Verdict

**PASS** — whole-change (PR A + PR B) verification. 0 CRITICAL, 0 WARNING, 1 SUGGESTION (cosmetic task-count bookkeeping mismatch in a prior memory artifact, not in tasks.md itself). All 48 real tasks complete and verified against code. All spec scenarios across all 3 capabilities have passing covering tests, re-run fresh this session. All 4 design-flagged critical correctness points confirmed directly in source with passing regression tests. Fixtures 01-13 confirmed byte-identical across the full toolchain re-run. The `migrate.ts` alterColumn deferral is properly documented as a known, non-silent follow-up. Ready for `sdd-archive`.
