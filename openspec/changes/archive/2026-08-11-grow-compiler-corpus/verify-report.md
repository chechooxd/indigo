# Verify Report: grow-compiler-corpus

**Mode**: full artifacts (proposal, design, spec x2, tasks) — Engram + OpenSpec hybrid
**Verdict**: **PASS WITH WARNINGS**

## Completeness

17/17 tasks in `tasks.md` are checked and independently confirmed against code
(not trusted from checkboxes alone): all six new fixtures exist, all six
expected-message table entries exist and match the compiler's actual output
byte-for-byte, `parser_panic.rs` exists in the correct integration-test
location, and `Cargo.toml`/`Cargo.lock` carry the `proptest` dev-dependency.

## Gate output (run fresh this session)

### `cd crates && cargo test`
```
running 4 tests (unit) ... 4 passed
running 19 tests (tests/fixtures.rs) ... 19 passed
running 1 test (tests/parser_panic.rs) ... 1 passed — parse_source_never_panics, 0.16s
Doc-tests: 0
```
24/24 total. Matches apply-progress's reported count.

### `pnpm test --force` (uncached)
16/16 tasks green. `node packages/compiler/test/parity.mjs` individually
confirmed: all 6 new fixtures (`06`–`11`) show `parses` / `AST` /
`ResolvedSchema` / `ValidationError[]` all `ok`, plus 3 error fixtures ok.

### `pnpm build --force`
10/10 tasks green, including `@indigodb/studio` (WASM asset unchanged,
`indigo_compiler_bg-CnVbSC3-.wasm` emitted from the committed artifact) and
`@indigodb/cli` `tsc`.

### `pnpm lint --force`
18/18 tasks green (`tsc --noEmit` across all packages).

### Scope/guardrails
- `git diff --stat 8c29e76..HEAD` (the change's own 3 commits, not the whole
  branch-vs-current-main diff, which is polluted by unrelated already-merged
  SDD changes): exactly `crates/Cargo.lock`, `crates/indigo-compiler/Cargo.toml`,
  `crates/indigo-compiler/tests/{fixtures.rs,parser_panic.rs}`,
  `fixtures/06-11-*.indigo`, `fixtures/snapshots/06-11-*.json`, and the
  `openspec/changes/grow-compiler-corpus/*` planning docs. **Zero** files under
  `crates/indigo-compiler/src/`, `packages/`, or `apps/`.
- `git diff --stat 8c29e76..HEAD -- crates/indigo-compiler/src/ packages/ apps/`
  → empty. Confirms the additive-test-surface claim directly, not by trusting
  the report.
- `git diff --stat main..HEAD -- fixtures/snapshots/01..05*.json` → empty
  (byte-identical, matches session's independently-reproduced finding).
- `git status packages/compiler/wasm/` → clean.
- `crates/indigo-compiler/proptest-regressions/` → does not exist (no panic
  recorded, consistent with the clean run).

## Requirement traceability

### `compiler-corpus-coverage`

| Requirement / Scenario | Test evidence | Status |
|---|---|---|
| Scalar type coverage — BigInt/Bytes exercised | `fixtures/06-scalar-types.indigo` (grepped: contains all 9 `SCALAR_TYPES` names verbatim, plus `String[]` list form and `String?` optional form) + `fixtures/snapshots/06-scalar-types.json` (`resolved.tables[0].columns` shows `bigNum:BigInt`, `raw:Bytes`, correct list/nullable flags) + `parity.mjs` green | PASS |
| Referential action coverage — all 5 reach DDL | `fixtures/07-referential-actions.indigo` (grepped: `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction` bare + one `"Cascade"` quoted) + golden inspected directly: `CASCADE/RESTRICT/SET NULL/SET DEFAULT/NO ACTION` all present on `foreignKeys[].onDelete`/`onUpdate` | PASS |
| Rejected-attribute fixtures — composite `@@id` | `fixtures/09-rejected-composite-id.indigo` + `fixtures.rs` table entry verified byte-exact against `validate.rs` format strings (`Unknown model attribute "@@id" on model "Membership".` / `Model "Membership" has no @id primary key.`) — read source, not trusted | PASS |
| Rejected-attribute fixtures — `@updatedAt` | `fixtures/10-...` + table entry verified against `validate.rs`'s field-location format (`Unknown field attribute "@updatedAt" on field "Widget.updatedAt".`) | PASS |
| Rejected-attribute fixtures — `@@ignore` | `fixtures/11-...` + table entry verified against model-location format | PASS |
| Self-relation coverage | `fixtures/08-self-relation.indigo`: `Category.parent Category? @relation(...)` — a field on `Category` referencing `Category`, exactly the spec's own example shape ("a field on `Table T` referencing `T`"). Golden confirms `foreignKeys: [{columns:[parentId], refTable:Category, refColumns:[id]}]`. Spec text does **not** require a reciprocal inverse array field — the dropped `children Category[]` leg is not part of the written requirement | PASS (see Note below) |
| Enum `@map` end-to-end confirmed | Read `fixtures/snapshots/03-quirks-values.json` directly: `enums[0].members[0] = {name:ACTIVE, dbName:active}` | PASS |
| New fixtures pinned in expected-message test | `crates/indigo-compiler/tests/fixtures.rs:302-314`, all 6 present; `cargo test` green | PASS |

**Note on self-relation (item 4 of the adversarial brief)**: the fixture-08
workaround does **not** silently under-cover the spec. The spec's own
scenario text only requires "a field on `Table T` referencing `T`" — it never
requires an inverse collection field. The dropped `children Category[]` leg
was the *design doc's* plan, not a spec requirement; dropping it to route
around the confirmed `validate_implicit_many_to_many` false positive leaves
the fixture fully compliant with the actual spec as written. This is a
correct, spec-preserving workaround, not scope erosion.

### `parser-panic-safety`

| Requirement / Scenario | Test evidence | Status |
|---|---|---|
| Panic-freedom property test | `parser_panic.rs::parse_source_never_panics` — ran fresh, 1/1 pass, 0.16s | PASS |
| Input strategy biased toward valid token shapes | Read `ATOMS` (46 entries: keywords, punctuation, all 9 scalar names, attribute names, relation-arg identifiers) and `token()`'s `prop_oneof![8 => atom(), 3 => identifier(), 2 => quoted_string(), 1 => number()]` directly from source — matches the design doc's stated weights exactly, not merely restated from it | PASS |
| Bounded, CI-reasonable case count | `#![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]` — literal, explicit, not the implicit default (which happens to also be 256, but the code spells it out per spec intent) | PASS |
| Found panic → reported, not fixed | N/A this run (no panic found); mechanism verified: no `catch_unwind`/`unwrap` in the test body, so a real panic would propagate and fail loudly | PASS (vacuously, correctly wired) |
| No panic found | `cargo test --test parser_panic` fresh: 1 passed, no `proptest-regressions/` directory produced, zero `crates/*/src/` edits (`git diff --stat 8c29e76..HEAD -- crates/indigo-compiler/src/` empty) | PASS |

File location check: `crates/indigo-compiler/tests/parser_panic.rs` is a
sibling of `fixtures.rs` under the `tests/` integration-test convention, and
`crates/Cargo.toml`'s `[workspace] members = ["indigo-compiler"]` includes the
one crate that owns it — `cargo test` discovers it as confirmed by the fresh
run listing `Running tests/parser_panic.rs`.

## Correctness spot-checks beyond the brief

- Verified the three pinned rejection messages are not approximations: read
  `validate.rs`'s `loc()`, `push_unknown()`, and the primary-key-count check
  directly and reconstructed each message by hand from the format strings —
  all three match the table entries character-for-character.
- Verified `SCALAR_TYPES` (9) and `REFERENTIAL_ACTIONS` (5) constants in
  `crates/indigo-compiler/src/{ast.rs,rules.rs}` against the fixture contents
  name-for-name, not just count-for-count.

## Design coherence

Design's fixture plan, TDD sequencing rationale, and proptest strategy
description all match the implementation as inspected directly. The one
deviation (fixture 08 dropping the inverse field) is documented in both
`tasks.md` and `apply-progress`, is consistent with the actual spec text (see
Note above), and required zero `crates/*/src/` edits, honoring the
design's "report, don't fix" contract for discovered defects.

## Issues

**CRITICAL**: None.

**WARNING**:
1. The self-relation false-positive in `validate_implicit_many_to_many`
   (lines 304-321) is a real, confirmed compiler defect on the `main`
   branch, discovered but deliberately not fixed by this change per its own
   rules. It is not a defect *in* this change, but it should not be lost:
   recommend opening a follow-up SDD change specifically to fix
   `validate_implicit_many_to_many` to exclude the field under test from its
   own reciprocal-match scan. (Already known/tracked per session brief —
   restated here only so the archived record carries the action item instead
   of relying on tribal memory.)
2. Sizing came in at ~192 authored lines vs. the ~145 estimate (task 7.6).
   Still well under the 400-line default-split trigger and 800-line review
   budget, so this is not a delivery blocker — flagged only because the
   original estimate undershot by ~32%, worth a data point for future
   estimates of "small fixture-only" changes.

**SUGGESTION**:
1. Once the `validate_implicit_many_to_many` fix lands in a follow-up change,
   restore the dropped `children Category[]` inverse field on
   `08-self-relation.indigo` to also cover the bidirectional shape the
   original design intended — today's fixture is spec-compliant but narrower
   than what was originally planned.

## Final Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 2 WARNING, 1 SUGGESTION. All 17 tasks
verified complete against code. All spec requirements across both
`compiler-corpus-coverage` and `parser-panic-safety` have passing runtime
test coverage, independently re-run this session. Scope is confirmed
additive-only (zero `crates/*/src/`, `packages/`, `apps/` changes). Safe to
proceed to archive.
