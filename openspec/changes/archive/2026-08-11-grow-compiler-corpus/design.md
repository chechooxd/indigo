# Design: Grow the Compiler Corpus and Add Property-Based Parser Testing

## Technical Approach

Two independent, additive test surfaces. Neither touches `crates/indigo-compiler/src/`, so the
committed WASM artifact is unchanged and `build:wasm` is not required.

1. **Corpus growth** — six new single-purpose top-level fixtures under `fixtures/`, each with a
   generated golden in `fixtures/snapshots/` and a hand-authored entry in
   `corpus_validation_errors_are_unchanged_by_new_rules`.
2. **Panic safety** — `proptest` as a dev-dependency plus one new integration test binary
   `crates/indigo-compiler/tests/parser_panic.rs`.

Capability naming is **`parser-panic-safety`** throughout (superseding the proposal's
`parser-panic-freedom`); the spec directory already uses it.

## Scope Boundary: what "never panics" covers

The spec's requirement wording names **`parse_source` only** — lexer plus parser, pre-resolution.
`resolve`/`validate` panic-safety is **not** in this change. The proposal's "and ideally
`resolve`/`validate`" is deliberately narrowed to match the spec. Existing coverage already
exercises resolve/validate non-panic over the corpus (`valid_fixtures_compile` calls both), so the
gap the property test closes is specifically adversarial *parser* input.

## Fixture Plan

Every addition is a **NEW top-level file**, never an addition to `03-quirks-values.indigo`.

**Decision — new files over growing `03`.** `03` is already 53 lines and multi-purpose, and its
golden JSON is the largest in the corpus. The golden diff *is* the review artifact
(`regen-snapshots.mjs` header), so folding new shapes into `03` produces a large entangled diff
where unrelated AST/IR movement hides inside intended movement. Single-purpose fixtures keep each
golden diff readable and keep expected-message table entries one-to-one with intent. Cost: corpus
count 5 → 11 valid fixtures; harness runtime impact is negligible (in-process WASM per file).

| File | New/Modified | Adds | Expected `ValidationError[]` |
|------|--------------|------|------------------------------|
| `fixtures/06-scalar-types.indigo` | NEW | One table with all 9 `SCALAR_TYPES` (closes the verified `BigInt`/`Bytes` gap), plus list and optional forms | `[]` |
| `fixtures/07-referential-actions.indigo` | NEW | Five relation legs covering `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction`; one leg in quoted form | `[]` |
| `fixtures/08-self-relation.indigo` | NEW | `Category.parent`/`children` self-referencing FK | `[]` |
| `fixtures/09-rejected-composite-id.indigo` | NEW | `@@id([a, b])` on a model with no field-level `@id` | Unknown model attribute `@@id` + `Model "…" has no @id primary key.` |
| `fixtures/10-rejected-updated-at.indigo` | NEW | `updatedAt DateTime @updatedAt` on a table with a valid `@id` | Unknown field attribute `@updatedAt` |
| `fixtures/11-rejected-ignore.indigo` | NEW | `@@ignore` on a table with a valid `@id` | Unknown model attribute `@@ignore` |
| `fixtures/snapshots/06–11.json` | NEW (generated) | Golden `schema`/`resolved`/`validation` | — |

`09`–`11` are separate files because the spec requires a **dedicated** fixture per rejected
attribute; they live under `fixtures/`, not `fixtures/errors/`, because they must *parse cleanly*
and `fixtures/errors/` asserts parse failure.

**Enum `@map`**: confirmed already covered end-to-end by `03-quirks-values.indigo:16` and its
golden's `resolved.enums[].members[].dbName`. Per the spec, **no duplicate fixture is created**.

**Not designed here**: new `fixtures/errors/` recovery fixtures and unknown-`@relation`-argument
fixtures. The proposal mentions both; the spec requires neither. Unknown `@relation` args stay
covered by `unrecognized_and_misarged_attributes_are_rejected`.

## Expected-Message Table: TDD Sequencing

**Decision — hand-written first (RED), then reconciled. Not derived-and-pinned.**

**Alternatives considered**: (a) run the compiler once and pin its output, matching how
`regen-snapshots.mjs` works; (b) hand-author from `validate.rs`'s `format!` strings, then
reconcile. **Rationale for (b)**: derive-and-pin cannot distinguish "correct message" from
"current message" — it laundres a latent defect into a golden, which is the exact failure class
this change exists to remove. Golden JSON regen stays mechanical because it is diff-reviewed
structure; the Rust table is the *human-authored oracle* and must not adopt the same shortcut.

Per fixture, in order:

1. Write the `.indigo` fixture. Run `cd crates && cargo test` → **RED**
   (`corpus_validation_errors_are_unchanged_by_new_rules` has no entry; `valid_fixtures_compile`
   asserts parse success).
2. Add the table entry with messages derived **by reading `validate.rs`'s `format!` templates**,
   not by running the compiler.
3. `cargo test` again.
4. On mismatch, classify explicitly:
   - expectation wrong → correct the table entry, note why;
   - compiler wrong → **STOP**, do not edit `crates/*/src/`, report as a finding (proposal rule).
5. Only after `crates` is green: build `packages/compiler`, run
   `node packages/compiler/test/regen-snapshots.mjs`, then `pnpm test`.
6. **Guardrail**: regen rewrites *all* snapshots. `git diff --stat fixtures/snapshots/` MUST show
   the original five goldens byte-identical; any movement there is unintended contract drift and
   stops the change.

## Proptest Design

**Location**: new file `crates/indigo-compiler/tests/parser_panic.rs`.
**Alternative rejected**: appending to `tests/fixtures.rs`. That file is deterministic and
corpus-driven; a randomized test with its own `ProptestConfig` and different runtime profile
belongs in its own integration binary so it can be run or timed alone
(`cargo test --test parser_panic`).

Strategy combinator tree:

```rust
const ATOMS: &[&str] = &[
    "Table", "enum", "datasource", "generator", "TableGroup",
    "{", "}", "[", "]", "(", ")", ",", ":", "=", "?",
    "@id", "@unique", "@map", "@note", "@default", "@relation",
    "@@id", "@@map", "@@index", "@@unique", "@@realtime", "@@ignore", "@updatedAt",
    "String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Bytes", "Decimal",
    "fields", "references", "onDelete", "Cascade", "env",
    "//", "~", "\\", "\"",
];

fn indigo_source() -> impl Strategy<Value = String> {
    let token = prop_oneof![
        8 => prop::sample::select(ATOMS).prop_map(String::from), // keywords/punct/attrs dominate
        3 => "[A-Za-z_][A-Za-z0-9_]{0,7}",                       // identifiers
        2 => "\"[A-Za-z0-9 \\\\\"]{0,8}\"",                      // string + escape bait
        1 => any::<i32>().prop_map(|n| n.to_string()),           // numbers
    ];
    let sep = prop::sample::select(&[" ", "\n", "  ", ""][..]);
    prop::collection::vec((token, sep), 1..=40)
        .prop_map(|ts| ts.into_iter().map(|(t, s)| t + s).collect())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]
    #[test]
    fn parse_source_never_panics(src in indigo_source()) {
        let _ = parse_source(&src); // returning a Result IS the contract
    }
}
```

No `catch_unwind`, no `unwrap` — a panic propagates and fails loudly, per spec. The unstructured
atoms (`~`, `\`, bare `"`) keep the lexer's illegal-character and escape paths reachable while the
8:3:2:1 weighting satisfies "biased toward `.indigo` token shapes, not uniform bytes".

**Case count: 256, written explicitly.** Justification: inputs are ≤40 tokens (≈300 bytes); the
crate's parser is a single-pass hand-written recursive descent with no I/O, so per-case cost is
microseconds and 256 cases is expected well under 100 ms — orders of magnitude below the crate's
compile time, which dominates `cargo test`. 256 coincides with proptest's own default, so the
design requires it be spelled out in `ProptestConfig` to stay an intentional, documented number if
that default ever changes. **Assumption to validate at apply time** (not measurable here):
if `cargo test` wall time grows by more than ~2s attributable to this test, drop to 128 and record
the measurement in the task notes.

Default `failure_persistence` is kept: on a failure proptest writes
`crates/indigo-compiler/proptest-regressions/parser_panic.txt`, which becomes the finding's
committed evidence. On a clean run no file is produced.

## If Proptest Finds a Real Panic — Mechanics

Policy is "report, do not fix". Mechanically:

1. proptest fails with the minimized input and writes the regression seed file.
2. Apply **stops at that task**. Zero edits under `crates/*/src/`.
3. Capture: minimized input string, panic message and source location, regression seed line.
4. Escalate to the orchestrator as its **own new finding** for a separate change; the panic-safety
   task in *this* change reports `blocked`, not `success`.
5. Already-green fixture work may still land; the property test does **not** land green.

**Rejected — `#[ignore]` the test with the failing input recorded.** In CI an `#[ignore]`d test is
indistinguishable from a deleted one, so the change would report success while shipping a known
parser-abort path — precisely the risk this capability exists to surface.
**Rejected — commit red.** A red suite blocks every unrelated future change.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `fixtures/06-scalar-types.indigo` … `11-rejected-ignore.indigo` | Create | Six single-purpose fixtures (see plan) |
| `fixtures/snapshots/06–11.json` | Create (generated) | Goldens via `regen-snapshots.mjs` |
| `fixtures/snapshots/01–05.json` | Unchanged | MUST be byte-identical in the diff |
| `crates/indigo-compiler/tests/fixtures.rs` | Modify | Six entries in the expected-message table |
| `crates/indigo-compiler/tests/parser_panic.rs` | Create | Property test + `Strategy` |
| `crates/indigo-compiler/Cargo.toml` | Modify | `[dev-dependencies] proptest = "1"` |
| `crates/Cargo.lock` | Modify (generated) | proptest + transitive dev deps |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Rust unit/integration | Every new fixture parses; validation messages match the hand-authored table | `cd crates && cargo test` |
| Property | `parse_source` never panics on `.indigo`-shaped input | `cargo test --test parser_panic`, 256 cases |
| Node regression | AST + `ResolvedSchema` + `ValidationError[]` match goldens | `pnpm test` (`parity.mjs`) |
| Contract guard | Original five goldens unchanged | `git diff --stat fixtures/snapshots/` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Test fixtures and a dev-only test dependency; no runtime code path.

## Sizing

Authored lines ≈ **145** (6 fixtures ≈ 70, table entries ≈ 12, `parser_panic.rs` ≈ 60, Cargo.toml
≈ 3). Generated goldens and `Cargo.lock` are excluded from the authored risk count. This is well
under both the 800-line review budget and the 400-line default. **A single slice suffices**; no PR
chaining is introduced.

## Migration / Rollout

No migration. `git revert` of the change commit restores the 8-file corpus; nothing published, no
WASM rebuild, no TS package output affected.

## Open Questions

- [ ] `proptest` must resolve under `add-ci-floor`'s offline/CI network policy on stable 1.93.1 —
      verify at apply time; if the lockfile cannot be populated offline, escalate rather than
      relaxing the policy.
- [ ] 256-case runtime is estimated, not measured (no measurement possible in the design phase);
      confirm during apply against the fallback of 128.
