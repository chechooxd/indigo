```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:2212a8c9d79be46c2c87aadc753653a1d2f52e3c370df08c90ae51831aeb1ee9
verdict: fail
blockers: 0
critical_findings: 1
requirements: 20/20
scenarios: 35/38
test_command: cd crates && cargo test
test_exit_code: 0
test_output_hash: sha256:e27595a227bb810b4dd6fac26e0013d367f29d2975214e630a62bc37f8d3232d
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:f5d2cb048667b92ce21585b27d31dab3975f9c72b49a84a7903cc4a3702c796a
```

## Verification Report

**Change**: fix-compiler-correctness
**Version**: N/A (first spec set for these 7 capabilities)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 36 numbered (41 checkbox lines incl. sub-bullets) |
| Tasks complete | 36 / 41 (100%) |
| Tasks incomplete | 0 |

All three phases (`5d8d61c`, `4e5ac52`, `56740d2`) on branch `fix/compiler-schema-validation`, stacked on `main`@`55ed913` per the `stacked-to-main` chain strategy. Nothing pushed, no PR open — confirmed intentional, not a finding.

### Build & Tests Execution (independently re-run, non-cached)

**`cd crates && cargo test`**: ✅ 22 passed (4 `rules.rs` unit + 18 `tests/fixtures.rs`), 0 failed, 0 ignored
```text
running 4 tests
test rules::tests::maps_every_domain_value ... ok
test rules::tests::attribute_rule_distinguishes_targets ... ok
test rules::tests::default_literal_matches_checks_scalar_type ... ok
test rules::tests::rejects_unknown_and_lowercase_values ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 18 tests
[all_recognized_escapes_decode, lexer_errors_do_not_suppress_parser_errors,
 unknown_escape_sequence_is_an_error, illegal_char_error_points_at_line,
 enum_value_map_reaches_resolved_members, bare_on_update_reaches_the_foreign_key,
 absent_referential_actions_stay_absent, bare_on_delete_reaches_the_foreign_key,
 quoted_on_delete_matches_bare_form, strings_are_unescaped,
 datasource_provider_duplicates_and_generator_are_validated,
 invalid_referential_action_values_are_rejected, valid_default_forms_stay_clean,
 unrecognized_and_misarged_attributes_are_rejected,
 implicit_many_to_many_is_rejected_but_explicit_shapes_are_not,
 error_fixtures_report_errors, corpus_validation_errors_are_unchanged_by_new_rules,
 valid_fixtures_compile] ... ok (all 18)
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

Doc-tests indigo_compiler: 0 passed; 0 failed
```

**`pnpm test`** (`--force`, non-cached): ✅ all green — 5 fixtures × 4 checks (parse/AST/ResolvedSchema/ValidationError[]) + 3 error fixtures, zero golden diff
```text
regression: 5 fixtures vs golden snapshots — 20/20 ok
regression: 3 error fixtures — 3/3 ok
regression: all green
Tasks: 11 successful, 11 total  (0 cached, 11 total — forced fresh run)
```

**`pnpm build`** (`--force`): ✅ 10/10 tasks, 0 cached
**`pnpm lint`** (`--force`): ✅ 18/18 tasks, 0 cached

**Coverage**: Not available — no coverage tool detected in this Rust/TS mixed toolchain (informational, not blocking per strict-tdd-verify.md).

### WASM Artifact Sync Check (structurally-undetectable drift risk)

Rebuilt via `pnpm --filter @indigodb/compiler build:wasm` against the exact committed Rust source at HEAD.

- SHA-256 of committed `packages/compiler/wasm/indigo_compiler_bg.wasm` **before** rebuild: `518f786a4cbbeaa580202dcc5595e49f4992d5225e040791a2ec2ba25796abe1`
- SHA-256 **after** rebuild: `518f786a4cbbeaa580202dcc5595e49f4992d5225e040791a2ec2ba25796abe1` — **identical**
- `git status --porcelain -- packages/compiler/wasm/` → empty (no diff)

**Verdict: NOT stale.** The committed artifact is byte-for-byte reproducible from `crates/` at this commit with the pinned `wasm-pack`/`wasm-opt` toolchain versions in this environment. This is evidence of reproducibility, not a formal cross-machine determinism proof — a different `wasm-opt`/Rust toolchain version could still produce different bytes for the same source; that risk is orthogonal to "is this specific commit's artifact stale," which is what was checked and disproved.

### Tracked Incompletenesses Check

Both required items are documented, not silent:
1. `ForeignKey.onUpdate` reaches the IR (`crates/indigo-compiler/src/ir.rs:58-62`, `packages/core/src/ir.ts:69-77`) but emits no `ON UPDATE` DDL — named in `release-notes.md` ("Tracked incompletenesses") and `apply-progress` (Phase 2 section), both pointing to `fix-migrator-correctness` as the owner.
2. Enum `members` reaches the IR (`ir.rs:123-133`, `ir.ts:145-155`) but `packages/migrator`/`packages/generator`/`apps/studio` still read `values` only — same two locations, same owner.

Both confirmed present in the actual `release-notes.md` file on disk (not just claimed). ✅ COMPLIANT.

### Scope Leak Check

`git diff --stat 55ed913 HEAD -- packages/migrator packages/generator packages/client apps/studio packages/cli packages/ast` → **empty**. Confirmed zero changes outside the compiler crate, `packages/compiler/wasm/`, `packages/core/src/ir.ts` (in-scope IR mirror), fixtures, and `openspec/`. ✅ COMPLIANT.

### Release Note Check

`openspec/changes/fix-compiler-correctness/release-notes.md` (41 lines) lists every new rejection class as a table, explicitly naming `@@id([a, b])`, `@updatedAt`, and `@@ignore` as former silent no-ops now hard errors, plus unknown/misapplied attributes, unknown `@relation` args, invalid/lowercase referential actions, implicit many-to-many, bad/absent/duplicate datasource provider. Independently confirmed programmatically: `@@id`/`@updatedAt`/`@@ignore` are absent from `rules::ATTRIBUTE_RULES` (verified by reading `rules.rs`), so they fall through to the generic unknown-attribute rejection path — the release note's claim is accurate. ✅ COMPLIANT.

### Spec Compliance Matrix

**referential-actions** (2 requirements, 6 scenarios — 6/6 compliant)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Bare/quoted onDelete/onUpdate accepted identically | Bare onDelete reaches FK | `tests/fixtures.rs::bare_on_delete_reaches_the_foreign_key` | ✅ COMPLIANT |
| " | Quoted onDelete reaches FK | `::quoted_on_delete_matches_bare_form` | ✅ COMPLIANT |
| " | Bare onUpdate reaches FK | `::bare_on_update_reaches_the_foreign_key` | ✅ COMPLIANT |
| " | Absent referential action stays absent | `::absent_referential_actions_stay_absent` | ✅ COMPLIANT |
| Referential action validated against fixed domain | Invalid referential action value | `::invalid_referential_action_values_are_rejected` | ✅ COMPLIANT |
| " | Case-sensitive rejection | `::invalid_referential_action_values_are_rejected` (lowercase `cascade` case) | ✅ COMPLIANT |

**attribute-validation** (4 requirements, 8 scenarios — 8/8 compliant)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Known-attribute whitelist per target | Unknown field attribute | `::unrecognized_and_misarged_attributes_are_rejected` (`@uniqe`) | ✅ COMPLIANT |
| " | Unknown model attribute | same test (`@@deafult`) | ✅ COMPLIANT |
| Attribute arity checked | Extra argument on zero-arity | same test (`@id("x")`) | ✅ COMPLIANT |
| " | Missing argument on one-arity | same test (`@map()`) | ✅ COMPLIANT |
| Attribute argument types checked | String default on Int field | same test (`@default("nope")`) | ✅ COMPLIANT |
| " | Valid function default accepted | `::valid_default_forms_stay_clean` (`autoincrement()`) | ✅ COMPLIANT |
| " | Enum reference default accepted | same test (`status Status @default(ACTIVE)`) | ✅ COMPLIANT |
| Existing fixture corpus remains valid | Corpus regression check | `::corpus_validation_errors_are_unchanged_by_new_rules` (approval test, all 5 fixtures) | ✅ COMPLIANT |

**relation-validation** (3 requirements, 4 scenarios — 4/4 compliant)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Implicit m-n is a validation error | Reciprocal list fields, no explicit FK | `::implicit_many_to_many_is_rejected_but_explicit_shapes_are_not` | ✅ COMPLIANT |
| " | Diagnostic names remedy | same test (asserts "explicit join model" in message) | ✅ COMPLIANT |
| Explicit one-to-many unaffected | Explicit FK-holding relation valid | same test (`one_to_many` sub-case) | ✅ COMPLIANT |
| Explicit join model is a valid remedy | Explicit join model compiles clean | same test (`join_model` sub-case) | ✅ COMPLIANT |

**compiler-diagnostics** (3 requirements, 5 scenarios — 4/5 compliant, 1 partial)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Lexer errors no longer short-circuit parsing | Illegal char + syntax error, same file | `::lexer_errors_do_not_suppress_parser_errors` | ✅ COMPLIANT |
| " | Illegal char alone still reports correctly | `::illegal_char_error_points_at_line` + `::error_fixtures_report_errors` | ✅ COMPLIANT |
| 1-based line/column on lexer/parser diagnostics | Parser error position | `::error_fixtures_report_errors` (generic `line >= 1` only) + `::lexer_errors_do_not_suppress_parser_errors` (coarse `line >= 4` threshold) | ⚠️ PARTIAL — no test pins an *exact* line/column for a pure missing-`}` parser error, unlike the exact-value pins used for lexer/escape errors. Pre-existing property (spec text: "already true of CompilerError"), not new behavior — low risk, but the assertion is looser than the pattern used elsewhere in this same PR |
| " | Semantic diagnostics remain positionless | N/A — structurally guaranteed: `ValidationError` (`ir.rs:155-162`) has no `line`/`column` fields at all | ✅ COMPLIANT (type-level guarantee, no dynamic test needed) |
| Committed WASM stays in sync with `crates/` source | Rebuilt artifact passes both suites | Verified directly by this verify pass (see WASM Artifact Sync Check above) — not by a project test | ✅ COMPLIANT |

**string-literals** (3 requirements, 6 scenarios — 6/6 compliant)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Recognized escapes decoded | Escaped quote decodes correctly | `::strings_are_unescaped` | ✅ COMPLIANT |
| " | Escaped backslash decodes to one backslash | `::all_recognized_escapes_decode` | ✅ COMPLIANT |
| " | Newline/CR/tab escapes decode | `::all_recognized_escapes_decode` | ✅ COMPLIANT |
| Unknown escape is a diagnostic | Unknown escape sequence rejected | `::unknown_escape_sequence_is_an_error` (pins exact line 1 / column 31) | ✅ COMPLIANT |
| Regression suites reflect corrected unescaping | Inverted Rust test | `quirk_strings_are_not_unescaped` confirmed renamed/replaced by `strings_are_unescaped` (`rg` found zero remaining references to the old name) | ✅ COMPLIANT |
| " | Regenerated golden snapshot | `git diff 55ed913 HEAD -- fixtures/snapshots/03-quirks-values.json` shows the decoded value (`"say \"hi\" \\ done"`) replacing the double-escaped raw form | ✅ COMPLIANT |

**enum-value-mapping** (2 requirements, 4 scenarios — 2/4 compliant, 2 UNTESTED)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| `@map` reaches IR as `dbName` | Mapped enum value | `::enum_value_map_reaches_resolved_members` | ✅ COMPLIANT |
| " | Unmapped enum value defaults to own name | same test (`INACTIVE`) | ✅ COMPLIANT |
| `@map` on enum value is subject to attribute-validation | Wrong-arity map on enum value | **none found** | ❌ UNTESTED |
| " | Wrong-type map on enum value | **none found** | ❌ UNTESTED |

**datasource-validation** (3 requirements, 5 scenarios — 5/5 compliant)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| `provider` accepts only `"postgresql"` | Valid provider | `::corpus_validation_errors_are_unchanged_by_new_rules` (fixtures 01/03 both declare `provider = "postgresql"` and assert zero/unrelated-only errors) | ✅ COMPLIANT (indirect, via approval test) |
| " | Unsupported provider | `::datasource_provider_duplicates_and_generator_are_validated` (`mysql` case) | ✅ COMPLIANT |
| " | Missing provider | same test (`missing_provider` case) | ✅ COMPLIANT |
| Only one datasource block allowed | Duplicate datasource blocks | same test (`duplicate` case) | ✅ COMPLIANT |
| `generator.provider` out of scope | Generator provider untouched | same test (asserts no error mentions `"indigodb-client-ts"`) | ✅ COMPLIANT |

**Compliance summary**: 35/38 scenarios directly COMPLIANT, 1/38 PARTIAL, 2/38 UNTESTED (35 + 1 + 2 = 38; 20/20 requirements have at least one covering scenario/test, but 1 requirement — "`@map` on enum value is subject to attribute-validation" — has zero of its two scenarios tested).

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| `rules.rs` single source of truth (design decision 1) | ✅ Implemented | Both `resolve.rs::resolve_action` and `validate.rs::validate_relation_args` read the same `rules::action_sql`/`REFERENTIAL_ACTIONS`; both `resolve.rs` and `validate.rs` read `rules::ATTRIBUTE_RULES` via `attribute_rule()` |
| IR carries SQL-ready referential-action text (decision 2) | ✅ Implemented | `rules::REFERENTIAL_ACTIONS` maps `SetNull→"SET NULL"`, `NoAction→"NO ACTION"`, etc.; `ir.ts` doc comment amended to state the verbatim-interpolation contract |
| Escape decoding in `lexer.rs`, not `parser.rs` (decision 3) | ✅ Implemented | `lexer.rs::unescape()`; both `raw[1..len-1]` slices removed from `parser.rs` (confirmed via `rg`) |
| `ResolvedEnum.members` additive, `values` unchanged (decision 4) | ✅ Implemented | `ir.rs:123-133`; `values` consumers untouched (confirmed no changes outside compiler scope) |
| New TS mirror keys optional (decision 5) | ✅ Implemented | `ir.ts`: `onUpdate?: string`, `members?: ResolvedEnumMember[]` |
| Lexer-then-parser error ordering (decision 6) | ✅ Implemented | `lib.rs::parse_source` — `lex_errors.extend(parse_errors)` |
| `onUpdate` resolved+validated, no DDL (decision 7) | ✅ Implemented, tracked | Confirmed in release note + apply-progress |
| Datasource `provider` validated only when block exists (decision 8) | ✅ Implemented | `validate_datasources` only loops `schema.datasources`; fixtures 04/05 (no datasource block) stay clean, confirmed by approval test |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| Attribute whitelist table (design's derivation table) | ✅ Yes | `rules::ATTRIBUTE_RULES` matches the design doc's table exactly, field-by-field |
| Message shape `<what is wrong>. <remedy>.` | ⚠️ Partial | Generic unknown-attribute messages dropped the "Known X attributes: ..." enumeration shown in the design doc's illustrative example — **self-documented deviation** in `apply-progress` ("Deviations from design" #2), done under line-budget pressure. `@relation`'s named-arg whitelist keeps the enumeration as the spec explicitly requires it there. Not a spec violation (spec only requires naming model/field + the unrecognized attribute) |
| Diagnostics architecture (positionless semantic errors) | ✅ Yes | `ValidationError` has no span fields; matches design diagram exactly |
| Review budget / slicing (3 PRs) | ✅ Yes, with disclosed overrun | Slice 3 measured at 557 changed lines vs 520 target ceiling — independently re-measured via `git diff --shortstat 4e5ac52..56740d2 -- . ':!packages/compiler/wasm'` → **533 insertions + 24 deletions = 557**, confirms the self-reported number exactly. Per launch prompt, already accepted by a maintainer — not re-litigated here |

### Issues Found

**CRITICAL** (1):
1. **`enum-value-mapping` requirement "`@map` on enum value is subject to attribute-validation" has zero covering tests for either of its two spec scenarios** (wrong-arity `@map()`, wrong-type `@map(1)` on an enum value). Confirmed by exhaustive search of `tests/fixtures.rs` — the only `@map()`-arity test (`unrecognized_and_misarged_attributes_are_rejected`) exercises the FIELD target, not the ENUM-VALUE target; `enum_value_map_reaches_resolved_members` only tests the happy path. Code-inspection note (mitigating, not exculpatory): `validate_attributes`'s enum-value loop (`validate.rs:213-223`) dispatches through the same generic `attribute_rule()`/`check_shape()` functions already proven correct for the field-level case, so the implementation is very likely correct — but per Strict TDD, an untested spec scenario is a genuine RED-phase gap regardless of how confident static reading makes us. No RED test was written for this scenario before/during implementation (absent from the Phase 3 TDD Cycle Evidence table in `apply-progress`, which only lists 3.1–3.8, none targeting enum-value `@map`). **Remediation is narrow**: add 2 assertions (or one test with both cases) exercising `enum Status { ACTIVE @map() }` and `enum Status { ACTIVE @map(1) }` through `validate_src`; no production code change is expected to be needed.

**WARNING** (2):
1. **`apply-progress`'s Phase 3 TDD evidence overstates the final test count.** It states `cargo test`: "26/26 passing (4 rules.rs unit tests + 22 tests/fixtures.rs ... net cargo test count 14 → 26)". Independently re-run twice (once via `pnpm`-adjacent rebuild, once via a fresh `cargo test` piped to a hashed file): actual is **4 + 18 = 22**, not 26. The GREEN verdict itself is correct and independently reproduced (22/22 passing) — only the reported total is wrong. This doesn't change any functional finding but is a factual inaccuracy in the audit trail Strict TDD relies on.
2. **Hybrid artifact-store desync**: `openspec/changes/fix-compiler-correctness/tasks.md` (the OpenSpec mirror) was not fully re-synced to the final Engram revision. It cites commit `877205d` for Phase 2 in its "Branch ... Commit:" line, but `877205d` is confirmed via `git fsck --unreachable` to be a **dangling, unreachable commit object** — the actual Phase 2 commit on the current branch chain is `4e5ac52` (which the Engram copy correctly states). The OpenSpec file's "Chain strategy" fields (top-of-file forecast table and the `Chain strategy: pending` line) also still say "pending — orchestrator selects" instead of the resolved `stacked-to-main` that Engram's copy (revision 4) records. Does not affect shipped code; does affect provenance/audit-trail accuracy for anyone reading only the filesystem mirror.

**SUGGESTION** (1):
1. `compiler-diagnostics`'s "Parser error position" scenario is covered only by a generic `line >= 1` check and a coarse `line >= 4` threshold, not an exact-value pin — inconsistent with the exact-value pins used for the lexer/escape-error tests in the same file (`illegal_char_error_points_at_line` asserts `== 3`; `unknown_escape_sequence_is_an_error` asserts `== 1`/`== 31`). Low risk since this property predates this change (spec text: "already true of `CompilerError`"), but tightening would raise regression-detection confidence to match the rest of the suite.

### Verdict

**FAIL** — one CRITICAL finding (untested spec scenario pair under `enum-value-mapping`) blocks archive-readiness per Strict TDD's "a spec scenario is compliant only when a covering test passed at runtime" rule. All code, both independently-verified fresh gate runs, the WASM sync check, scope boundaries, tracked-incompleteness documentation, and the release note are otherwise clean. This is a narrow, mechanically-scoped gap (2 missing assertions, code path already shared with a tested case) — not evidence of a broken feature. Recommended path: route back to `sdd-apply` for a minimal, test-only addition (no expected production-code change), then re-run `sdd-verify`.

