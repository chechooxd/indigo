# Design: Schema printer fidelity

**Change**: `schema-printer-fidelity` · **Phase**: `sdd-design` · **Engram**: `sdd/schema-printer-fidelity/design`

Implements the proposal (`proposal.md`). The proposal settled *whether*; this settles *how*, and
corrects two of its stated mechanics that do not survive contact with `resolve.rs`.

---

## Three input corrections, verified before designing

### 1. `fkColumns.length > 0` is the WRONG FK-holder discriminator

The proposal and exploration both say the FK-holding side is `fkColumns.length > 0`. It is not.
`pair_relations` (`resolve.rs:592-597`) **writes the holder's `fk_columns`/`ref_columns` onto the
paired inverse side** and sets `inverse: Some(true)`. So `User.authoredPosts Post[]`
(`12-relation-naming`) carries `fkColumns: ["authorId"]` — a column that lives on `Post`, not on
`User`. Printing it as a holder emits `fields: [authorId]` on `User` and `fieldNameFor` throws.

**Correct discriminator: `rel.inverse !== true && rel.fkColumns.length > 0`.**

### 2. Two more fixtures become unprintable — say it out loud

`@@allow` and `@@realtime(columns:)` operands are physical `dbName`s that must map back through
`fieldNameFor`. Two "rejected" fixtures deliberately carry dangling references that `resolve.rs`
records verbatim (unknown names fall through to `unwrap_or_else(|| name.clone())`):

| Fixture | Construct | Resolved IR | Printer |
|---|---|---|---|
| `19-rejected-allow` | `@@allow(read, auth.userId == this.owner)` (`UnknownField`) | `{kind:"field", name:"owner"}`; no column has that `dbName` | throws |
| `21-rejected-realtime-columns` | `@@realtime(columns: [id, ghostField])` (`UnknownColumn`) | `realtimeColumns: ["id","ghostField"]` | throws |

Both join `UNPRINTABLE_FIXTURES` **in PR 1**, each with a written per-fixture reason and a pinned
throw assertion — the same category as `05-relations.indigo`, which stays excluded (its `ghost`
relation's `missingLocal` now throws inside `printRelation` instead of `printFkComment`; update that
comment, keep the exclusion). Rejected: falling back to the raw `dbName` when no column matches —
that silently prints an unresolvable reference and destroys the `fieldNameFor` mutation proof.

These are **fixture** exclusions (the printer provably throws), not **normalizer** field exclusions
(the printer silently drops). Only the second kind is what this change exists to eliminate.

### 3. `ForeignKey.name` needs no normalizer exclusion

Measured: the corpus yields 21 FKs, **none** with a constraint name — `resolve.rs:267` hardcodes
`name: None`, so only introspection can produce one. Decision below.

---

## Technical Approach

`printTable` gains one pass that partitions `table.foreignKeys` into *claimed* (matched by a relation
field) and *orphan* (introspected), then emits relations as fields and orphans as `// @fk(…)`
comments. Everything else is read straight off the IR.

```
ResolvedTable ──┬─ columns ─────────────→ scalar field lines ─┐
                ├─ relations ───────────→ relation field lines ┴─→ one aligned block
                │        ↕ claimFks() (columns[] + refTable equality)
                ├─ foreignKeys (orphans) → // @fk(…) comments
                └─ indexes/realtime/allow/note → block attributes
ResolvedSchema.tableGroups ──────────────→ trailing TableGroup blocks
```

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| D1 | FK-holder test is `inverse !== true && fkColumns.length > 0` | `fkColumns.length > 0` (proposal) | `pair_relations` back-fills inverse sides; see correction 1 |
| D2 | Claim FKs by `columns` deep-equality **and** `refTable === target.dbName` | `columns` alone | `columns` alone can collide across two targets; the extra term is free and narrows the ambiguity window |
| D3 | Ambiguity throws in **both** directions: a relation matching ≥2 FKs, and an FK claimed by ≥2 relations | pick-first; last-wins | "Never guess". Column-set equality is not IR-guaranteed unique |
| D4 | A **claimed** FK carrying `name` throws `IndigoPrintError`; an **orphan** FK keeps `name:` in its comment | normalizer exclusion for `ForeignKey.name`; silent drop | `.indigo`'s `@relation` has no `name:` argument, so printing it is impossible and dropping it is a silent loss. Unreachable in the corpus (0/21) and unreachable via `db pull` (orphans only), so throwing costs nothing and closes the hole permanently |
| D5 | Relation fields are appended to the **same** aligned field block, after all scalars, in IR order | separate unaligned block; interleaving | Interleaving is unrecoverable from the IR; joint padding keeps output diff-stable and matches how a human writes `.indigo` |
| D6 | New `printAllowOperand`, not `printAttributeValue` | extend `printAttributeValue` | Its `path`/`comparison` throw guard (`print.ts:85-93`) belongs to the `datasource.url` path and must stay a dead branch |
| D7 | Block-attribute order becomes `@@map → @@unique → @@index → @@realtime → @@allow → @@note` | `@@allow` first | Keeps the existing order assertion green; `@@allow` reads naturally next to `@@realtime` |
| D8 | `TableGroup` blocks print top-level **after** all tables, in `schema.tableGroups` order, `color = "…"` first then members | derive from `table.color`/`table.group` | Source order is what makes `04-tablegroup-edge`'s "last group wins" re-derive identically; the derived fields cannot reconstruct overlap |
| D9 | Emit `fields:`/`references:` only when the corresponding array is non-empty | always emit, `references: []` | Avoids emitting a degenerate empty list for the (validation-rejected) `@relation(fields:)`-only shape |

## Interfaces

```ts
/** Relation → its claimed ForeignKey. Throws IndigoPrintError on any ambiguity. */
function claimForeignKeys(
  schema: ResolvedSchema, table: ResolvedTable,
): { fkFor: Map<ResolvedRelation, ForeignKey | undefined>; orphans: ForeignKey[] };

function printRelationField(
  schema: ResolvedSchema, table: ResolvedTable,
  rel: ResolvedRelation, fk: ForeignKey | undefined,
): { name: string; type: string; attrs: string[] };

function printAllowOperand(table: ResolvedTable, op: AllowOperand): string;
function printAllowRule(table: ResolvedTable, rule: AllowRule): string;
function printTableGroup(group: ResolvedTableGroup, indent: string): string;
```

### `printRelationField` — exact algorithm

```
type   = `${rel.targetModel}${rel.list ? "[]" : rel.optional ? "?" : ""}`
holder = rel.inverse !== true && rel.fkColumns.length > 0

if (!holder):
    attrs = rel.relationName === undefined ? [] : [`@relation(${quote(relationName)})`]
else:
    args = []
    if (rel.relationName !== undefined) args.push(quote(rel.relationName))   // positional, FIRST
    if (rel.fkColumns.length)  args.push(`fields: [${map(fieldNameFor(table, ·))}]`)
    if (rel.refColumns.length) args.push(`references: [${map(fieldNameFor(targetTable, ·))}]`)
    if (fk?.onDelete) args.push(`onDelete: ${schemaActionFromSql(fk.onDelete)}`)
    if (fk?.onUpdate) args.push(`onUpdate: ${schemaActionFromSql(fk.onUpdate)}`)
    attrs = [`@relation(${args.join(", ")})`]
```

`targetTable` is `schema.tables.find(t => t.name === rel.targetModel)`; missing → throw (same shape
as `printFkComment`'s unknown-refTable throw).

**Walked: `08-self-relation.indigo`** — `Category.parent`: `inverse` absent, `fkColumns ["parentId"]`
→ holder. One FK `{columns:["parentId"], refTable:"Category"}` claims it; no actions.

```
parent   Category? @relation(fields: [parentId], references: [id])
```

No `// @fk(…)` line for `Category` (its only FK is claimed).

**Walked: `12-relation-naming.indigo`** — `User.authoredPosts`/`reviewedPosts` are name-paired
inverses (`inverse: true`, `fkColumns` back-filled) → **not** holders, `relationName` present.
`User.profile` is an implicitly-paired inverse, no `relationName` → bare. `Post.author`/`reviewer`
are holders with distinct `columns` → unambiguous claim, both FKs consumed.

```
Table User {
  id            Int      @id @default(autoincrement())
  authoredPosts Post[]   @relation("PostAuthor")
  reviewedPosts Post[]   @relation("PostReviewer")
  profile       Profile?
}

Table Post {
  id         Int  @id @default(autoincrement())
  authorId   Int
  reviewerId Int
  author     User @relation("PostAuthor", fields: [authorId], references: [id])
  reviewer   User @relation("PostReviewer", fields: [reviewerId], references: [id])
}
```

### `claimForeignKeys` — matching, ambiguity, orphans

For each `rel` where `holder` is true: `matches = table.foreignKeys.filter(fk =>
arrayEq(fk.columns, rel.fkColumns) && fk.refTable === targetTable.dbName)`.

- `matches.length > 1` → throw (`Table "X": relation field "y" matches N foreign keys with identical
  column set […] — cannot determine onDelete/onUpdate`).
- an FK already claimed by another relation → throw (`… claimed by both "a" and "b"`).
- `matches.length === 0` → `fk = undefined`; the relation prints with no action args. (Reachable
  only for the `references:`-less shape, D9.)
- Claimed FK with `fk.name !== undefined` → throw (D4).
- **Orphans** = every FK claimed by nobody → `printFkComment`, unchanged. `relations: []`
  (introspected `db pull` IR) ⇒ every FK is an orphan ⇒ today's output byte-for-byte.

Claimed FKs are removed from the comment list; without this the output would carry **both** a
`@relation(…)` and a `// @fk(…)` for the same constraint. Asserted (T7).

### `printAllowRule` / `printAllowOperand`

`@@allow(${rule.action}, ${left} == ${right})` — `==` is the closed vocabulary (`validate.rs:875`).

| Operand kind | Emission |
|---|---|
| `field` | `this.${fieldNameFor(table, op.name)}` — `op.name` is a physical `dbName` |
| `claim` | `auth.${op.name}` |
| `string` | `quoteString(op.value)` |
| `number` / `boolean` | `String(op.value)` |

One line per `AllowRule`, IR order, no alias re-collapsing (`write` → 3 lines, `all` → 4).

### `@@realtime`

`realtimeColumns !== undefined` → `@@realtime(columns: [${cols.map(c => fieldNameFor(table, c))}])`,
**including `[]`**; else `table.realtime` → bare `@@realtime`; else nothing.

### `printTableGroup`

```
TableGroup "Name" {
  color = "#hex"        // only when group.color !== undefined
  <member>              // one per group.tables entry, verbatim, in order
}
```

`04-tablegroup-edge` round-trips because groups are printed in `tableGroups` order, so re-resolving
replays `group_by_table`'s last-wins overwrite and reproduces both `tableGroups` **and** every
derived `table.color`/`table.group`. A member literally named `color` (that fixture's `Table color`)
re-parses correctly: `parse_table_group` treats a bare identifier not followed by `=` as a member.

## The `normalizeForRoundTrip` rewrite

Target reached: **exactly one exclusion.**

```js
/**
 * Round-trip normalization. ONE divergence remains, and it is an ordering
 * artifact, not a dropped field:
 *
 * Index/unique ordering — the spec's fixed block-attribute order emits every
 * `@@unique` before every `@@index`, so re-resolving printed text yields
 * `indexes` re-bucketed (all `unique: true` first in original relative order,
 * then all `unique: false`) rather than interleaved as fixture 16 writes them.
 * That is the printer's designed emission order, not a loss, so the expected
 * side is re-bucketed identically.
 *
 * Everything else — foreignKeys, relations, tableGroups, color, group, allow,
 * realtimeColumns — is now printed and compared in full. Adding an exclusion
 * here re-opens the exact blind spot this change closed: any new entry MUST
 * name the IR field and why it is unrepresentable, and MUST be called out in
 * the verify report.
 */
function normalizeForRoundTrip(resolved) {
  return {
    ...resolved,
    tables: resolved.tables.map((t) => ({
      ...t,
      indexes: [...t.indexes.filter((i) => i.unique), ...t.indexes.filter((i) => !i.unique)],
    })),
  };
}
```

Deleted: `tableGroups: []`, `foreignKeys: []`, `relations: []`, and the `color, group, allow,
realtimeColumns` destructure. `ForeignKey.name` needs no entry (D4).

## File Changes

| File | Action | Authored lines (PR) | Description |
|---|---|---|---|
| `packages/core/src/print.ts` | Modify | ~55 (PR 1) / ~105 (PR 2) | `printAllowRule`+`printAllowOperand`, `@@realtime(columns:)`, `printTableGroup`; then `claimForeignKeys`, `printRelationField`, relation rows in `printFieldLines`, narrowed docstring |
| `packages/core/test/print.mjs` | Modify | ~150 (PR 1) / ~145 (PR 2) | Unit tests T1–T13, `UNPRINTABLE_FIXTURES` → reasoned map + 19/21, `normalizeForRoundTrip` rewrite in two halves |
| `openspec/specs/schema-printing/spec.md` (delta) | Modify | ~60 (PR 1) / ~55 (PR 2) | Owned by `sdd-spec`; PR 1 = `@@allow`, `@@realtime` columns, `TableGroup`; PR 2 = narrowed FK requirement + named exclusions |
| `packages/migrator/test/pull-roundtrip.mjs` | **Unchanged** | 0 | Orphan-FK path is byte-identical |
| `packages/cli/src/util.ts`, `fixtures/*`, `fixtures/snapshots/` | **Unchanged** | 0 | No new fixtures, no golden regeneration |

`Decision needed before apply: No` · `Chained PRs recommended: Yes` · `400-line budget risk: Medium`

### Slice boundary — the proposal's two PRs hold, with one added obligation

| PR | Adds | Deletes from normalizer | ~lines |
|---|---|---|---|
| **1 — mechanical three** | `@@allow`, `@@realtime(columns:)`, `TableGroup`; fixtures 19+21 → `UNPRINTABLE_FIXTURES` | `tableGroups`, `color`, `group`, `allow`, `realtimeColumns` | ~265 |
| **2 — relations** | `claimForeignKeys`, `printRelationField`, ambiguity + FK-`name` throws, docstring | `foreignKeys: []`, `relations: []` | ~305 |

**Disjointness verified, with a caveat the proposal missed.** The two normalizer exclusion sets are
genuinely disjoint, so each PR is independently green and independently revertible. But
`UNPRINTABLE_FIXTURES` is a **shared** structure: PR 1 adds 19+21 and PR 2 edits 05's comment. PR 2
must not re-litigate 19/21, and reverting PR 1 must remove 19+21 while leaving 05. Stated here so
the revert is mechanical rather than a merge puzzle.

## Testing Strategy

Runner: `node packages/core/test/print.mjs` (after `pnpm build --filter=@indigodb/core`).
**RED** = fails against the current tree. **GREEN-TODAY** = passes now; it is a guard, not proof.

| # | Scenario | Test | Fails today because | Status |
|---|---|---|---|---|
| T1 | `@@allow` printed, one line per rule, IR order | unit: `Article` shape, 2 `read` rules | nothing prints `@@allow` at all | **RED** |
| T2 | `this.<field>` uses the schema field name, not `dbName` | unit: `@map`ped `ownerId → owner_id`, assert `this.ownerId`, assert `!includes("owner_id")` | no output. Mutation proof: swapping `fieldNameFor` for the raw `dbName` must fail this | **RED** |
| T3 | `write`/`all` print expanded, never re-collapsed | round trip `18-allow-rules` | `allow` is deleted by the normalizer | **RED** (after PR 1's deletion) |
| T4 | `@@realtime(columns: [])` is a distinct printed state | unit + `20-realtime-columns`: assert text contains `@@realtime(columns: [])` **and** re-resolved `realtimeColumns` `deepStrictEqual []`, not `undefined` | prints bare `@@realtime`; re-resolves to `undefined` | **RED** |
| T5 | `TableGroup` overlap re-derives | round trip `04-tablegroup-edge` + explicit assert on `A.group === "NoColor"` and `A.color === undefined` | `tableGroups` zeroed and `color`/`group` deleted on both sides | **RED** |
| T6 | Relation printing, both sides | round trip `12-relation-naming`, `08-self-relation`, `07-referential-actions`; plus text asserts for the two blocks quoted above | `relations`/`foreignKeys` zeroed; `@relation(` never emitted | **RED** |
| T7 | A claimed FK emits **no** `// @fk(…)` | unit: 1 holder + 1 FK → assert `includes("@relation(")` **and** `!includes("// @fk(")` | no `@relation(` is emitted | **RED** |
| T8 | Orphan FK still prints `// @fk(…)` | unit: `foreignKeys:[…]`, `relations: []` (the `db pull` shape) | — passes now, and must keep passing; guards the non-goal | **GREEN-TODAY** |
| T9 | Ambiguous claim throws | unit: two relations, identical `fkColumns`+target, two identical FKs → `throws(…, IndigoPrintError)` | `printRelation` does not exist, so it throws for the wrong reason. Mutation proof: implement pick-first and this must fail | **RED (weakly)** — see below |
| T10 | Claimed FK with `name` throws (D4) | unit: holder relation + FK carrying `name` | same weak-RED caveat as T9 | **RED (weakly)** |
| T11 | Relation fields print after all scalars | unit: assert `indexOf(relation line) > indexOf(last scalar line)` | no relation line exists | **RED** |
| T12 | 05/19/21 resolve but `printSchema` throws | existing `UNPRINTABLE_FIXTURES` loop, extended | 19/21 do not throw today (they silently drop) — the assertion is new | **RED for 19/21**, GREEN-TODAY for 05 |
| T13 | Purity + LF-only over the new constructs | existing tests re-run on an IR carrying allow/groups/relations | — | **GREEN-TODAY** |
| T14 | Full-corpus round trip with the rewritten normalizer | the fixture loop | deleting any single exclusion fails immediately — that failure *is* the bug report | **RED** |

**Adversarial reading of this table.** T8 and T13 could pass against the current tree and prove
nothing on their own; they are listed as guards and labelled. T9/T10 are the weakest rows: a
`throws(…, IndigoPrintError)` assertion passes today for the *wrong* reason (any hand-built relation
IR currently produces no relation output and the FK comment path may throw elsewhere). The
assertions must therefore additionally pin the message — `err.message.includes("matches")` /
`includes("claimed by both")` / `includes("constraint name")` — so they cannot be satisfied by an
unrelated throw. Without that they are theatre. The load-bearing evidence for this change is T14
plus T1/T4/T6/T7, which cannot pass without the printer actually emitting the construct.

`pull-roundtrip.mjs` (`ok(!text.includes("@relation"))`) is the cross-package regression proof for
T8 and must stay green unmodified.

Root gate: `pnpm clean && pnpm build --force && pnpm lint && pnpm test`.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. `printSchema` is a pure `(ResolvedSchema) -> string` function.

## Migration / Rollout

No migration. No persisted state, wire format, generated-client surface, WASM artifact, or golden
snapshot is touched. Per-PR revert restores the previous printer plus its own normalizer exclusions.

## Rejected Alternatives

| Rejected | Why |
|---|---|
| Synthesize relation field names so `db pull` emits `@relation(…)` | Requires inventing names + a pluralizer + a disambiguation policy — a naming-policy problem that violates "never guess". Deferred to `db-pull-relation-synthesis` |
| Add a `ForeignKey → relation` back-pointer to the IR | Cross-package IR + `resolve.rs` + WASM rebuild + snapshot regeneration, to remove an ambiguity that is unreachable in practice |
| Keep a `ForeignKey.name` normalizer exclusion | An exclusion for a field that appears 0 times in 21 FKs is exactly the unfalsifiable habit this change ends (D4) |
| Fall back to the raw `dbName` when an allow/realtime operand has no column | Prints an unresolvable reference silently and voids T2's mutation proof |
| Re-collapse expanded `@@allow` actions to `write`/`all` | Needs a heuristic that can be wrong; expansion is what the IR states |

## Open Questions

- [ ] None blocking. Confirm with `sdd-spec` that the delta names the residual exclusions as
      (a) index re-bucketing in the normalizer and (b) the three unprintable fixtures — the design
      asserts there is nothing else.
