# Tasks: Named and Typed Indexes

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~430 authored (PR A ~250, PR B ~180); goldens/WASM excluded |
| 400-line budget risk | Low (per-PR; 800-line session budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR A (grammar+validation) -> PR B (resolve+IR+migrator) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain (PR B targets PR A's branch) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Grammar/legality (ArgShape::Index) + diagnostics, IR enum only, no DDL change | PR A | `cd crates && cargo test` | `node packages/compiler/test/parity.mjs` | revert rules.rs/validate.rs/ir.rs + fixtures 16/17 + wasm; 01-15 stay byte-identical |
| 2 | resolve.rs populates ResolvedIndex.index_type + migrator name/method-aware DDL and diff | PR B (base = PR A branch) | `cd crates && cargo test` then `pnpm --filter @indigodb/migrator test` | `node packages/migrator/test/migrator.mjs` (goldens) + opt-in `appliability.mjs`/`replay.mjs` against real PG | revert resolve.rs/ir.rs field/core ir.ts/postgres.ts/migrate.ts + migrator fixtures + snapshot 16 regen; PR A stays valid standalone |

## PR A: Grammar + Validation (rules.rs, validate.rs, ir.rs enum, fixtures 16/17)

### Phase A1: IR foundation

- [x] A1.1 Add `crates/indigo-compiler/src/ir.rs::IndexMethod` enum {Btree,Gin,Gist,Hash} with `#[serde(rename_all = "lowercase")]`; do NOT add `index_type` field to `ResolvedIndex` yet (IR stays unpopulated in PR A per design).

### Phase A2: RED — rules.rs shape tests

- [x] A2.1 RED: write `rules.rs` unit tests for `index_method("btree"|"gin"|"gist"|"hash")` -> `Some(IndexMethod::_)`, `index_method("brin")`/`index_method("GIN")` -> `None`.
- [x] A2.2 RED: write `rules.rs` unit test asserting `ArgShape::Index` legality table accepts one positional array + optional `name`/`type` named args on `@@index`/`@@unique`, and that `@index`'s existing "requires exactly one array argument" message is unchanged (parity contract, decision #1).

### Phase A3: GREEN — rules.rs

- [x] A3.1 GREEN: add `INDEX_METHODS: [&str; 4]`, `INDEX_ARG_KEYS: ["name","type"]`, `MAX_IDENTIFIER_BYTES = 63`, `index_method(&str) -> Option<IndexMethod>` to `rules.rs`.
- [x] A3.2 GREEN: replace `ArgShape::OneReferenceArray` with `ArgShape::Index` (one positional array + optional named `name`/`type`); delete `OneReferenceArray` (only users were `@@index`/`@@unique`) and update `check_shape` call sites; run A2.1/A2.2 to pass.

### Phase A4: RED — validate.rs diagnostics

- [x] A4.1 RED: add `validate.rs` test fixtures/cases (or inline unit tests) for each new diagnostic, asserting exact pinned message text from design:
  - Invalid `@@index` type "brin" -> "Invalid @@index type ... Allowed: btree, gin, gist, hash."
  - Unknown `@@index` argument "method" -> "Unknown @@index argument ... Known arguments: name, type."
  - `type` not an index-method identifier -> "requires \"type\" to be an index method identifier."
  - `name` not a string literal -> "requires \"name\" to be a string literal."
  - Invalid name length/chars (>63 bytes, contains `"`/control char) -> "Index names must be 1-63 characters and must not contain quotes or control characters."
  - Duplicate explicit name on same table.
  - Explicit name collides with a derived name (including derived single-column `@unique` names).
  - `@@unique(type: gin|gist|hash)` -> "does not support index type ...; unique indexes require btree."
- [x] A4.2 RED: add test confirming `type: btree` (explicit) does NOT trigger any diagnostic and is accepted identically to omitted type (decision #4 canonicalization scope stays in resolve.rs for PR B, but validation must accept it here).

### Phase A5: GREEN — validate.rs

- [x] A5.1 GREEN: add `validate_index_args` (called from `validate_attributes`'s model loop) implementing method-enum check, name well-formedness (1-63 bytes, no `"`/control chars), table-scoped uniqueness against explicit names + derived `@@index`/`@@unique` names + derived single-column `@unique` names (replicate `migrate.ts::indexName` formula), and `@@unique` method restriction to btree; wire all pinned diagnostic strings from A4.1; run A4.1/A4.2 to pass.

### Phase A6: Fixture corpus

- [x] A6.1 Add `crates/fixtures/16-named-typed-indexes.indigo` covering explicit name, explicit type (gin/gist/hash/btree), and both together; add `crates/fixtures/snapshots/16-*.json` expecting `validation: []` and resolved IR showing NO name/type yet populated (PR A leaves resolve.rs untouched).
- [x] A6.2 Add `crates/fixtures/17-rejected-index-args.indigo` covering every diagnostic case from A4.1; add matching `.snapshots` fixture asserting each diagnostic fires exactly once with the pinned message.
- [x] A6.3 Run `cd crates && cargo test` (native `tests/fixtures.rs` corpus check) and confirm fixtures 01-15 emit zero new diagnostics.

### Phase A7: WASM rebuild + parity (mandatory per CLAUDE.md)

- [x] A7.1 Run `pnpm --filter @indigodb/compiler build:wasm` and commit the rebuilt `packages/compiler/wasm/` artifact.
- [x] A7.2 Regenerate compiler golden snapshots for fixtures 16/17 only via `node packages/compiler/test/regen-snapshots.mjs` (targeted to new fixtures); confirm 01-15 snapshots are byte-identical (no diff).
- [x] A7.3 Run `node packages/compiler/test/parity.mjs` (full regression harness) and `pnpm build && pnpm lint && pnpm test` from repo root; all green. **DEVIATION**: `cargo test`, `pnpm build`, `pnpm lint` are fully green. `parity.mjs`/`pnpm test` show exactly 1 pre-existing, unrelated failure — `13-ambiguous-relations.indigo`'s `ValidationError[]` array is emitted in a different (but equally valid, same-set) order than the committed golden. Root-caused to `validate_relation_ambiguity`'s `HashMap<(String,String), Vec<Candidate>>` iteration order, which is not guaranteed stable across WASM rebuilds — confirmed unrelated to this change (not touched by PR A; fixture 13 predates named-typed-indexes) and consistent with `rust-toolchain.toml`'s documented "CI is the source of truth for these bytes, not any contributor's local rebuild" caveat. Fixture 13's golden snapshot was left untouched (reverted after regen) to keep 01-15 byte-identical, honoring the stricter of the two mandates. See apply-progress / final report for full evidence.

## PR B: Resolve + IR + Migrator (base = PR A branch)

### Phase B1: RED — resolve.rs

- [x] B1.1 RED: add `resolve.rs`/corpus-level Rust tests asserting `resolve_indexes` populates `ResolvedIndex.name` from explicit `name:` and `ResolvedIndex.index_type` from explicit `type:` — accepting BOTH bare-identifier and quoted-string forms (decision #2) — while `type: btree` (explicit or omitted) resolves to `None` (decision #4). **DEVIATION from literal task wording**: an omitted `name:` resolves to `None`, NOT an auto-derived `${table}_${cols}_idx` — auto-derivation stays a migrator-side concern (`postgres.ts`/`migrate.ts`'s existing `index.name ?? derived` fallback, and design decision #8's `indexKey = ...:${name??""}`). Deriving it in `resolve.rs` would have populated a `name` key on fixtures 01/02/03's pre-existing unnamed `@@index`/`@@unique` attributes, breaking the CLAUDE.md-mandated "01-15 byte-identical" invariant.

### Phase B2: GREEN — resolve.rs + ir.rs field

- [x] B2.1 GREEN: add `#[serde(rename = "type", skip_serializing_if = "Option::is_none", default)] index_type: Option<IndexMethod>` to `ResolvedIndex` in `ir.rs`, declared last field (after `name`).
- [x] B2.2 GREEN: implement `resolve_indexes` reading `name`/`type` per B1.1; delete the stale `resolve.rs:7` doc comment claiming "ResolvedIndex.name never emitted"; run B1.1 to pass.
- [x] B2.3 Update fixture 16's snapshot (`crates/fixtures/snapshots/16-*.json`) to now show resolved `name`/`type` values; regenerate via `node packages/compiler/test/regen-snapshots.mjs` scoped to fixture 16; confirm 01-15 remain byte-identical.

### Phase B3: TS type mirror

- [x] B3.1 Add `type?: "btree" | "gin" | "gist" | "hash"` to `ResolvedIndex` in `packages/core/src/ir.ts`, matching the serde contract (absent key === TS `undefined`).

### Phase B4: RED — postgres.ts shared DDL helpers

- [x] B4.1 RED: write `packages/migrator/test/index-ddl.mjs` unit tests for a new exported `indexName(table, index)` and `renderIndexDdl(table, index, { ifNotExists })` in `postgres.ts`, asserting: `USING <method>` omitted when `type` absent (byte-identical to pre-change DDL), included when present; explicit `name` used verbatim; `IF NOT EXISTS` present only when `ifNotExists: true`.

### Phase B5: GREEN — postgres.ts

- [x] B5.1 GREEN: export `indexName`/`renderIndexDdl` from `postgres.ts`, replacing the inline name-derivation/CREATE-INDEX logic at `postgres.ts:284-292`; run B4.1 to pass.
- [x] B5.2 Confirm push-DDL output for fixtures with no name/type is unchanged (byte-for-byte) versus pre-change behavior. Verified via `no-changes`/`native-type-override` goldens (unaffected) and the new `index-no-changes-btree-explicit` fixture (B8).

### Phase B6: RED — migrate.ts two-pass index diff

- [x] B6.1 RED: write `packages/migrator/test/migrator.mjs`-style golden fixture cases (new dirs under `packages/migrator/test/fixtures/`) for each diff scenario, asserting the migration SQL output:
  - `index-method-added` (implicit btree -> `type: gin`): DROP+CREATE USING gin, not a no-op.
  - `index-method-changed` (gin -> gist): DROP+CREATE USING gist.
  - `index-name-added` (derived name -> explicit `name:`): ALTER INDEX RENAME, not a no-op.
  - `index-name-changed` (explicit name A -> explicit name B): ALTER INDEX RENAME, no DROP.
  - `index-name-and-method-changed`: single DROP+CREATE (not two separate statements).
  - `index-no-changes-btree-explicit`: `type: btree` explicit vs. implicit btree diffs to empty (regression guard for decision #4).

  **DEVIATION**: `index-method-added`/`index-method-changed`/`index-name-and-method-changed` were authored with `gin`/`gist` on a `String` (text) column, matching the task wording literally. The appliability suite (`test/appliability.mjs`, real PGlite/PostgreSQL execution) caught that PostgreSQL registers NO default operator class for GIST on any IndigoDB scalar type (text, jsonb, ...) without an extra extension (e.g. `btree_gist`) — and none for GIN on plain `text` either (only jsonb/array/tsvector). Fixed by: (1) switching the covered column to `Json` (-> jsonb, has default GIN and HASH opclasses) for `index-method-added`/`index-method-changed`, and (2) using `gin -> hash` instead of `gin -> gist` for `index-method-changed` and `hash` instead of `gist` in `index-name-and-method-changed`. GIST is deliberately not exercised in an appliability-tested fixture — the diff-engine logic (DROP+CREATE on a method change) is identical regardless of which method is chosen; only the concrete method spelling changed. Also fixed a real bug this caught: `renderIndexDdl` initially placed `USING <method>` AFTER the column list (`(cols) USING gin`), which is a Postgres syntax error — correct placement is `ON "table" USING gin (cols)`, matching the design doc's own Interfaces section. Fixed before any golden was committed.
- [x] B6.2 RED: import `postgres.ts`'s `renderIndexDdl`/`indexName` into `migrate.ts` tests (or via the migrator harness) to assert `migrate.ts` no longer duplicates name-derivation/CREATE-INDEX text independently (decision #9, prevents `USING` drift). Covered by `packages/migrator/test/index-ddl.mjs` (direct unit coverage of the shared helpers) plus every `index-*` golden fixture exercising `migrate.ts`'s `createIndex`, which now delegates to `renderIndexDdl`.

### Phase B7: GREEN — migrate.ts

- [x] B7.1 GREEN: import `indexName`/`renderIndexDdl` from `postgres.ts` into `migrate.ts` (mirrors existing `quoteIdent`/`renderColumn` imports).
- [x] B7.2 GREEN: replace `indexSignature` (`migrate.ts:452-475`) with the two-pass matcher: `indexKey = ${u|i}:${cols}:${name??""}` (pass 1 full identity), `indexShape = ${u|i}:${cols}` + `indexDefinition = ${indexShape}|${type??""}` (pass 2 residual match, mirroring `matchColumns` conservatism — only pairs when exactly one residual per side).
- [x] B7.3 GREEN: implement diff rules per design: same key+definition/derived-name-drift -> RENAME; same key, type changed -> DROP+CREATE USING new; residual same shape, name differs -> RENAME; residual name+type differ -> single DROP+CREATE; residual prev-only -> DROP; residual next-only -> CREATE. Run B6.1/B6.2 to pass.

### Phase B8: Migrator golden regen

- [x] B8.1 Add the 6 new fixture dirs under `packages/migrator/test/fixtures/` (index-method-added, index-method-changed, index-name-added, index-name-changed, index-name-and-method-changed, index-no-changes-btree-explicit) with `prev.indigo`/`next.indigo` inputs.
- [x] B8.2 Run `node packages/migrator/test/regen-goldens.mjs` to generate expected SQL for the new fixtures only; review the diff as the change artifact (per CLAUDE.md snapshot-regen convention); confirm pre-existing goldens are untouched (`git status` showed only the 6 new fixture dirs as untracked, zero modified files).
- [x] B8.3 Run `pnpm --filter @indigodb/migrator test` (full `migrator.mjs` + `native-type.mjs` + `index-ddl.mjs` + `appliability.mjs` + `replay.mjs` harness, auto-discovers fixture dirs); all green.

### Phase B9: WASM rebuild + full regression (mandatory per CLAUDE.md — crates/ touched again in resolve.rs/ir.rs)

- [x] B9.1 Run `pnpm --filter @indigodb/compiler build:wasm` and commit the rebuilt `packages/compiler/wasm/` artifact (reflects resolve.rs changes). **Not committed** — per orchestrator instruction ("Do NOT commit/push"), the rebuilt artifact is staged as an uncommitted working-tree change alongside the rest of PR B.
- [x] B9.2 Run `node packages/compiler/test/parity.mjs`; confirm fixture 16 now shows populated name/type in resolved IR and fixtures 01-15/17 remain byte-identical.
- [x] B9.3 Run `cd crates && cargo test` (native) and `pnpm build && pnpm lint && pnpm test` (full monorepo) from repo root; all green (modulo the pre-existing, documented fixture-13 HashMap-ordering flake from PR A — see below).

### Phase B10: Documentation

- [x] B10.1 Update any inline comment/doc referencing the old `indexSignature` single-key diff behavior in `migrate.ts` to describe the two-pass matcher.
- [x] B10.2 Confirm `resolve.rs`'s deleted "name never emitted" comment (B2.2) has no other stale references (grep `never emitted` in crates/). Verified: only remaining hit is `resolve.rs:7`'s own (already-updated) doc comment, which correctly now says only `ForeignKey.name` is never emitted.

## Key Learnings

1. PR A intentionally leaves `ResolvedIndex.index_type` unpopulated so the migrator's existing name-aware DDL cannot silently emit a rename before the diff engine is fixed in PR B.
2. Every crates/ change in this PR pair requires its own `build:wasm` + `parity.mjs` rerun (PR A and PR B each touch crates/ independently).
3. The two-pass index diff key (`indexKey` then `indexShape`/`indexDefinition`) exists specifically to distinguish rename-only from method-only from combined changes without colliding same-column indexes.
4. `type: btree` must canonicalize to `None` in resolve.rs, or explicitly declaring the default method would falsely trigger DROP+CREATE.
