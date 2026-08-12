# Proposal: Nested writes (`create` / `connect` / `connectOrCreate` / `disconnect` / `set`)

## Intent

Relations are readable (`include`) but not writable. Writing an aggregate today means: INSERT parent, read back the id, INSERT children — by hand, with no transaction unless the user wraps it themselves, so a mid-sequence failure leaves orphans. Worse, relation keys in `data` are not merely unsupported: `create`/`update` map every `data` key through `meta.fields[f]?.db ?? f`, so a relation key falls through as a literal column name and emits broken SQL. This change makes `db.user.create({ data: { …, posts: { create: [...] } } })` work, atomically, closing roadmap Phase 2 epic "Nested writes".

## Scope

### In Scope
- Relation sub-operations on `create` and `update` `data`, one level deep: `create`, `connect`, `connectOrCreate` (both cardinalities); `disconnect`, `set` (to-many, plus **optional** to-one).
- Atomicity: every nested write runs in one transaction via the existing `$withSession` seam; already inside a user `$transaction`, it joins that session instead of nesting.
- Ordering: to-one child written before the parent INSERT (FK lives on the parent row); to-many children written after, with the parent key injected.
- Codegen: `<Model>CreateInput`/`<Model>UpdateInput` gain typed relation members; `__meta` relations gain the nullability/`optional` flag the runtime needs to reject `disconnect`/`set` on a required relation.
- Typed errors for unsupported shapes (composite-key relation, required-relation disconnect, `connect` matching no row).

### Out of Scope
- Depth ≥ 2 (`create: { child: { create: … } }`) — follow-up.
- Nested `update`, `updateMany`, `delete`, `deleteMany`, `upsert`; top-level `upsert`.
- `disconnect`/`set` on a **required** to-one relation (rejected with a typed error, not silently deleted).
- Composite-key relations (already excluded from `<Model>Relations`).
- `include` on the `create`/`update` return value — both still return the flat parent row.

## Capabilities

### New Capabilities
- `client-nested-writes`: relation sub-operation semantics, execution order, atomicity, error taxonomy.

### Modified Capabilities
- `client-query-type-safety`: `CreateInput`/`UpdateInput` now accept relation members, not scalars only.
- `client-transactions`: nested writes must join an in-flight `$transaction` rather than opening a second one.

## Approach

Reuse the direction-collapsed `RelationMeta { target, from, to, list }` already emitted for `include` — the same `from`/`to` pair that drives read stitching drives write key propagation, so no new relation model is introduced. `ModelDelegate` splits `data` into scalars and relation ops, then plans: to-one children first (their `to` value becomes the parent's `from` column), parent INSERT/UPDATE, to-many children last (parent's `from` value written into the child's `to` column). Every child write is delegated to the sibling delegate's own `create`/`update`, never a new SQL builder. `connect` = child UPDATE setting the FK; `connectOrCreate` = `findUnique` then branch; `disconnect` = FK to NULL; `set` = disconnect-all + connect-listed. `__delegates` gains a fourth argument — a `runAtomic` thunk: `this.$withSession` from the constructor, identity from `$transaction` (already scoped).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/delegate.ts` | Modified | Op splitting, write planner, sub-op executors |
| `packages/client/src/types.ts` | Modified | `RelationCreateInput` union, `optional` on `RelationMeta` |
| `packages/client/src/client.ts` | Modified | Expose an atomic-run seam to delegates |
| `packages/generator/src/client.ts` | Modified | Relation members in Create/Update inputs; `optional` in `__meta`; `__delegates` signature |
| `packages/client/test/`, `packages/generator/test/` | New | Per-cardinality, per-op, rollback tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| XL scope busts the 800-line review budget in one PR | High | Slice by op family (see Open Questions); chained PRs |
| Atomic seam double-opens a transaction inside `$transaction` | Med | Identity thunk from `$transaction`; explicit nesting test |
| `disconnect`/`set` orphans rows on a required relation | Med | Typed error at runtime + `optional` flag in `__meta` |
| Input-type unions degrade `Payload` inference | Med | Type-level fixture test before runtime work |

## Rollback Plan

Additive: relation members on inputs are optional; existing scalar-only calls emit identical SQL. Revert the client + generator commits and re-run `indigodb generate`. No DB state, no migration.

## Dependencies

- `transactions-epic` (archived) — `$withSession` / `$transaction`.
- `relations-include-select` (archived) — `RelationMeta`, sibling registry.

## Open Questions

1. **Slicing.** Full epic is likely 3 review-sized PRs: (A) `create` + to-one ops, (B) `create` + to-many ops, (C) `update` + `disconnect`/`set`. Confirm chaining, or cut scope to A+B only for this change.
2. **`connect` miss.** Throw, or silently no-op? Proposal assumes throw.
3. **`set` on an empty array.** Disconnect-all, or reject? Proposal assumes disconnect-all.

## Success Criteria

- [ ] `create`/`connect`/`connectOrCreate` work for to-one and to-many, verified against the PGlite harness
- [ ] A failing child write rolls back the parent (no orphans)
- [ ] Nested write inside a user `$transaction` does not throw "cannot be nested"
- [ ] `disconnect`/`set` on a required relation is a typed error, not data loss
- [ ] Scalar-only `create`/`update` emit byte-identical SQL to today
