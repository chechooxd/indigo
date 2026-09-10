# Exploration: ERD becomes a designer

**Change**: `studio-erd-designer`
**Phase**: `sdd-explore`
**Engram**: `sdd/studio-erd-designer/explore` (obs #890)

The roadmap row has four strands: (a) node create/delete, (b) inline field editing,
(c) relation drawing, (d) persisted positions. This exploration concludes it is **not one
size-L change**, and that a printer prerequisite must land first.

---

## Current State

The ERD is a one-way viewer. `useERDParser` runs `parse → validate → resolve` on every keystroke
of the Monaco buffer and adapts the `ResolvedSchema` into view-model nodes/links via
`schema-adapter.ts`. `ERDCanvas.tsx` supports node **dragging** and preserves position across
re-parses by matching node `id` in previous state — but that state is `useState` in the tab. On
reload, positions are reseeded from a formula (`40 + (idx%3)*320`, `80 + floor(idx/3)*220`).
Nothing persists. `TableNode.tsx` renders read-only field rows; its per-field connection handles
exist but are `isConnectable={false}` scaffolding.

`studio-schema-write-back` (archived `2026-09-02-studio-schema-write-back`) supplies the write
path: `PUT /api/schema/source` with `{source, version}`, content-hash staleness, pre-write compile
validation, atomic write, read-only gate, audit op. It takes a **complete source string** — there is
no partial/patch API — so every ERD edit strategy must converge on full `.indigo` text before
persisting.

---

## The central trap: `printSchema` silently destroys four things

Verified by running the built tree, not by reading.

| IR field | Printed? | Round-trips? |
|---|---|---|
| `table.name`, `dbName` (`@@map`) | yes | yes |
| `columns[]` name/type/nullable/PK/unique/default/nativeType/note | yes | yes |
| `primaryKey` (composite) | yes | yes, but throws if not a subsequence of column order |
| `indexes[]` | yes | yes, but re-bucketed unique-first regardless of original order |
| **`foreignKeys[]` / `relations[]`** | **only as an inert `// @fk(…)` comment** | **NO — dropped** |
| `allow[]` (`@@allow`) | **NO** | **NO** |
| `realtime` | yes, but collapses `columns:[…]` to bare `@@realtime` | — |
| `realtimeColumns[]` | **NO** | **NO** |
| `color` / `group` (`TableGroup`) | **NO** | **NO** |
| `enums[]`, `datasource` | yes | yes |

Demonstrated output for a two-table schema with one relation:

```
relations BEFORE: 1 FK(s)
...
Table Post {
  id       Int @id @default(autoincrement())
  authorId Int

  // @fk(fields: [authorId], references: [id], model: User, onDelete: Cascade)
}
relations AFTER round-trip: 0 FK(s)
```

`printFkComment` (`print.ts:185-203`) literally returns `` `// @fk(${parts.join(", ")})` `` and
nothing in `crates/indigo-compiler` parses `@fk` back — zero matches in `parser.rs`/`resolve.rs`.
The `posts Post[]` back-relation field disappears entirely.

**`print.ts:85-93` has a guard that throws for `path`/`comparison` attribute values, and its own
comment says those "never reach this function today." They do not — because nothing routes `allow`
to it. The module's contract claims it never guesses and throws on what it cannot represent; these
four are silent drops, not throws.**

### The existing round-trip test is blind to all four, by construction

`packages/core/test/print.mjs`'s `normalizeForRoundTrip` (~`:540-550`) deletes
`color, group, allow, realtimeColumns` **and** zeroes `foreignKeys`/`relations` on both sides
before comparing. It compares what survives against what survives. Removing any one of those
normalizations fails the suite immediately against the current tree — a directly runnable
demonstration.

## This is a LIVE bug today, not only a future ERD hazard

`db pull` is a shipped command (`packages/cli/src/index.ts:135`). It calls `writePulledSchema`
(`util.ts:584-589`), which calls `printSchema`. Introspection **does** discover foreign keys
(`introspect.ts:416` — `table.foreignKeys.push(fk)`).

**So `indigodb db pull` against any database with foreign keys already writes a `schema.indigo`
whose relations are inert comments.** Pushing that schema back would create tables with no foreign
keys at all.

`@@allow`, `@@realtime(columns:)` and `TableGroup` are not reachable through `db pull` (they have
no introspection source), so for those three the loss is latent until the ERD or another printer
consumer arrives. The FK loss is not latent.

---

## The central design fork (for `sdd-propose` to decide)

**Option A — regenerate the file via `printSchema`.** Requires closing all four gaps first,
including a real `@relation(...)` emission scheme that survives `resolve.rs`'s pairing logic. Any
missed construct is destroyed **silently**. Also discards user formatting and comments outside what
the IR captures, since the whole file is regenerated.

**Option B — targeted text edits on the source buffer.** The ERD computes a minimal patch, so
everything it does not understand is untouched **by construction** — the same property that made
literal-sentinel substitution the right call in `studio-schema-write-back`. Cost: the AST carries no
source positions. Verified in `packages/ast/src/index.ts` and `crates/indigo-compiler/src/ast.rs`:
no `Model`/`Field`/`Attribute`/`Schema` node has a span. But `parser.rs` already computes per-token
`line`/`column`/`end_line`/`end_column` (used only for `ParseErrorDetail`, ~`:444-447`) and discards
it before AST construction — this is plumbing existing data through, not new infrastructure, though
still a Rust + WASM + serde + `@indigodb/ast` change with the `build:wasm` / freshness-guard /
golden-snapshot ceremony.

**Option C — hybrid.** Patch existing tables; print only brand-new blocks. Narrows Option A's most
dangerous property to net-new content, but still needs correct FK emission for new relations, and
needs a precise, testable patch-vs-print boundary.

**Weighing**: "untouched by construction" deserves the most weight, for the same reason it did in
`studio-schema-write-back` — the completeness of a printer-gap checklist cannot be fully guaranteed,
whereas locating a known, ERD-authored insertion point is a smaller and directly provable surface.

## Strand (d) is different in kind

Node x/y is view layout, not schema semantics. Options: a comment in the `.indigo` file (rejected by
symmetry — that is the fragile pattern already causing silent loss here); a sidecar
`schema.layout.json` with its own versioned route reusing the atomic-write/staleness shape already
built; `localStorage` (cheapest, per-machine); or a Postgres table (matches the roadmap's own exit
criterion "nothing in the UI mutates state that is not persisted to Postgres" most literally,
precedent `_indigo_migrations`, but ties layout to a DB instance rather than the schema file).
**This is a product decision to put to the user, not to resolve here.**

---

## Recommended sequencing

1. **Printer fidelity as its own change, first.** Independently valuable — it closes a shipped
   `db pull` bug — and every ERD option depends on it. Scope: FK/relation emission, `@@allow`,
   `@@realtime(columns:)`, `TableGroup`, and rewriting `normalizeForRoundTrip` so the round-trip
   test stops being blind.
2. **AST span plumbing**, only if Option B or C is chosen.
3. **Node/field CRUD** (a + b) — the smallest strand once the prerequisites land.
4. **Relation drawing** (c) — gated on FK emission being correct.
5. **Persisted positions** (d) — gated on the storage decision; otherwise independent and
   parallelizable.

## Risks

1. Shipping ERD structural edits on an unfixed printer would silently strip `@@allow` and
   `@@realtime(columns:)` from any touched table, and delete every relation in the file — a security
   regression wearing a UI feature's clothes, demonstrated against the current tree.
2. FK loss is already live in `db pull`.
3. Span plumbing is cross-language with its own rebuild/freshness/snapshot ceremony — the largest
   single line-count contributor if Option B/C wins, and easy to underestimate.
4. Persisted-position storage is an unresolved product decision.
5. `TableNode.tsx`'s disabled connection handles are scaffolding; re-read them at design time
   against whatever interaction model is chosen.
