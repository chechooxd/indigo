# Design: Fix .indigo Compiler Correctness

## Technical Approach

All 8 defects share one root cause: **"what is legal" is implicit inside `resolve.rs` and has no counterpart in `validate.rs`.** Defect 1 is the pure form — `resolve.rs:116` silently accepts only `AttributeValue::String` while `parser.rs:361` produces `Reference` for a bare `onDelete: Cascade`; nothing rejects the mismatch, so the value vanishes.

The fix is architectural, not a set of patches: extract the legality tables into one new module, `crates/indigo-compiler/src/rules.rs`, read by **both** `validate.rs` (reject) and `resolve.rs` (emit). Divergence becomes a compile-time impossibility rather than a silent runtime discard. Scope is compiler-only; `packages/migrator` is untouched.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| 1 | New `rules.rs` is the single source of truth for the attribute table, arity/argument-type rules and the referential-action domain | Inline tables in `validate.rs`; duplicate logic in both | Duplication *is* defect 1. One table, two readers. |
| 2 | **The IR carries SQL-ready referential-action text** (`SetNull` → `"SET NULL"`, `NoAction` → `"NO ACTION"`, `Cascade` → `"CASCADE"`) | Carry the schema spelling verbatim; carry both spellings | `migrate.ts:88` and `postgres.ts:136` interpolate `fk.onDelete` **verbatim into executed DDL** and do no translation. Emitting `SetNull` would ship a Postgres syntax error at `db push`. Since the migrator is out of scope, the compiler must emit text that is already valid. `ir.ts:62`'s "verbatim" contract is *kept* — what changes is that the value now comes from a closed, SQL-valid set, which is what makes verbatim interpolation safe. This is the load-bearing security-adjacent property of the change. |
| 3 | Escape decoding happens in **`lexer.rs`**, not `parser.rs`; `Token.text` for `StringLiteral` becomes the decoded content without quotes | Decode in `parse_attribute_value` | Only the lexer has `LineIndex`, so the unknown-escape diagnostic gets an exact 1-based column instead of the string's start. Also deletes the fragile `raw[1..raw.len()-1]` at `parser.rs:229` and `:301` — the only two `StringLiteral` `.text` consumers (verified). |
| 4 | `ResolvedEnum` gains an **additive** `members: {name, dbName}[]`; `values: string[]` is retained unchanged | Change `values` to objects | `values` is read by `postgres.ts:225`, `migrate.ts:50/223`, `generator/src/client.ts:59`, `schema-adapter.ts:58`. Reshaping it breaks `pnpm lint` and forces the migrator into scope. |
| 5 | New TS mirror keys are declared **optional** even where Rust always emits them | Required keys | `migrate-runner.ts` re-reads `.snapshot.json` files written by earlier compiler builds; a required key would be a type-level lie about persisted data. |
| 6 | `lib.rs::parse_source` concatenates **lexer errors first, then parser errors** | Merge-sort by position | Preserves `illegal_char_error_points_at_line` (asserts `errors[0].line == 3`) as a genuine regression guard. |
| 7 | `onUpdate` is resolved into the IR and domain-validated, but **no `ON UPDATE` DDL is emitted** | Extend the migrator now | Tracked, documented incompleteness with a named follow-up (`fix-migrator-correctness`), **not** a silent no-op — the distinction this change exists to enforce. Not a regression: `onUpdate` does not reach the IR today either. The IR key is the handoff. |
| 8 | Datasource `provider` is validated **only when a `datasource` block exists** | Require a block | `fixtures/04` and `05` declare none and must stay clean. |

## Attribute Whitelist (derived from source, not invented)

Enumerated from what the resolver/validator actually consume — `resolve.rs:19,23,27,63,64,67,79,113,237,238` and `validate.rs:49,68,90`:

| Target | Attributes | Arity / argument contract |
|---|---|---|
| Field `@` | `id`, `unique` | 0 args |
| Field `@` | `map`, `note` | 1 positional string |
| Field `@` | `default` | 1 positional; literal type must match the field scalar. Always allowed: `autoincrement() now() uuid() cuid()`, and a bare `Reference` on an enum-typed field |
| Field `@` | `relation` | named args only; keys ⊆ `{fields, references, onDelete, onUpdate}` |
| Model `@@` | `realtime` | 0 args |
| Model `@@` | `map`, `note` | 1 positional string |
| Model `@@` | `index`, `unique` | 1 positional reference array |
| Enum value `@` | `map` | 1 positional string |

Verified: every attribute in `fixtures/*.indigo` is covered, and no `@default` literal in the corpus violates the type rule. Newly-rejected constructs that are currently silent no-ops — `@@id([a,b])`, `@updatedAt`, `@@ignore`, and unknown `@relation` named args — MUST be listed in the release note.

## Change Surface per Module

| File | Action | What changes |
|---|---|---|
| `crates/indigo-compiler/src/rules.rs` | Create | Attribute table keyed by (target, name); arity/argtype rules; `REFERENTIAL_ACTIONS` domain + `action_sql()` mapping |
| `.../lexer.rs` | Modify | `unescape()` for `\\ \" \n \r \t`; unknown escape → `CompilerError` with exact column; `StringLiteral` tokens carry decoded text |
| `.../parser.rs` | Modify | Drop both `raw[1..len-1]` slices; consume decoded `Token.text` |
| `.../lib.rs` | Modify | `parse_source` no longer returns early on lexer errors; runs the parser and returns both classes |
| `.../validate.rs` | Modify | New passes: attribute whitelist/arity/type, referential-action domain, implicit m‑n rejection, datasource provider + duplicate-block |
| `.../resolve.rs` | Modify | `onDelete`/`onUpdate` accept `String` **and** `Reference` via `rules::action_sql()`; enum `members` |
| `.../ir.rs` | Modify | `ForeignKey.on_update`; `ResolvedEnumMember`; `ResolvedEnum.members` |
| `.../ast.rs`, `error.rs` | Unchanged | No new AST keys, no new diagnostic type |
| `tests/fixtures.rs` | Modify | Invert `quirk_strings_are_not_unescaped`; add per-defect tests |
| `fixtures/`, `fixtures/snapshots/` | Modify | New error fixtures; regenerate 01, 02, 03 |
| `packages/compiler/wasm/` | Modify | Rebuilt committed artifact (per slice) |
| `packages/core/src/ir.ts` | Modify | Type-only mirror |
| `packages/ast/src/index.ts` | **Unchanged** | AST wire contract is untouched — only string *values* change |

## Diagnostics Architecture

```
source ──lexer.rs──> tokens ──parser.rs──> Schema(AST) ──validate.rs──> ValidationError[]
           │              │                     │
      CompilerError  CompilerError          resolve.rs ──> ResolvedSchema
      (1-based pos)  (1-based pos)               ▲
           └──────── concatenated ───────┘   rules.rs (read by validate + resolve)
```

| New diagnostic | Type | Position |
|---|---|---|
| Unknown escape sequence | `CompilerError` | 1-based line/column at the backslash |
| Unknown/misapplied attribute, arity, argtype | `ValidationError` | **Positionless** — `model`/`field` only |
| Invalid referential action value | `ValidationError` | Positionless — `model`/`field` |
| Implicit many-to-many | `ValidationError` | Positionless — `model`/`field` |
| Datasource provider, duplicate blocks | `ValidationError` | Positionless — **`message` only**, no `model`/`field` |

**Why positionless is the achievable ceiling:** `ast.rs:39-118` carries no source spans, and `validate` is a *separate WASM export taking `Schema` JSON* — it never sees the source text. Positions are structurally impossible without AST spans, which touch every AST struct, the serde wire contract and every golden. Named follow-up: `compiler-source-spans`.

Message shape follows the existing parity contract (sentence case, terminal period, identifiers in double quotes), extended to `<what is wrong>. <remedy>.`:

```
Unknown field attribute "@uniqe" on "User.emial". Known field attributes: @id, @unique, @default, @map, @note, @relation.
@default("nope") is not valid for Int field "Widget.count"; expected a number.
Invalid onDelete value "Nonsense". Allowed: Cascade, Restrict, SetNull, SetDefault, NoAction.
Implicit many-to-many between "Post" and "Tag" is not supported. Define an explicit join model with two @relation(fields:, references:) legs.
Unsupported datasource provider "mysql". "postgresql" is the only supported provider.
```

## Wire Contract (serde attributes ARE the contract; absent ≡ TS `undefined`)

| JSON path | Change | TS mirror |
|---|---|---|
| `ForeignKey.onUpdate` | **Added**, `skip_serializing_if = "Option::is_none"` | `packages/core/src/ir.ts`: `onUpdate?: string` |
| `ForeignKey.onDelete` | Key unchanged; **value semantics** change to canonical SQL text | Amend the `ir.ts:61` doc comment |
| `ResolvedEnum.members` | **Added**, always emitted, serialized last | Add `ResolvedEnumMember {name, dbName}`; `members?: ResolvedEnumMember[]` (optional — decision 5) |
| `ResolvedEnum.values` | Unchanged | Unchanged |
| AST (`Schema`) | **No key added or removed** | `packages/ast/src/index.ts` unchanged |

`diffResolved` compares enums by `name`/`values`, so `members` produces no spurious migration.

## Testing Strategy (Strict TDD)

`@indigodb/compiler` already has both harnesses — no new harness needed, which is why this change was sequenced first.

**Critical distinction:** `cargo test` runs against Rust source (fast RED→GREEN loop). `pnpm test` runs against the **committed WASM artifact**, so it is an integration gate, not the TDD loop.

Per defect:

| # | RED (`cargo test`) | GREEN |
|---|---|---|
| 1 | Bare `onDelete: Cascade` → assert FK `onDelete == "CASCADE"` | `rules.rs` + `resolve.rs:116` |
| 2 | `@uniqe`, `@id("x")`, `@map()`, `@default("nope")` on `Int` → assert diagnostics; corpus asserts **zero** attribute diagnostics | `rules.rs` + `validate.rs` |
| 3 | Reciprocal `Post[]`/`Tag[]`, no `@relation` → assert diagnostic names both models + "explicit join model" | `validate.rs` |
| 4 | Invert `quirk_strings_are_not_unescaped` → `strings_are_unescaped`; add `\q` → diagnostic with line/column | `lexer.rs` |
| 5 | Illegal char + missing `}` in one file → assert **both** diagnostics | `lib.rs::parse_source` |
| 6 | `ACTIVE @map("active")` → assert `members[0].dbName == "active"`; `INACTIVE` → `"INACTIVE"` | `ir.rs` + `resolve.rs` |
| 7 | Bare `onUpdate: Restrict` → assert FK `onUpdate == "RESTRICT"`; `onDelete: cascade` (lowercase) → diagnostic | `rules.rs` + `resolve.rs` + `validate.rs` |
| 8 | `provider = "mysql"`, absent `provider`, two `datasource` blocks → diagnostics; `generator.provider` untouched | `validate.rs` |

**Golden-churn protocol (finding F).** Regeneration must never be the thing that makes a suite pass. Per slice:

1. `cargo test` RED → implement → `cargo test` GREEN. **Assertions pin the exact expected new values** (`"CASCADE"`, the decoded note, `members`) — these are the independent oracle.
2. `pnpm --filter @indigodb/compiler build:wasm`.
3. `pnpm test` → RED **only** where a golden encodes the old contract.
4. `node packages/compiler/test/regen-snapshots.mjs`; review the diff line by line — it is the review artifact per CLAUDE.md. The regen only *records* what step 1 already proved.
5. `pnpm test` GREEN, then `pnpm build` and `pnpm lint`.
6. Commit Rust source + `packages/compiler/wasm/` + goldens **together** — Rust/binary drift is structurally undetectable (no CI compares them).

Expected golden diff: `03-quirks-values.json` (decoded note in AST + resolved, FK gains `"onDelete": "CASCADE"`, `Status` gains `members`); `01` and `02` (enum `members` only); `04` and `05` unchanged (no enums, no FK actions).

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Adjacent note: decision 2 closes an unvalidated-string-into-executed-DDL path, but through domain closure, not a process boundary.

## Review Budget and Slicing

Authored estimate (goldens excluded per the review guard): `rules.rs` ~130, `validate.rs` ~180, `tests/fixtures.rs` ~180, `lexer.rs` ~45, new fixtures ~60, `resolve.rs` ~25, `ir.rs` ~15, `ir.ts` ~15, `lib.rs`/`parser.rs` ~18, release note ~30 ⇒ **≈700 authored lines against an 800 budget.** Within budget but with almost no headroom, and the validator alone is a large single blob. `delivery_strategy: auto-chain` ⇒ **slice**, three autonomous units, each independently verifiable and revertible:

| Slice | Capabilities | Files | ~Lines |
|---|---|---|---|
| 1 | `compiler-diagnostics`, `string-literals` | `lib.rs`, `lexer.rs`, `parser.rs`, tests, golden 03 | ~200 |
| 2 | `referential-actions` (resolve half), `enum-value-mapping` | `rules.rs` (action table), `resolve.rs`, `ir.rs`, `ir.ts`, goldens 01/02/03 | ~200 |
| 3 | `attribute-validation`, `relation-validation`, `datasource-validation`, `referential-actions` (validate half) | `rules.rs` (attribute table), `validate.rs`, fixtures | ~300 |

Each slice carries its own `build:wasm` + committed artifact + both suites GREEN. Slice 2 depends on slice 1 only for a clean tree; slice 3 depends on slice 2's `rules.rs`.

## Migration / Rollout

No data migration. Rollout is a behavior change, not a schema change: schemas that compiled silently may now fail. No deprecation window (settled decision 1 — packages are `0.0.1`, unpublished, and the compiler has no severity tier). The release note MUST list every new rejection class, including the silent no-ops now rejected (`@@id`, `@updatedAt`, `@@ignore`, unknown `@relation` named args, implicit many-to-many, non-`postgresql` provider, duplicate `datasource`, unknown escapes).

## Open Questions

- [ ] Confirmed, not open: the referential-action domain is `Cascade | Restrict | SetNull | SetDefault | NoAction`, PascalCase, case-sensitive — matches Prisma's vocabulary exactly and the existing `onDelete: Cascade` in `fixtures/03-quirks-values.indigo`. Decision 2 fixes the SQL mapping in `rules.rs`.
- [ ] `onUpdate` DDL emission and enum `members` consumption are both deferred to `fix-migrator-correctness`, which must build a test harness for `packages/migrator` first. Until then the IR is ahead of the DDL — documented, not silent.
