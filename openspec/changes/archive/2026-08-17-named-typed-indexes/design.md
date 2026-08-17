# Design: Named and Typed Indexes

## Technical Approach

`parser.rs::parse_attribute_arg` already accepts `ident:` named args for ANY attribute, and
`name`/`type` are plain `Identifier`s (not keywords in `lexer.rs`'s keyword table) — so **no
lexer or parser change is needed**. The change is entirely semantic, following
`archive/2026-08-12-native-type-attributes`: a closed legality table in `rules.rs`, hard
diagnostics in `validate.rs`, one resolve pass into the IR, migrator reads the IR.

`@@index([a, b], name: "x", type: gin)` → `ArgShape::Index` in `rules.rs` → validated against
`INDEX_METHODS` → `ResolvedIndex { columns, unique, name, type }` → `USING gin` in both DDL paths.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Grammar surface | New `ArgShape::Index`: exactly one positional array + optional named `name`/`type`; replaces `ArgShape::OneReferenceArray` (index/unique are its only two users, so the variant is deleted, not left dead) | general expression grammar; a separate `@@indexType` attribute | Same closed-enum precedent as `@@db.X`. `check_shape`'s existing message `"requires exactly one array argument"` is REUSED verbatim for the missing-array case (parity contract, pinned by `tests/fixtures.rs`) |
| 2 | `type` value form | Bare identifier (`AttributeValue::Reference`) OR quoted string, mapped through `rules::index_method` — mirrors `resolve_action`'s dual-form acceptance for `onDelete` | identifier only | `resolve.rs::resolve_action` exists precisely because rejecting one of the two forms was a silent-drop bug. Do not repeat it |
| 3 | Closed method enum | `ir.rs::IndexMethod { Btree, Gin, Gist, Hash }`, `#[serde(rename_all = "lowercase")]` → `"btree"/"gin"/"gist"/"hash"`; `rules.rs` owns `INDEX_METHODS: [&str; 4]` + `index_method(&str) -> Option<IndexMethod>` | `String` SQL-ready text like `ForeignKey.on_delete` | Method names are already lowercase-SQL-identical, so the "compiler owns SQL-readiness" motive for `action_sql`'s mapping table does not apply; a real enum makes the TS union exhaustive. `rules.rs` stays the single legality table (it already imports from sibling modules) |
| 4 | btree canonicalization | Explicit `type: btree` resolves to **absent** (`None`) | serialize `"btree"` | btree is Postgres's default. If explicit btree were present, adding `type: btree` to an existing schema would change `indexDefinition` and emit a DROP+CREATE of a physically identical index. Canonicalizing makes that a true no-op. `Btree` still exists in the enum so `type: btree` is *accepted*, not an unknown-method error |
| 5 | IR field name/order | `#[serde(rename = "type")] pub index_type: Option<IndexMethod>`, declared **after** `name` (last field), `skip_serializing_if = "Option::is_none"` | new key before `name` | Mirrors `ResolvedColumn.column_type`'s `rename="type"` and `native_type`'s append-last rule: absent key ⇒ fixtures 01–15 goldens byte-identical |
| 6 | Explicit-name collision scope | Compiler validates table-scoped uniqueness of explicit names against (a) other explicit names, (b) auto-derived `@@index`/`@@unique` names, (c) derived single-column `@unique` names — replicating `migrate.ts::indexName`'s formula as a documented mirror | leave collisions to Postgres | `renderPushSql` emits `CREATE ... IF NOT EXISTS`, so a collision **silently skips** creating the second index. Silence is the failure mode this project systematically kills; the formula duplication is the accepted cost |
| 7 | `@@unique(type:)` | Only `btree` accepted; gin/gist/hash rejected at compile time | defer to Postgres (proposal assumption #5) | "access method gin does not support unique indexes" is a static, data-independent truth. Column-type/method compatibility stays Postgres's job — assumption #5 intact |
| 8 | Index diff matching | Two-pass match (mirrors `matchColumns`): pass 1 on full identity incl. explicit name, pass 2 on `(unique, columns)` among residuals ⇒ rename and/or method change | single signature key | Putting name in one signature turns a rename into DROP+CREATE; leaving it out collides two indexes over the same columns with different methods. Two passes give rename for name-only and DROP+CREATE for method-only |
| 9 | Shared DDL primitive | Export `indexName` + `renderIndexDdl(table, index, { ifNotExists })` from `postgres.ts`; `migrate.ts` imports it (as it already does `quoteIdent`, `renderColumn`, …) | keep the two inline copies | `postgres.ts:284-292` and `migrate.ts:213-217` already duplicate name derivation; adding `USING` twice guarantees drift |
| 10 | Name literal rules | Non-empty, ≤63 bytes (`NAMEDATALEN`), no `"` and no control chars | full identifier regex | `quoteIdent` escapes `"` and always quotes, so arbitrary text is safe; >63 bytes is not — Postgres silently truncates, which breaks the DROP/RENAME round-trip |

## Data Flow

    @@index([a,b], name:"x", type: gin)
      │ parser (UNCHANGED — named args + Identifier already supported)
      ▼
    Attribute{ name:"index", args:[Array, name:String, type:Reference] }
      │ validate.rs::check_shape(ArgShape::Index) ── rules::index_method / name literal / collisions
      ▼                                                (PR A stops here — IR untouched)
    resolve.rs::resolve_indexes ──> ResolvedIndex{ columns, unique, name:Some("x"), type:Some(Gin) }
      │
      ├── postgres.ts renderIndexDdl(ifNotExists) ─> CREATE INDEX IF NOT EXISTS "x" ON "T" USING gin ("a","b");
      └── migrate.ts  indexKey/indexDefinition ────> DROP INDEX / CREATE ... USING gin / ALTER INDEX ... RENAME TO

## Interfaces

```rust
// rules.rs — next to REFERENTIAL_ACTIONS / NATIVE_TYPE_RULES
pub const INDEX_METHODS: [&str; 4] = ["btree", "gin", "gist", "hash"];
pub const INDEX_ARG_KEYS: [&str; 2] = ["name", "type"];
pub fn index_method(raw: &str) -> Option<IndexMethod>;   // None ⇒ validation error
pub const MAX_IDENTIFIER_BYTES: usize = 63;

// ir.rs — appended AFTER `name`, so existing snapshot key order is untouched
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum IndexMethod { Btree, Gin, Gist, Hash }

pub struct ResolvedIndex {
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)] pub name: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none", default)]
    pub index_type: Option<IndexMethod>,   // never Btree — canonicalized to None
}
```

```ts
// packages/core/src/ir.ts
export interface ResolvedIndex {
  columns: string[];
  unique: boolean;
  name?: string;
  /** Postgres index method (`USING <method>`). Absent ⇒ btree (the default). */
  type?: "gin" | "gist" | "hash" | "btree";
}
```

```ts
// packages/migrator/src/postgres.ts — the single DDL renderer both paths call
export function indexName(table: ResolvedTable, index: ResolvedIndex): string;
export function renderIndexDdl(
  table: ResolvedTable, index: ResolvedIndex, opts?: { ifNotExists?: boolean },
): string;
// CREATE [UNIQUE] INDEX [IF NOT EXISTS] "<name>" ON "<table>" [USING <method>] (<cols>);
// `USING` is omitted entirely when `index.type` is absent ⇒ every existing golden byte-identical.
```

```ts
// packages/migrator/src/migrate.ts — replaces indexSignature
function indexKey(i: ResolvedIndex): string        // `${u|i}:${cols}:${i.name ?? ""}`  (identity, pass 1)
function indexShape(i: ResolvedIndex): string      // `${u|i}:${cols}`                   (rename match, pass 2)
function indexDefinition(i: ResolvedIndex): string // `${indexShape(i)}|${i.type ?? ""}`  (method change)
```

Diff rules in `diffTable`, replacing the `prevIdx`/`nextIdx` block (`migrate.ts:452-475`):

| prev → next | Emission |
|---|---|
| same `indexKey`, same `indexDefinition`, derived name drifted (column rename) | `ALTER INDEX … RENAME TO …` (today's behavior, preserved) |
| same `indexKey`, `type` changed | `DROP INDEX` + `CREATE … USING <new>` (Postgres cannot alter an index method) |
| residual pair, same `indexShape`, name differs, same type | `ALTER INDEX "old" RENAME TO "new"` |
| residual pair, same `indexShape`, name AND type differ | single `DROP INDEX "old"` + `CREATE … "new" USING <new>` |
| residual prev only | `DROP INDEX` (name from `indexName(prevOriginal, original)`) |
| residual next only | `CREATE …` |

Pass 2 pairs only when exactly one residual remains on each side for a given `indexShape`
(same conservatism as `matchColumns`); otherwise both fall through to DROP/CREATE.

## Diagnostics (all `model: Some(..)`, `field: None`)

| Case | Message |
|---|---|
| unknown method | `Invalid @@index type "brin" on model "User". Allowed: btree, gin, gist, hash.` |
| unknown named arg | `Unknown @@index argument "method" on model "User". Known arguments: name, type.` |
| `type` wrong value kind | `Attribute "@@index" on model "User" requires "type" to be an index method identifier.` |
| `name` not a string | `Attribute "@@index" on model "User" requires "name" to be a string literal.` |
| empty / >63 bytes / illegal chars | `Invalid index name "…" on model "User". Index names must be 1–63 characters and must not contain quotes or control characters.` |
| duplicate explicit name | `Duplicate index name "x" on model "User".` |
| collides with a derived name | `Index name "User_email_idx" on model "User" collides with the name derived for another index on the same table.` |
| unique + non-btree | `Attribute "@@unique" on model "User" does not support index type "gin"; unique indexes require btree.` |
| missing positional array | `Attribute "@index" on model "User" requires exactly one array argument.` *(existing text, unchanged)* |

`@@index` spelling in new messages uses the `@@` prefix already produced by `push_unknown`'s
target mapping; the pre-existing `check_shape` message keeps its single-`@` quirk verbatim.

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `crates/indigo-compiler/src/rules.rs` | A | Modify | `ArgShape::Index` (replaces `OneReferenceArray`), `INDEX_METHODS`, `INDEX_ARG_KEYS`, `index_method()`, `MAX_IDENTIFIER_BYTES`, unit tests |
| `crates/indigo-compiler/src/ir.rs` | A | Modify | `IndexMethod` enum only (no `ResolvedIndex` field yet) + serde tests |
| `crates/indigo-compiler/src/validate.rs` | A | Modify | `validate_index_args()` called from `validate_attributes`' model loop; all nine diagnostics |
| `fixtures/16-named-typed-indexes.indigo` + snapshot | A | Create | Accepted forms; golden `validation: []`, `resolved` shows **no** `name`/`type` yet |
| `fixtures/17-rejected-index-args.indigo` + snapshot | A | Create | One instance of each rejection class |
| `packages/compiler/wasm/*` | A, B | Modify | Rebuilt + committed |
| `crates/indigo-compiler/src/resolve.rs` | B | Modify | `resolve_indexes` reads `name`/`type`; btree→`None`; delete the `ResolvedIndex.name` "never emitted" claim in the module doc comment (`resolve.rs:7`) |
| `crates/indigo-compiler/src/ir.rs` | B | Modify | `ResolvedIndex.index_type` field |
| `packages/core/src/ir.ts` | B | Modify | `type?:` union on `ResolvedIndex` |
| `packages/migrator/src/postgres.ts` | B | Modify | Export `indexName`/`renderIndexDdl`; `renderPushSql:284-292` calls it |
| `packages/migrator/src/migrate.ts` | B | Modify | Import shared renderer; `indexKey`/`indexShape`/`indexDefinition`; two-pass index diff |
| `packages/migrator/test/fixtures/index-*/` (5 dirs) | B | Create | `prev/next.indigo` + regenerated `expected.json` |
| `fixtures/snapshots/16-*.json` | B | Modify | Regenerated — now carries `name`/`type` |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Rust unit | `index_method` accepts the 4 spellings, rejects `brin`/`GIN`; `INDEX_ARG_KEYS`; name-length boundary at 63/64 bytes | `rules.rs` `#[cfg(test)]` |
| Rust unit | every diagnostic class fires exactly once with the pinned message; accepted forms produce zero diagnostics | `validate.rs` `#[cfg(test)]` (same shape as the `db_namespace_*` tests) |
| Rust unit | `type: btree` ⇒ `index_type == None`; `type: gin` ⇒ `Some(Gin)`; quoted `type: "gin"` accepted; `IndexMethod` serializes lowercase after `name` and is omitted when absent | `resolve.rs` + `ir.rs` `#[cfg(test)]` |
| Rust corpus | all 17 fixtures compile; 01–15 gain zero new diagnostics | existing `crates/indigo-compiler/tests/fixtures.rs` |
| TS parity | AST + `ResolvedSchema` + `ValidationError` vs goldens; **01–15 byte-identical** | `packages/compiler/test/parity.mjs` |
| Migrator golden | `index-method-added` (none→gin), `index-method-changed` (gin→gist), `index-name-added` (derived→explicit), `index-name-changed` (explicit→explicit ⇒ RENAME, no DROP), `index-name-and-method-changed`, plus `no-changes` regression that `type: btree` diffs empty | `packages/migrator/test/migrator.mjs` (auto-discovers fixture dirs) + `regen-goldens.mjs` |
| Migrator unit | push DDL omits `USING` with no type and emits `USING gin` with one; `IF NOT EXISTS` retained | assertion in the migrator harness' unit section |
| Applicability | new fixtures replay against real Postgres | existing `packages/migrator/test/appliability.mjs` / `replay.mjs` (opt-in, needs a DB) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The WASM rebuild runs through the existing, unchanged `build:wasm`
script and CI `wasm-drift` job. Identifier interpolation is covered: `quoteIdent` escapes `"`,
and decision #10 bounds the name literal anyway.

## Migration / Rollout

Additive; omitting `name`/`type` reproduces today's DDL byte-for-byte. Per-slice toolchain order,
mandatory (CLAUDE.md): `cd crates && cargo test` → `pnpm --filter @indigodb/compiler build:wasm`
(commit the artifact) → `node packages/compiler/test/regen-snapshots.mjs` (diff is the review
artifact; 01–15 must show **no** diff) → `node packages/migrator/test/regen-goldens.mjs` (PR B) →
`pnpm build && pnpm lint && pnpm test` → push and let CI `wasm-drift` self-heal `main`. Never
hand-compare local WASM bytes to committed bytes. Rollback = per-slice `git revert` + rerun the
same sequence; already-written migration files are frozen SQL, so no DB rollback.

## PR Slicing (review budget 800 lines)

Estimated authored diff ≈ 430 lines (goldens/WASM excluded from authored risk): compiler ≈ 250,
migrator ≈ 180. Under budget as one PR, but sliced **by layer**, exactly as
`native-type-attributes` decision #4 did, because the intermediate state matters:

- **PR A — grammar + validation.** `rules.rs`, `validate.rs`, `IndexMethod`, fixtures 16/17, WASM.
  IR deliberately NOT populated, so `postgres.ts`/`migrate.ts` (which already honour
  `index.name`) cannot start emitting renamed indexes while the diff engine still treats a
  name-only change as unchanged. PR A's golden asserts `resolved` carries no `name`/`type`.
  ≈ 250 lines. Verification: `cargo test` + `pnpm test`.
- **PR B — resolve + IR + migrator.** `resolve_indexes`, `ResolvedIndex.index_type`, `ir.ts`,
  shared `renderIndexDdl`, two-pass diff, migrator fixtures, snapshot 16 regen. ≈ 180 lines.
  Verification: `cargo test` + `pnpm test` + regenerated migrator goldens as the review artifact.

`Decision needed before apply: No` · `Chained PRs recommended: Yes` · `800-line budget risk: Low`
(PR B targets PR A's branch per the Feature Branch Chain rule).

## Open Questions

- [ ] None blocking. Non-blocking: whether `@@unique(type: hash)` should be admitted — PG rejects
      unique hash indexes today, so decision #7 rejects it; if a future PG version supports it the
      rule relaxes in `rules.rs` alone.
- [ ] Non-blocking: `apps/studio/src/features/docs/lib/ddl-generator.ts` renders its own DDL and
      will keep ignoring `type` — explicitly out of scope per the proposal, tracked for the Studio
      index-surfacing follow-up.
