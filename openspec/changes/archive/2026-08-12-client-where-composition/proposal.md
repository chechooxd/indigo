# Proposal: Where Composition and Filters

## Intent

`@indigodb/client`'s `where` is a flat AND-only conjunction of column predicates. Callers cannot express
"A or B", "not A", "posts where any comment is flagged", or any predicate over a `Json` column. Worse,
the current `buildWhere` treats **every** key as a column name, so `where: { OR: [...] }` compiles to
`"OR" = $1` and crashes at runtime with `column "OR" does not exist` — a silent-looking API that fails
only against a live database. This closes Phase 2 epic 1/5 ("Make it an ORM").

## Scope

### In Scope

- **PR A** — `WhereInput` becomes a per-model generated type with recursive `AND?` / `OR?` / `NOT?`
  self-references; `buildWhere` recurses with correct parenthesization through one shared `Params`
  accumulator. Fixes the confirmed runtime bug.
- **PR B** (depends on A) — relation filters `some` / `every` / `none` on to-many relations, compiled as
  correlated `EXISTS` / `NOT EXISTS` subqueries.
- **PR C** (independent of B) — JSON path filters on `Json`/`jsonb` columns via a new filter shape
  (`{ path: string[], equals | gt | lt | ... }`) compiling to Postgres `#>` / `#>>` / `@>`.

### Out of Scope

- `orderBy` composition (same flat shape, different epic).
- To-one relation filters (direct nested object) — deferred unless PR B lands cheaply.
- Aggregate/`_count` filters, full Prisma JSON parity (`string_contains`, `array_contains`).
- Declarative filter injection (soft delete, tenant scoping) — belongs to `client-query-extensions`.

## Capabilities

### New Capabilities

- `client-where-composition`: recursive `AND`/`OR`/`NOT` boolean composition, to-many relation filters
  (`some`/`every`/`none`), and JSON path filters in generated `where` inputs and their SQL compilation.

### Modified Capabilities

- None.

## Approach

Reserve `AND`/`OR`/`NOT` as **structural** keys checked before the per-field loop, never resolved through
`meta.fields`. `buildWhere` recurses, joining sub-clauses with parentheses and threading a single `Params`
instance so `$N` numbering stays correct. The generator emits a self-referential `<Model>WhereInput` per
model, mirroring how `CreateInput`/`UpdateInput` are already generated, reusing `resolveRelationInfo`'s
existing `{target, list, from, to}` metadata for relation-filter keys — no new runtime metadata needed.

Relation filters compile to **correlated subqueries**, not the batch-by-key `IN` loader that `include`
uses: `include` is fetch-time over already-loaded rows, filtering must happen before the outer `SELECT`
runs. These are structurally unrelated code paths; do not size PR B as a reuse of `loadRelations`.

**Explicit decisions for user override:**

1. **Breaking change (deliberate).** `WhereInput<Row>` stops being a flat generic and becomes a per-model
   generated interface. Every generated client's public type surface changes. Accepted per the roadmap's
   "now-or-never" list — nothing is published yet.
2. **`every` uses vacuous truth (Prisma convention).** A parent with zero related rows satisfies `every`,
   compiled as `NOT EXISTS (child WHERE fk = parent AND NOT (filter))`. Familiar to Prisma users; override
   if IndigoDB should require at least one child.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/types.ts` | Modified | `WhereInput` recursive shape; new JSON filter type |
| `packages/client/src/delegate.ts` | Modified | `buildWhere` recursion, EXISTS subqueries, JSON operators |
| `packages/generator/src/client.ts` | Modified | Emit per-model `<Model>WhereInput` |
| `packages/client/test/*` | New | Unit coverage per PR |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `$N` param numbering breaks under recursion | Med | One shared `Params` instance threaded through; assert in tests |
| Breaking public `WhereInput` surface | High (accepted) | Deliberate, roadmap-sanctioned; called out in release notes |
| `every` NULL/vacuous semantics diverge from expectation | Med | Decision stated above; explicit test for zero-children case |
| JSON filter shape overbuilt vs. Prisma parity | Med | Ship `path` + comparison operators only; defer string/array helpers |
| PR B sized as `include` reuse | Med | Proposal states they are distinct SQL paths |

## Rollback Plan

Three independent commits on a chained branch stack. PR C and PR B revert cleanly on their own. PR A's
revert restores the flat `WhereInput` and the pre-existing `OR` crash; since the generator emits the type,
a revert plus `indigodb generate` fully restores prior behavior — no migration or data change involved.

## Dependencies

- None external. PR B depends on PR A; PR C is independent.

## Success Criteria

- [ ] `where: { OR: [{a: 1}, {b: 2}] }` produces valid parenthesized SQL, no `column "OR"` error
- [ ] Arbitrary nesting of `AND`/`OR`/`NOT` yields correct, sequentially numbered `$N` params
- [ ] `some`/`every`/`none` emit correlated `EXISTS`/`NOT EXISTS`; zero-children satisfies `every`
- [ ] JSON path filters compile to `#>`/`#>>`/`@>` and round-trip against Postgres
- [ ] Each PR stays under the 800-line review budget and lands independently green
