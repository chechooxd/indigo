# Design: Nested writes

## Technical Approach

`ModelDelegate.create`/`update` gain a **planner** in front of the existing SQL builders. It splits `data` into scalars and relation ops (keys present in `meta.relations`), then executes three phases inside one session: FK-side children → parent row → non-FK-side children. Every child write re-enters a *sibling delegate's own* `create`/`update` — no new SQL path, mirroring `relations-include-select`'s read stitching. Scalar-only calls skip the planner entirely and emit byte-identical SQL.

Confirmed decisions: 3 chained PRs (A to-one create, B to-many create, C update + disconnect/set); `connect` miss throws; `set: []` disconnects all.

## Architecture Decisions

### Decision: `list` is insufficient to order writes — emit `fkSide`

**Choice**: `RelationMeta` gains `fkSide: boolean` (`!rel.inverse`), `optional: boolean` (field-level, as briefed) and `optionalFk: boolean` (nullability of the FK column backing the pair), plus `ModelMeta.name`.
**Alternatives**: infer order from `list`; carry only `optional`.
**Rationale**: a **one-to-one inverse** side has `list: false` but the FK on the *other* table, so `list` mis-orders it. `optional` describes the *field*; for a to-many the `disconnect`/`set` gate needs the *child's* FK nullability, which only `optionalFk` carries. `name` lets the planner find its own session-bound delegate.

### Decision: atomicity via `runAtomic`, a 4th `__delegates` argument

**Choice**: `RunAtomic = <T>(fn: (tx: SiblingRegistry) => Promise<T>) => Promise<T>`. Constructor passes `(fn) => this.$transaction(fn)`; `$transaction`'s own `__delegates(exec, realtime)` omits it, defaulting to the identity `(fn) => fn(reg)`.
**Alternatives**: call `$withSession` from the delegate; a nesting-aware flag on the client.
**Rationale**: the `AsyncLocalStorage` guard in `$withSession` is untouched and can never double-open, because inside a user `$transaction` the thunk is *already* identity. No new public client API.

### Decision: reuse `IndigoRelationError` as the base of a new subclass

**Choice**: `IndigoNestedWriteError extends IndigoRelationError` with a `code` field: `UNKNOWN_FIELD`, `COMPOSITE_RELATION`, `CONNECT_NOT_FOUND`, `REQUIRED_RELATION_DISCONNECT`, `UNKNOWN_RELATION_OP`, `AMBIGUOUS_UPDATE_TARGET`, `NO_ATOMIC_SEAM`.
**Alternatives**: a standalone class; plain `Error`.
**Rationale**: callers already catching `IndigoRelationError` keep working; `code` gives programmatic branching the message strings cannot. An unknown `data` key today silently becomes a column name — it now throws `UNKNOWN_FIELD`.

### Decision: relation input unions live in `packages/client/src/types.ts`

**Choice**: hand-write `ToOneRelationInput<C, R>` / `ToManyRelationInput<C, R>` (+ `…UpdateInput` variants adding `disconnect`/`set`); the generator only references them, using `Omit<ChildCreateInput, "<to>">` for to-many children and relaxing the parent's `from` column to optional when a to-one op can supply it.
**Alternatives**: emit per-model conditional types.
**Rationale**: same reasoning as `Payload` (Decision #4) — type-checked once by the client's own `tsc --noEmit` instead of debugged through emitted text.

## Data Flow

    create({ data })
      split ──→ scalars | relOps | unknown → throw UNKNOWN_FIELD
        │
        runAtomic(tx) ────────────────────────────────────────┐
          1. fkSide ops:  create → child[to];  connect →      │
             findUnique or throw CONNECT_NOT_FOUND;           │
             connectOrCreate → findUnique ?? create           │
             ⇒ scalars[from] = value                          │
          2. tx[self].create({ data: scalars })  → parent     │
          3. non-fkSide ops (child[to] = parent[from]):       │
             create → tx[target].create                       │
             connect → tx[target].update, no row ⇒ throw      │
             connectOrCreate → update, no row ⇒ create        │
             disconnect/set → FK = NULL (needs optionalFk)    │
        ←──────────────────────────────── COMMIT / ROLLBACK ──┘

`update` is identical except phase 2 is `tx[self].update` and phase 3 reads the parent key from `RETURNING`. Relation-ops-only `data` (no scalars) reads the target via `findMany` instead of emitting an empty `SET`. More than one matching row + relation ops ⇒ `AMBIGUOUS_UPDATE_TARGET`.

Asymmetry to note: to-one `connect` must `findUnique` (it needs the target's `to` *value*); to-many `connect` uses `update`-and-check-empty (the FK write is the existence check).

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/types.ts` | Modify | `fkSide`/`optional`/`optionalFk` on `RelationMeta`; `name` on `ModelMeta`; relation input unions; `RunAtomic` |
| `packages/client/src/delegate.ts` | Modify | Op split, 3-phase planner, per-op executors, `IndigoNestedWriteError` |
| `packages/client/src/index.ts` | Modify | Export the new error + input types |
| `packages/generator/src/client.ts` | Modify | New meta flags; relation members on Create/Update inputs; `__delegates` 4th arg |
| `packages/client/test/nested-writes*.mjs` | Create | PGlite per-cardinality/per-op + rollback + `$transaction` nesting |
| `packages/generator/test/nested-write-emission.mjs` | Create | Meta flags + emitted input shapes |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modify | Type-level assertions for relation inputs |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Type | Input unions, `Omit` of the FK field, `Payload` unchanged | `test/typecheck.mjs` fixture |
| Unit | Op split, error codes, ordering per cardinality | Node harness with a stub `Executor` recording SQL |
| Integration | Each op × cardinality, rollback on child failure, nesting inside `$transaction`, scalar-only SQL parity | `pglite-harness.mjs` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration. Additive and chained A→B→C; each PR is independently revertable. Regenerating the client is required after upgrading (`__meta` shape changes).

## Open Questions

- [x] `set` on a to-many uses `update` with a non-unique `where` (it updates every match) — acceptable, or add an explicit `updateMany` seam first? **Resolved (PR C)**: confirmed acceptable — `set`/`disconnect` reuse the existing unbounded `update()` (e.g. `set: []` runs `update({ where: { [to]: parentKey }, data: { [to]: null } })`, disconnecting the whole current set before reconnecting any provided entries). No `updateMany` seam introduced.
