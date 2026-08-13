# Design: Native Type Attributes (`@db.X`)

## Technical Approach

Namespaced attributes become a first-class AST concept (`Attribute.namespace: Option<String>`),
then a semantic pass turns `@db.<Name>(args)` on a scalar field into
`ResolvedColumn.nativeType = { name, args: Vec<String> }`, which `postgres.ts` renders ahead of
`mapScalarToPg`. Two chained PRs, split by *layer*, never by language: PR A = lexer/parser/AST
(Rust **and** TS mirror together), PR B = validate/resolve/IR/migrator.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | AST shape | `namespace: Option<String>` + `#[serde(skip_serializing_if = "Option::is_none", default)]` | compound `name: "db.VarChar"` | User-confirmed. Absent key ⇒ existing 13 goldens byte-identical; no ad-hoc string splitting. `default` is mandatory: `resolveSchema`/`validateSchema` deserialize AST JSON back into Rust. |
| 2 | Field order | `namespace` declared **first** in `ast.rs` and TS `Attribute` | appending last | Mirrors `TableGroup`(name,color,tables): Rust order follows the TS declaration. Reads `{"namespace":"db","name":"VarChar","args":[…]}`. Parity uses `deepStrictEqual`, so order is cosmetic — regen-diff readability decides. |
| 3 | Bare-name lookups | `get_attr`/`has_attr` gain `a.namespace.is_none()` | leave as-is | Otherwise a future `@db.map` would satisfy `has_attr(attrs,"map")`. Lands in PR A with the field. |
| 4 | Where the whitelist opens | PR A admits **only** `namespace == "db"` (unknown namespace ⇒ error, type name unchecked); PR B adds name + compatibility checks | (a) skip all namespaced attrs in PR A; (b) leave rejection, let fixture 14's golden encode a bogus diagnostic | (a) merges an over-permissive `@anything.Foo`; (b) merges a golden asserting wrong behavior. This keeps PR A's golden `validation: []` and never weakens unknown-attribute rejection. |
| 5 | IR `nativeType` | structured `{ name: String, args: Vec<String> }` | raw `"VARCHAR(255)"` | User-confirmed; keeps SQL dialect knowledge in the migrator, not the compiler. |
| 6 | Numeric arg stringification | `Number(255.0)` → `"255"` (integral ⇒ `i64` formatting), else `f64` | `to_string()` on `f64` | `f64::to_string` yields `"255"` in Rust but the value arrives as `AttributeValue::Number`; explicit integral formatting makes the contract intentional and JS-round-trip-safe. |
| 7 | Rejected-case fixture | ordinary `fixtures/15-*.indigo` whose golden `validation[]` holds the diagnostics | `fixtures/errors/` | `errors/` only asserts *parse* failure with positions; `@db.Foo` parses fine and fails validation. |

## Grammar (PR A)

`lexer.rs`: `#[token(".")] Dot` in `RawToken`, `TokenKind::Dot`, `describe() => "'.'"`.
`parser.rs::parse_attribute`:

```rust
let first = self.expect_identifier("an attribute name")?;
let (namespace, name) = if self.at(TokenKind::Dot) {
    self.advance();
    (Some(first), self.expect_identifier("an attribute name after '.'")?)
} else { (None, first) };
```

The `Dot` is consumed only when present, so `@unique`, `@@map("x")`, `@default(now())` take the
exact same path and produce `namespace: None`. Recovery is unchanged: a missing identifier after
`Dot` returns `None` from `parse_attribute`, which the existing declaration-level
`sync_to_field_or_block_end` / `sync_to_block_end` callers already handle. `Dot` is not added to
any sync set — a stray `.` elsewhere still lexes as an unexpected token for the parser to report.

## Compatibility Matrix (PR B)

Against the real `SCALAR_TYPES` (String, Int, Float, Boolean, DateTime, Json, BigInt, Bytes, Decimal):

| `@db.X` | Valid scalars | Arity | Rendered |
|---|---|---|---|
| `VarChar` | `String` | exactly 1 integral number | `VARCHAR(255)` |
| `Uuid` | `String` | 0 | `UUID` |
| `Numeric` | `Decimal`, `Float` | 0 or 2 integral numbers | `NUMERIC(10,2)` / `NUMERIC` |

Errors (all hard, with `model` + `field` populated): unknown namespace; unknown `@db.Foo`; wrong
arity/arg type; scalar mismatch; `@db.X` on an enum-typed or relation field. Lives in `rules.rs`
as a `NATIVE_TYPE_RULES` table next to `ATTRIBUTE_RULES`, checked from `validate_attributes`
before the existing bare-name `attribute_rule` lookup.

## Data Flow

    .indigo ──lexer(Dot)──> tokens ──parser──> Attribute{namespace,name,args}
                                                    │
                          PR A stops here ──────────┤
                                                    ▼
                          validate.rs (matrix) ─> resolve_column ─> ResolvedColumn.nativeType
                                                                        │
                                            postgres.ts renderColumn ───┘──> VARCHAR(255)

## File Changes

| File | PR | Action |
|---|---|---|
| `crates/indigo-compiler/src/lexer.rs` | A | `Dot` raw token, `TokenKind::Dot`, `describe` |
| `crates/indigo-compiler/src/parser.rs` | A | optional `Dot` in `parse_attribute` |
| `crates/indigo-compiler/src/ast.rs` | A | `Attribute.namespace` (first field); `get_attr`/`has_attr` namespace-blind guard |
| `packages/ast/src/index.ts` | A | `namespace?: string` on `Attribute`, same order |
| `crates/indigo-compiler/src/validate.rs` | A | admit `namespace == "db"`, reject other namespaces |
| `fixtures/14-native-type-attributes.indigo` + snapshot | A | `@db.VarChar(255)`, `@db.Uuid`, `@db.Numeric(10,2)`; golden `validation: []`, `resolved` shows **no** `nativeType` |
| `packages/compiler/wasm/*` | A, B | rebuilt + committed |
| `crates/indigo-compiler/src/rules.rs` | B | `NATIVE_TYPE_RULES` + arity/scalar matrix |
| `crates/indigo-compiler/src/validate.rs` | B | full `@db.X` diagnostics |
| `crates/indigo-compiler/src/resolve.rs` | B | populate `native_type` in `resolve_column` |
| `crates/indigo-compiler/src/ir.rs` | B | `ResolvedNativeType`, `ResolvedColumn.native_type` (last field, `skip_serializing_if`) |
| `packages/core/src/ir.ts` | B | `nativeType?: { name: string; args: string[] }` mirror |
| `packages/migrator/src/postgres.ts` | B | `renderNativeType()` + branch in `renderColumn` |
| `fixtures/15-rejected-native-types.indigo` + snapshot | B | unknown `@db.Foo`, `@db.VarChar` on `Int` |
| `fixtures/snapshots/14-*.json` | B | regenerated — now carries `nativeType` |

## Interfaces

```rust
// ir.rs — appended AFTER `note`, so existing snapshot key order is untouched.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedNativeType { pub name: String, pub args: Vec<String> }
#[serde(skip_serializing_if = "Option::is_none", default)]
pub native_type: Option<ResolvedNativeType>,
```

```ts
// postgres.ts — before mapScalarToPg, AFTER the autoincrement branch (IDENTITY wins).
function renderNativeType(n: NonNullable<ResolvedColumn["nativeType"]>): string {
  const sql = { VarChar: "VARCHAR", Uuid: "UUID", Numeric: "NUMERIC" }[n.name];
  return n.args.length ? `${sql}(${n.args.join(",")})` : sql;
}
```

`migrate.ts::alterColumn` is untouched — deferred follow-up (user-confirmed). Adding `@db.X` to an
existing schema therefore emits no migration; only `renderPushSql`/`CREATE TABLE` reflect it.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Rust unit | `Dot` lexing; `parse_attribute` namespaced + bare; `has_attr` ignores namespaced | `#[cfg(test)]` in `lexer.rs`/`parser.rs`/`ast.rs` |
| Rust unit | matrix: each valid pair, each rejection class | `rules.rs` + `validate.rs` tests (PR B) |
| Rust corpus | all fixtures compile; 01–13 gain zero diagnostics | existing `crates` fixture-corpus test |
| TS parity | AST + ResolvedSchema + ValidationError vs goldens | `packages/compiler/test/parity.mjs` |
| Migrator | `renderColumn` emits `VARCHAR(255)`/`UUID`/`NUMERIC(10,2)`; falls back otherwise; IDENTITY unaffected | migrator DDL test (PR B) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The WASM rebuild runs through the existing, unchanged `build:wasm`
script and CI `wasm-drift` job.

## Migration / Rollout

Per-slice `git revert`. No data migration. Toolchain sequence per slice, in order:
`cd crates && cargo test` → `pnpm --filter @indigodb/compiler build:wasm` (commit the artifact) →
`node packages/compiler/test/regen-snapshots.mjs` (diff is the review artifact) → `pnpm test` →
push and let CI `wasm-drift` self-heal `main`. Never hand-compare local WASM bytes to committed
bytes.

## Open Questions

- [ ] None blocking. Non-blocking: whether PR B should also reject `@db.X` on a *list* field —
      the resolver already skips list relation fields, and scalars are never lists today, so the
      matrix's "scalar only" rule covers it implicitly.
