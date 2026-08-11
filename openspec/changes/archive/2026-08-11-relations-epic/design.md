# Design: Relations Epic — Slice 1: Relation Identity & Pairing in the IR

## Technical Approach

Three additive edits to `crates/indigo-compiler`, mirrored in `packages/core/src/ir.ts`:

1. `resolve_relations` reads the positional `@relation` name (`positional_arg(rel_attr, 0)` — the helper already exists at `ast.rs:130`, used by `first_string`) into a new `relation_name: Option<String>`. The parser already stores positional args with an empty `name` (`parser.rs:285-292`), so no parser change.
2. A new pairing post-pass in `resolve()` runs after `tables` is built (loop instead of the current `.map(...).collect()` at `resolve.rs:219-259`), where all models are visible.
3. `validate.rs` gains an ambiguity diagnostic next to `validate_implicit_many_to_many`.

**Blocking discovery (not in the proposal):** `validate_relation_args` (`validate.rs:266-270`) currently emits *"Attribute `@relation` … does not accept positional arguments"* for **any** positional arg. `@relation("Name", …)` is a hard validation error today. That check must be relaxed to allow exactly one positional **string**; a second positional or a non-string positional keeps the existing message verbatim (parity contract).

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Pairing mechanism | Two-phase: read-only index of `(table_idx, rel_idx, source, target, name, holds_fk)` → compute writes → apply mutably to `tables` | Restructure into a flat relation list re-attached to models | Avoids borrow conflicts without changing IR field order (serde order is the JSON contract) |
| Where ambiguity errors live | `validate.rs` only; `resolve()` never errors — an unresolvable pair simply stays unpaired | Fail inside `resolve` | `resolveSchema`/`validateSchema` are separate WASM entry points; resolve has no error channel and already degrades gracefully (`.get(r) ?? r`) |
| Inverse-side semantics | Populate paired `fkColumns`/`refColumns` + new `inverse?: true` flag | Populate silently, no flag | On an inverse side those columns live on `targetModel`, not the owning table. `apps/studio/src/features/docs/lib/relations.ts:15` would render a wrong FK line without a discriminator |
| Ambiguity trigger | ≥2 unnamed candidates on one side **and** ≥1 unnamed candidate on the other, after name-matching removes named pairs | Only "all unnamed" | Partial naming leaves the unnamed remainder just as indeterminate. Requiring an observable other side avoids false positives on FK-only schemas |

## Pairing Algorithm

Per unordered model pair `{A,B}` (self-relations: `A == B`, a field is never its own inverse):

    partition candidates → fkHolders (fkColumns non-empty) | inverses
    1. name-match: each named fkHolder pairs with the inverse carrying the same name
       (0 or >1 match → ambiguity error)
    2. implicit: remaining unnamed pair iff exactly one unnamed fkHolder and
       ≤1 unnamed inverse remain          ← Decision 3, naming stays opt-in
    3. otherwise → ambiguity error, reported once per {A,B} via a
       `HashSet<(String,String)>` (same pattern as validate_implicit_many_to_many)

Writes are applied **only** to inverse sides (empty `fkColumns`) whose pair holds a FK; an FK-holder is never overwritten. Duplicate model names resolve first-match-wins, matching the existing `find`-based convention.

## Interfaces

```rust
// ir.rs, appended to ResolvedRelation (field order = JSON contract)
#[serde(skip_serializing_if = "Option::is_none", default)]
pub relation_name: Option<String>,
/// `true` or absent — never `false` (parity with `realtime`).
#[serde(skip_serializing_if = "Option::is_none", default)]
pub inverse: Option<bool>,
```

`ir.ts` mirror: `relationName?: string; inverse?: boolean;`. The `name` doc comment ("Relation field name") is correct today and stays; `fkColumns`/`refColumns` doc comments gain the inverse-side caveat.

Diagnostic message: `Ambiguous relation between "A" and "B": multiple relation fields target the same model. Disambiguate with @relation("Name", ...) on both sides.`

## File Changes

| File | Action | Description |
|---|---|---|
| `crates/indigo-compiler/src/resolve.rs` | Modify | Read positional name; pairing post-pass; `.map` → loop |
| `crates/indigo-compiler/src/ir.rs` | Modify | `relation_name`, `inverse` on `ResolvedRelation` |
| `crates/indigo-compiler/src/validate.rs` | Modify | Relax positional-arg check; new `validate_relation_ambiguity` |
| `crates/indigo-compiler/tests/fixtures.rs` | Modify | New unit tests; extend the `corpus_validation_errors_*` table |
| `packages/core/src/ir.ts` | Modify | TS mirror + corrected doc comments |
| `apps/studio/src/features/docs/lib/relations.ts` | Modify | Branch on `inverse` so the FK line stays truthful |
| `fixtures/12-relation-naming.indigo` | Create | Two named `User↔Post` relations + one unnamed `User↔Profile` — zero validation errors |
| `fixtures/13-ambiguous-relations.indigo` | Create | Two unnamed relations to one target — pins the new error in `validation` |
| `fixtures/snapshots/*.json` | Modify | Regenerated (deliberate) |
| `packages/compiler/wasm/` | Modify | Rebuilt artifact |

New fixtures follow the `NN-name.indigo` convention (next free: 12, 13) and live in `fixtures/`, not `fixtures/errors/` — the latter is for **parse** failures only; validation errors belong in a valid fixture's golden (as `05` already proves).

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit (Rust) | positional name read; named/implicit/self pairing; ambiguity trigger incl. partial naming; positional-arg validation relaxation | `crates/indigo-compiler/tests/fixtures.rs`, `validate_src` helper |
| Golden | full IR shape across the corpus | `fixtures/snapshots/*.json` |
| Regression (Node) | WASM boundary parity | `packages/compiler/test/parity.mjs` |

Order (repo convention, CLAUDE.md): `cd crates && cargo test` → `pnpm --filter @indigodb/compiler build:wasm` → `pnpm --filter @indigodb/compiler build` → `node packages/compiler/test/regen-snapshots.mjs` (intentional) → `node packages/compiler/test/parity.mjs` → commit the rebuilt `packages/compiler/wasm/` and let CI `wasm-drift` self-heal byte differences on `main`.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No data migration. IR additions are optional keys; older `.snapshot.json` files deserialize unchanged (`default` on both new fields).

## Open Questions

- [ ] `05-relations.indigo` **will** gain the new ambiguity diagnostic (`Post.author` + `Post.ghost` both target `User`, with `User.posts` as an observable inverse). Correct behavior, but it changes a pinned approval test — call it out in review.
- [ ] `08-self-relation.indigo` is unaffected (one FK leg, no inverse). Fixing its documented false-positive m2m diagnostic stays **out of scope** — it lives in `validate_implicit_many_to_many`, which this change does not touch.
