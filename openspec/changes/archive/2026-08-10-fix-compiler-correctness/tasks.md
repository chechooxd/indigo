# Tasks: Fix .indigo Compiler Correctness

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~700 authored (rules.rs ~130, validate.rs ~180, tests/fixtures.rs ~180, lexer.rs ~45, fixtures ~60, resolve.rs ~25, ir.rs ~15, ir.ts ~15, lib.rs/parser.rs ~18, release note ~30); goldens excluded from authored count |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | auto-chain |
| Chain strategy | pending — orchestrator selects (stacked-to-main / feature-branch-chain) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

Project's `review_budget_lines` override is 800; ~700/800 leaves no headroom, so chaining stands regardless of which budget number applies.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Diagnostics recovery + string-literal decoding | PR 1 | `cd crates && cargo test --test fixtures` | `pnpm test` (rebuilt WASM) | `lib.rs`, `lexer.rs`, `parser.rs`, `tests/fixtures.rs`, golden `03-quirks-values.json`, `packages/compiler/wasm/` |
| 2 | Referential-action resolve half + enum `members`/`dbName` | PR 2 | `cd crates && cargo test --test fixtures` | `pnpm test` (rebuilt WASM) | `rules.rs` (action table), `resolve.rs`, `ir.rs`, `packages/core/src/ir.ts`, goldens 01/02/03, `packages/compiler/wasm/` |
| 3 | Attribute/relation/datasource validation + referential-action validate half | PR 3 | `cd crates && cargo test --test fixtures` | `pnpm test` (rebuilt WASM) | `rules.rs` (attribute table), `validate.rs`, `fixtures/errors/*`, release note, `packages/compiler/wasm/` |

Sequential: PR 2 needs PR 1's clean tree; PR 3 needs PR 2's `rules.rs`. Within each phase, RED precedes GREEN precedes WASM rebuild — no intra-phase parallelism.

## Phase 1: Diagnostics Recovery & String Literals (PR 1)

- [x] 1.1 RED: invert `quirk_strings_are_not_unescaped` → `strings_are_unescaped` in `crates/indigo-compiler/tests/fixtures.rs`; `@note("say \"hi\"")` decodes to `say "hi"` (string-literals)
- [x] 1.2 RED: unknown escape `\q` → `CompilerError` with 1-based line/column (string-literals)
- [x] 1.3 RED: illegal char + missing `}` in one file → both diagnostics present in one pass (compiler-diagnostics)
- [x] 1.4 GREEN: `lexer.rs` — `unescape()` for `\\ \" \n \r \t`; unknown escape errors at exact column; `StringLiteral` tokens carry decoded text
- [x] 1.5 GREEN: `parser.rs` — drop both `raw[1..len-1]` slices; read decoded `Token.text`
- [x] 1.6 GREEN: `lib.rs::parse_source` — stop early-returning on lexer errors; concatenate lexer errors then parser errors
- [x] 1.7 Verify `cd crates && cargo test` GREEN
- [x] 1.8 `pnpm --filter @indigodb/compiler build:wasm`; commit `packages/compiler/wasm/`
- [x] 1.9 `pnpm test` (expect RED only on golden `03-quirks-values.json`); `node packages/compiler/test/regen-snapshots.mjs`; review diff limited to 03's decoded note
- [x] 1.10 Verify `pnpm test`, `pnpm build`, `pnpm lint` GREEN

## Phase 2: Referential Actions (Resolve) & Enum Value Mapping (PR 2) — COMPLETE

Branch `fix/compiler-referential-actions-and-enums` (stacked on `fix/compiler-diagnostics-and-string-literals` @ `5d8d61c`). Commit: `877205d`. See `sdd/fix-compiler-correctness/apply-progress` for full TDD evidence.

- [x] 2.1 Create `crates/indigo-compiler/src/rules.rs`: `REFERENTIAL_ACTIONS` domain (`Cascade|Restrict|SetNull|SetDefault|NoAction`) + `action_sql()` (`SetNull`→`"SET NULL"`, `NoAction`→`"NO ACTION"`, rest uppercase verbatim)
- [x] 2.2 RED: bare `onDelete: Cascade` (Reference) → FK `onDelete == "CASCADE"`; quoted form resolves identically (referential-actions)
- [x] 2.3 RED: absent onDelete/onUpdate stays absent, not null/empty (referential-actions)
- [x] 2.4 RED: bare `onUpdate: Restrict` → FK `onUpdate == "RESTRICT"` (referential-actions)
- [x] 2.5 RED: `ACTIVE @map("active")` → `members[0].dbName=="active"`; unmapped `INACTIVE` → own name (enum-value-mapping)
- [x] 2.6 GREEN: `resolve.rs` — onDelete/onUpdate accept `String` and `Reference` via `rules::action_sql()`; emit `ForeignKey.on_update` (IR-only, no `ON UPDATE` DDL yet — tracked, see 3.18)
- [x] 2.7 GREEN: `resolve.rs` — emit `ResolvedEnum.members`; keep `values` unchanged (migrator still reads `values` only — tracked, see 3.18)
- [x] 2.8 GREEN: `ir.rs` — `ForeignKey.on_update` (`skip_serializing_if = "Option::is_none"`), `ResolvedEnumMember{name,db_name}`, `ResolvedEnum.members`
- [x] 2.9 GREEN: `packages/core/src/ir.ts` — optional `onUpdate?: string`, `ResolvedEnumMember{name,dbName}`, optional `members?: ResolvedEnumMember[]`; amend `onDelete` doc comment (canonical SQL text)
- [x] 2.10 Verify `cd crates && cargo test` GREEN
- [x] 2.11 `pnpm --filter @indigodb/compiler build:wasm`; commit `packages/compiler/wasm/`
- [x] 2.12 `pnpm test` (expect RED on goldens 01/02/03); `node packages/compiler/test/regen-snapshots.mjs`; review diff (01/02 gain `members` only; 03 also gains `onDelete: "CASCADE"`)
- [x] 2.13 Verify `pnpm test`, `pnpm build`, `pnpm lint` GREEN

## Phase 3: Attribute, Relation & Datasource Validation (PR 3) — COMPLETE

Branch `fix/compiler-schema-validation` (stacked on `fix/compiler-referential-actions-and-enums` @ `4e5ac52`). See `sdd/fix-compiler-correctness/apply-progress` for full TDD evidence.

- [x] 3.1 Extend `rules.rs` with the attribute table keyed by (target, name): field `{id,unique}`=0 args, field `{map,note}`=1 string, field `default`=type-matched literal (generator calls + enum reference always allowed), field `relation`=named args ⊆ `{fields,references,onDelete,onUpdate}`, model `{realtime}`=0 args, model `{map,note}`=1 string, model `{index,unique}`=1 reference array, enum-value `map`=1 string
- [x] 3.2 RED: `@relation(onDlete: Cascade)` (unknown named arg, misspelled key) → diagnostic naming the unknown key vs the whitelist (attribute-validation)
- [x] 3.3 RED: `@uniqe`, `@@deafult` → unrecognized-attribute diagnostics naming model/field (attribute-validation)
- [x] 3.4 RED: `@id("x")`, `@map()` → arity diagnostics; `@default("nope")` on `Int` → argtype diagnostic; `autoincrement()`/enum-ref defaults stay clean (attribute-validation)
- [x] 3.5 RED: full `fixtures/*.indigo` corpus (excl. `errors/`) → zero attribute-validation diagnostics (attribute-validation)
- [x] 3.6 RED: reciprocal `Post[]`/`Tag[]`, no `@relation` → diagnostic naming both models + "explicit join model"; explicit FK one-to-many and explicit join-model schemas stay clean (relation-validation)
- [x] 3.7 RED: `onDelete: Nonsense` and lowercase `onDelete: cascade` → diagnostics naming value + allowed set (referential-actions, validate half)
- [x] 3.8 RED: `provider = "mysql"`, absent `provider`, two `datasource` blocks → diagnostics; `generator.provider` untouched (datasource-validation)
- [x] 3.9 GREEN: `validate.rs` — attribute whitelist/arity/argtype pass, incl. `@relation` named-arg key whitelist, reading `rules.rs`
- [x] 3.10 GREEN: `validate.rs` — implicit many-to-many rejection pass
- [x] 3.11 GREEN: `validate.rs` — referential-action domain check (positionless, model/field) reading `rules::REFERENTIAL_ACTIONS`
- [x] 3.12 GREEN: `validate.rs` — datasource `provider` + duplicate-block checks (message-only diagnostic)
- [x] 3.13 DEVIATION: `fixtures/errors/*` is checked by `parity.mjs` only for parse-failure, not validation-failure; a semantically-invalid fixture there would break that harness. Covered 3.2–3.8 as `cargo test` cases instead — see apply-progress.
- [x] 3.14 Verify `cd crates && cargo test` GREEN
- [x] 3.15 `pnpm --filter @indigodb/compiler build:wasm`; commit `packages/compiler/wasm/`
- [x] 3.16 `pnpm test` — GREEN with zero golden diff (no regen needed; the 5 valid fixtures' `ValidationError[]` already matched)
- [x] 3.17 Verify `pnpm test`, `pnpm build`, `pnpm lint` GREEN
- [x] 3.18 Wrote `openspec/changes/fix-compiler-correctness/release-notes.md`
