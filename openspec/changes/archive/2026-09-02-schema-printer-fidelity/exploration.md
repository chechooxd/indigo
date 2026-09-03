# Exploration: schema-printer-fidelity

**Change**: `schema-printer-fidelity`
**Phase**: `sdd-explore`
**Engram**: `sdd/schema-printer-fidelity/explore`

Split out of `openspec/changes/studio-erd-designer/exploration.md` as its prerequisite.

---

## The four gaps (confirmed)

`printSchema` (`packages/core/src/print.ts`) claims in its own docstring that it "never guesses —
any IR construct it cannot represent losslessly throws `IndigoPrintError`". It does not. Four
constructs are dropped silently:

| Construct | Behavior |
|---|---|
| relations / foreign keys | emitted as an inert `// @fk(…)` comment; nothing parses `@fk` back |
| `@@allow` | dropped entirely, no error |
| `@@realtime(columns: […])` | collapsed to bare `@@realtime` — strictest declaration becomes loosest |
| `TableGroup` / `color` / `group` | vanish |

`packages/core/test/print.mjs`'s `normalizeForRoundTrip` (~`:540-550`) deletes `color, group,
allow, realtimeColumns` and zeroes `foreignKeys`/`relations` **on both sides** before comparing, so
the round-trip suite is blind to all four by construction.

---

## CORRECTION to the framing this change was opened under

The change was initiated on the claim that this is a **live shipped `db pull` bug** and that fixing
the printer closes it. **That is wrong, and the distinction is the most important finding here.**

`packages/migrator/src/introspect.ts:350` hardcodes `relations: []` (documented at `:302`).
Introspection is a pure DDL scan with no relation-field concept, so a `db pull` schema **carries no
relation IR at all** — only `foreignKeys`, physical constraints with no field names.

Therefore printing `@relation(…)` from `table.relations` — which is fully IR-specified and safe —
does nothing for `db pull`. Closing that path would require **inventing field names**: a forward
field name, a pluralized inverse name, and a disambiguation policy for multiple FKs from one table
to the same target and for self-relations. No pluralize/singularize utility exists anywhere in this
repo. That is a naming-policy design problem, not a read-the-IR problem, and doing it inside
`printSchema` would violate the module's own "never guess" invariant.

It is also **not an oversight**: `openspec/changes/archive/2026-08-18-indigo-schema-printer/design.md`
named it as an explicit out-of-scope follow-up when the printer shipped, and
`packages/migrator/test/pull-roundtrip.mjs:81-82` pins the current behavior as correct:

```js
ok(!text.includes("@relation"), …);
ok(text.includes("@fk("), …);
```

So `db pull`'s FK loss is a **documented known limitation with a test guarding it**, not a silent
regression. Still a real gap for a user, but a different change.

---

## Recommended scope — "Scope C"

**In**: print `@relation(…)` from `table.relations` when populated; print `@@allow`; print
`@@realtime(columns:)`; print `TableGroup`; rewrite `normalizeForRoundTrip` so the round-trip
compares the full IR with only justified exclusions.

**Out**: synthesizing relation field names for introspected schemas. `printFkComment` **stays** as
the honest fallback when a `ForeignKey` has no matching relation metadata — it is still exactly what
`db pull` needs until that follow-up lands. Do **not** touch `pull-roundtrip.mjs`.

**Also in**: make the residual gap visible — a module docstring note, so the limitation is stated
rather than silently re-closed.

## Relation printing design

For each `ResolvedRelation` in `table.relations` (IR order, printed after scalar columns;
interleaving is not preserved, matching existing precedent):

- Type text: `${targetModel}${list ? "[]" : optional ? "?" : ""}`.
- **FK-holding side** (`fkColumns.length > 0`): `@relation(${name-part}fields: […], references: […]${onDelete}${onUpdate})`,
  mapping physical → field names via the existing `fieldNameFor`. The positional name part is
  `"${relationName}", ` only when `relationName` is present.
- **Inverse / unpaired side** (`fkColumns.length === 0`): bare `${name} ${type}`, plus
  `@relation("${relationName}")` only when `relationName` is present (the named-multi-relation case,
  `fixtures/12-relation-naming.indigo`).
- `onDelete`/`onUpdate` are **not** on `ResolvedRelation` — they must be cross-referenced from
  `table.foreignKeys` by exact `columns` array equality (reusing `schemaActionFromSql`). There is no
  IR back-pointer from a `ForeignKey` to its producing relation field. Column-set equality is
  unambiguous for every existing fixture but is **not IR-guaranteed unique** in a pathological case
  (two relation fields on one table with identical FK column sets to the same target). On ambiguity
  it MUST throw `IndigoPrintError` — never silently pick the first match.
- **FK constraint `name:` is unrepresentable.** `.indigo`'s `@relation` has no `name:` argument
  (`name:` exists only on `@@index`/`@@unique`), and `resolve_relations` hardcodes `name: None`
  (`resolve.rs:267`) — `ForeignKey.name` is populated only by introspection. It must be a
  documented, narrow round-trip exclusion, not a silent drop.

## `@@allow` printing

`ResolvedTable.allow` is `AllowRule[]`. One `@@allow(${action}, ${left} == ${right})` per entry, in
IR order, with **no re-collapsing** of `write`/`all` aliases (already expanded 1:4; re-collapsing
risks getting the alias heuristic wrong). The comparison vocabulary is closed to `==`
(`validate.rs:875` rejects anything else), so no `op` field is missing from the IR.

Operand printing is a **new** function, not `printAttributeValue`: `{kind:"field",name}` →
`this.${fieldNameFor(table, name)}` (the name is already a physical `dbName`);
`{kind:"claim",name}` → `auth.${name}`; scalars follow `printAttributeValue`'s literal rules.
`print.ts:85-93`'s throwing `path`/`comparison` guard is for the unrelated `datasource.url` path and
remains a genuine dead branch — leave it.

## `@@realtime(columns:)` and `TableGroup`

Mechanical. `realtimeColumns !== undefined` → `@@realtime(columns: [...])` **even when empty**
(RCP-7 — a distinct valid state); else if `table.realtime` → bare `@@realtime`.
`ResolvedSchema.tableGroups` mirrors declared blocks verbatim rather than deduplicating to final
ownership (`04-tablegroup-edge.indigo`'s "last group wins" case), so it — not the derived
`table.color`/`table.group` — is the correct print source. Emit each as a top-level block after the
tables.

## Blast radius

`printSchema` has 11 call sites: `packages/cli/src/util.ts` (`db pull` — unaffected under this
scope), `packages/core/test/print.mjs` (rewritten), `packages/migrator/test/pull-roundtrip.mjs`
(unaffected, confirmed — introspected schemas still take the `// @fk(…)` fallback), and archived
docs. **No `fixtures/snapshots/` or `parity.mjs` dependency — no golden regeneration needed.**

`UNPRINTABLE_FIXTURES` currently excludes `05-relations.indigo` for an unrelated reason (duplicate
model name + dangling `@relation` field refs make `fieldNameFor` throw). That exclusion is
unaffected and should stay.

## Sizing and split

~450–670 authored lines total — fits the 800 budget with limited margin. Recommended as two stacked
PRs:

- **PR 1 — the mechanical three**: `@@allow`, `@@realtime(columns:)`, `TableGroup`, ~200–300 lines,
  zero ambiguity.
- **PR 2 — relations**: `printRelation`, the FK cross-reference, and the remaining
  `normalizeForRoundTrip` rewrite, ~250–370 lines, stacked on PR 1.

The existing 17-fixture corpus (`04`, `07`, `08`, `12`, `18`, `20`) likely covers the needed
scenarios without new fixtures.

## Risks

1. **Framing** (highest): this change does **not** fix `db pull`'s FK loss. It must say so loudly,
   in the proposal and in the archive report.
2. FK `onDelete`/`onUpdate` cross-reference by column-set equality has no IR-level uniqueness
   guarantee — must throw on ambiguity.
3. FK constraint `name:` is unrepresentable in `.indigo` — a documented exclusion, not a silent drop.
4. `pull-roundtrip.mjs` encodes the OLD behavior as its correctness assertion. If a future
   name-synthesis change lands, those assertions invert and must be rewritten deliberately.
