# Tasks: Grow the Compiler Corpus and Add Property-Based Parser Testing

Single slice — no chaining (145 authored lines, well under the 800-line review
budget). Sequential unless marked `[parallel]`. Zero edits under
`crates/*/src/`, `packages/`, or `apps/` are expected; `build:wasm` is not run.

## 0. Setup

- [x] **0.1** Confirm the stacking base: run `git log --oneline -1` on `main`
  and branch/stack the change from that exact tip (per delivery_strategy
  `stacked-to-main`). Record the tip SHA in the PR/commit description.
  — *Housekeeping, not spec-linked.* Branch `compiler/grow-corpus-and-proptest`
  stacked at `8c29e76`.

## 1. Corpus fixtures — scalar types and referential actions

*(compiler-corpus-coverage: Scalar type coverage, Referential action coverage)*

- [x] **1.1** Write `fixtures/06-scalar-types.indigo`: one model using all 9
  `SCALAR_TYPES` (`String`, `Int`, `Float`, `Boolean`, `DateTime`, `Json`,
  `BigInt`, `Bytes`, `Decimal`), plus at least one list form and one optional
  form. — *Req: Scalar type coverage / Scenario: BigInt and Bytes are
  exercised.*
- [x] **1.2** Write `fixtures/07-referential-actions.indigo`: relation legs
  covering `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction`, with
  one leg written in quoted form. — *Req: Referential action coverage /
  Scenario: All five actions reach DDL.*
- [x] **1.3** Write `fixtures/08-self-relation.indigo`: a model (`Category`)
  with a `parent` self-referencing FK. — *Req: Self-relation coverage /
  Scenario: Self-relation resolves correctly.* **Deviation**: dropped the
  planned `children Category[]` inverse field — see the finding noted below;
  the forward FK leg alone satisfies the requirement.
- [x] **1.4** `cd crates && cargo test` — actual behavior differs from the
  plan: `corpus_validation_errors_are_unchanged_by_new_rules` iterates a
  fixed table (not a directory scan), so it does not fail for
  table-less new fixtures; it stayed green throughout. No RED was observed
  at this step for that reason (see task 4.3 for where RED actually occurred).

## 2. Corpus fixtures — rejected attributes (parses clean, non-empty errors)

*(compiler-corpus-coverage: Rejected-attribute validation fixtures)*

- [x] **2.1** Write `fixtures/09-rejected-composite-id.indigo`: `@@id([a,
  b])` on a model with no field-level `@id`.
- [x] **2.2** Write `fixtures/10-rejected-updated-at.indigo`:
  `updatedAt DateTime @updatedAt` on a table that also has a valid
  field-level `@id`.
- [x] **2.3** Write `fixtures/11-rejected-ignore.indigo`: `@@ignore` on a
  table that also has a valid field-level `@id`.
  — *Req: Rejected-attribute validation fixtures / both scenarios.*

## 3. Confirm enum `@map` coverage (verification only, no new fixture)

*(compiler-corpus-coverage: Enum @map end-to-end coverage confirmed)*

- [x] **3.1** Re-verify `fixtures/03-quirks-values.indigo:16` uses an enum
  value `@map(...)` and that its golden snapshot's
  `resolved.enums[].members[].dbName` reflects the mapping. Confirm no
  duplicate fixture is created. — *Req: Enum @map end-to-end coverage
  confirmed / Scenario: Enum @map is already covered.* Confirmed:
  `fixtures/snapshots/03-quirks-values.json` has `"dbName":"active"` on
  `Status.ACTIVE`. No duplicate fixture created.

## 4. Hand-write expected-message table entries (oracle-first, not derive-and-pin)

*(compiler-corpus-coverage: New fixtures are pinned in the expected-message test)*

- [x] **4.1** Open `crates/indigo-compiler/src/validate.rs` and read the exact
  `format!` templates for: unknown model attribute, unknown field attribute,
  and "Model has no @id primary key." Read directly:
  `Unknown {kind} attribute "{prefix}{attr_name}" on {location}.` (line 158)
  and `Model "{}" has no @id primary key.` (line 67).
- [x] **4.2** Hand-write six entries in
  `crates/indigo-compiler/tests/fixtures.rs`'s
  `corpus_validation_errors_are_unchanged_by_new_rules` table:
  - `06-scalar-types.indigo` → `[]`
  - `07-referential-actions.indigo` → `[]`
  - `08-self-relation.indigo` → `[]`
  - `09-rejected-composite-id.indigo` → unknown model attr `@@id` message +
    `Model "…" has no @id primary key.` message (both hand-derived from
    `validate.rs`, not run-and-pinned)
  - `10-rejected-updated-at.indigo` → unknown field attr `@updatedAt` message
  - `11-rejected-ignore.indigo` → unknown model attr `@@ignore` message
- [x] **4.3** `cd crates && cargo test`. On any mismatch between the
  hand-written expectation and actual output, classify explicitly:
  - expectation text wrong → fix the table entry, note the correction;
  - compiler output wrong → **STOP**. Make zero edits under
    `crates/*/src/`. Capture the fixture name, expected vs. actual message,
    and report it to the orchestrator as a separate new finding, not fixed
    in this change. Already-green fixture/table work from tasks 1–4.2 may
    still land.

  **Result**: the six hand-written table entries matched actual output on
  the first run. A different, unplanned RED was hit while authoring
  `08-self-relation.indigo` (before this step): the original design's
  `children Category[]` inverse field triggered a false-positive
  `"Implicit many-to-many ... between \"Category\" and \"Category\""`
  diagnostic. **Root cause** (`validate.rs::validate_implicit_many_to_many`,
  lines 304-321): the reciprocal-field search does not exclude the field
  under test from its own reciprocal-match scan, so for a self-relation
  (`model == target_model`) a bare inverse list field always matches
  itself as its own "reciprocal" leg, unconditionally. **Classification**:
  compiler wrong, not the fixture — this is a genuine defect that would
  misfire on any real one-to-many self-relation using a bare array inverse
  field. **Action taken**: zero `crates/*/src/` edits; fixture 08 redesigned
  to omit the inverse array field (still satisfies the self-relation
  coverage requirement via the forward FK leg). **Reported here as a new
  finding** for a separate future change: fix
  `validate_implicit_many_to_many` to skip the field itself when scanning
  for a reciprocal match.
- [x] **4.4** Confirm `cargo test` is fully green (both `fixtures.rs` and any
  other existing suites in the crate) before moving to snapshot regen.
  Confirmed: 19/19 tests green in `fixtures.rs`, 4/4 unit tests green.

## 5. Regenerate golden snapshots (mechanical, only after step 4 is green)

*(compiler-corpus-coverage: pinned goldens for new fixtures + unchanged old goldens)*

- [x] **5.1** Build `packages/compiler` as needed for the regen script to run
  against current (unchanged) WASM. `pnpm build --filter=@indigodb/compiler`
  — cache hit, no WASM rebuild.
- [x] **5.2** Run `node packages/compiler/test/regen-snapshots.mjs` to
  generate `fixtures/snapshots/06-scalar-types.json` through
  `11-rejected-ignore.json`. Done.
- [x] **5.3** **Guardrail**: run `git diff --stat fixtures/snapshots/` and
  confirm the original five snapshots (`01`–`05`) show zero diff (byte-
  identical). Any movement there is unintended contract drift — STOP and
  investigate before proceeding; do not treat it as expected fallout of this
  change. Confirmed: `git diff --stat fixtures/snapshots/` is empty (no
  tracked file changed); 01-05 are byte-identical.
- [x] **5.4** `pnpm test` (root) — confirm the Node regression harness
  (`parity.mjs`) is green against the regenerated snapshots. Confirmed via
  `node packages/compiler/test/parity.mjs` (11 fixtures + 3 error fixtures,
  all green) and `pnpm test --force` (16/16 tasks green, uncached).

## 6. Proptest — panic safety for `parse_source`

*(parser-panic-safety: all four requirements)*

- [x] **6.1** Add `proptest = "1"` under `[dev-dependencies]` in
  `crates/indigo-compiler/Cargo.toml`. Resolve the lockfile
  (`crates/Cargo.lock` updates as a generated diff) and confirm it resolves
  under `add-ci-floor`'s offline/CI network policy on stable 1.93.1 — this is
  an open design assumption to validate now; if the lockfile cannot populate
  offline, STOP and escalate rather than relaxing the policy. Resolved via
  `cargo add proptest --dev -p indigo-compiler`; `crates/Cargo.lock` updated
  with proptest 1.11.0 and transitive dev-deps, no network policy issue.
- [x] **6.2** Create `crates/indigo-compiler/tests/parser_panic.rs` (new
  integration test binary, not appended to `fixtures.rs`):
  - `ATOMS`: ~46 fixed strings per the design (keywords, punctuation,
    attribute names, all 9 scalar type names, relation-arg identifiers,
    `//`, `~`, `\`, `"`).
  - `indigo_source()` strategy: `prop_oneof!` weighted `8 => select(ATOMS)`,
    `3 => identifier regex`, `2 => quoted-string-with-escape-bait`,
    `1 => any::<i32>().to_string()`; separators from
    `[" ", "\n", "  ", ""]`; `vec((token, sep), 1..=40)` concatenated into
    one source string.
  - Test body: `#![proptest_config(ProptestConfig { cases: 256, ..default()
    })]`; `let _ = parse_source(&src);` with no `catch_unwind` and no
    `unwrap` — a panic must propagate and fail the test loudly.
  — *Req: Panic-freedom property test; Input strategy is biased toward valid
  token shapes; Bounded, CI-reasonable case count.*
- [x] **6.3** Run `cd crates && cargo test --test parser_panic` and note
  wall-clock time.
  - **If clean (no panic)**: confirm zero `crates/*/src/` edits were made,
    confirm no `proptest-regressions/parser_panic.txt` file was produced.
    If wall time attributable to this test exceeds ~2s, drop `cases` to 128
    and record the measurement in the task notes/commit message per the
    design's stated fallback. — *Req: No panic found.*

  **Result**: clean, no panic. `test parse_source_never_panics ... ok`,
  test-only wall time 0.18–0.19s (well under the 2s fallback threshold —
  256 cases kept, no drop to 128 needed). Zero `crates/*/src/` edits.
  `crates/indigo-compiler/proptest-regressions/parser_panic.txt` was not
  produced (directory does not exist).
  - **If a real panic is found**: STOP. Make zero edits under
    `crates/*/src/`. Capture (a) the minimized failing input string, (b) the
    panic message and source location, (c) the committed
    `crates/indigo-compiler/proptest-regressions/parser_panic.txt` seed
    line. Report this as its own new finding for a separate future SDD
    change. This task reports `blocked`, not done — do **not** `#[ignore]`
    the test and do **not** commit red; already-green fixture work from
    sections 1–5 may still land independently. — *Req: A found panic is a
    reported finding, not an in-change fix.*

## 7. Full-suite verification

- [x] **7.1** `cd crates && cargo test` (full crate suite, both `fixtures.rs`
  and `parser_panic.rs`) — green, unless task 6.3 blocked. Confirmed: 4 unit
  + 19 `fixtures.rs` + 1 `parser_panic.rs` = 24/24 green.
- [x] **7.2** `pnpm test` (root) — green. Confirmed via `pnpm test --force`:
  16/16 tasks, uncached.
- [x] **7.3** `pnpm build` — green (confirms no accidental TS-visible
  regression). Confirmed: 10/10 tasks green.
- [x] **7.4** `pnpm lint` — green. Confirmed: 18/18 tasks green.
- [x] **7.5** Verify zero production code drift: `git status
  packages/compiler/wasm/` must be clean (no changes) — explicit
  confirmation that this change never required `build:wasm`, not an
  assumption. Confirmed: "nothing to commit, working tree clean".
- [x] **7.6** Confirm total authored-line diff (excluding generated
  `fixtures/snapshots/*.json` and `crates/Cargo.lock`) stays within the
  ~145-line estimate and the single-slice/no-chaining sizing decision from
  design still holds. **Actual**: ≈192 authored lines (97 across the six
  `.indigo` fixtures, 79 in `parser_panic.rs`, 13 table entries +
  3 `Cargo.toml`), above the ~145 estimate but still well under the
  400-line default-split trigger and the 800-line review budget. Sizing
  decision (single slice, no chaining) still holds.

## Review Workload Forecast

- **Single slice, no chaining.** Estimated authored lines ≈ 145 (6 fixtures
  ≈ 70, 6 expected-message table entries ≈ 12, `parser_panic.rs` ≈ 60,
  `Cargo.toml` ≈ 3), well under the 800-line `review_budget_lines` and the
  400-line default trigger for splitting. `fixtures/snapshots/*.json` (six
  new goldens) and `crates/Cargo.lock` are generated/mechanical and excluded
  from the authored-risk count per design.
- **No production code paths touched** (`crates/*/src/`, `packages/`,
  `apps/` all untouched) — review surface is entirely additive test fixtures,
  one hand-authored Rust test-table edit, and one new property-test file.
- **Bottleneck risk**: task 4.3's STOP/classify branch and task 6.3's
  STOP/report branch are the only points where this change can end in
  `blocked` rather than `done`; both are explicitly scoped to *report, not
  fix*, so they don't block delivery of the already-green remainder.
- **Ownership**: sequential single-author change; no parallelizable tracks
  called out (fixture authoring in section 1–2 could be parallelized across
  files but is small enough that sequential authorship is simpler to review
  against one coherent expected-message table).
