# Proposal: Relation loading (`include` + typed `select`)

## Intent

Slice 1 (`relations-epic`) paired relations in the IR; nothing consumes them. Generated clients still expose flat rows only: `db.user.findMany()` can never reach `user.posts`, forcing users back to `$queryRaw`. This slice makes IndigoDB an ORM at the read boundary. It also closes an inherited defect: `select` narrows the emitted SQL but never the TS return type, so `include` would ship type-dishonest on day one.

## Scope

### In Scope
- `include: { relation: true }` on `findMany`/`findFirst`/`findUnique`, one level deep.
- Nested scalar `select` inside an included relation.
- Return-type narrowing (`GetPayload`-style) for both `select` and `include`.
- Relation metadata (target table, fk/ref columns, cardinality) in `__meta`.
- Regression test: realtime NOTIFY refetch stays flat.

### Out of Scope
- Single-JOIN strategy (documented future optimization).
- `_count: { relation: true }` → follow-up `relation-count-aggregate` (new `GROUP BY` shape).
- Nested `include` depth ≥ 2 → follow-up.
- Relation filters/order/pagination inside `include`; nested writes; IR changes.

## Capabilities

### New Capabilities
- `client-relation-loading`: `include` semantics, batching, stitching, empty/null results.
- `client-query-type-safety`: return types narrow to exactly the requested scalars + relations.

### Modified Capabilities
- None.

## Approach

Batched-by-parent-ID (approach 2/3 from exploration). Parent query is unchanged, so `LIMIT`/`OFFSET` stay correct. Per included relation, one follow-up `WHERE fk = ANY($n)` over the parent PK set, stitched in memory. Round trips = 1 + distinct relations, never per-row. Reuses `Params`/`buildWhere`/`selectList`; no query-builder is introduced. JOIN is rejected as MVP: it requires row de-duplication plus JOIN-safe pagination that no code in the repo has.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/generator/src/client.ts` | Modified | Relation metadata in `__meta`; include/payload types |
| `packages/client/src/types.ts` | Modified | `include?`, `GetPayload` conditional types |
| `packages/client/src/delegate.ts` | Modified | `loadRelations` batch+stitch |
| `packages/client/src/realtime-delegate.ts` | Verified | Must stay flat |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `GetPayload` generics blow up effort | High | Time-box; fallback: optional relation fields on `Row` |
| Stitching bugs (null FK, empty child, composite keys) | Med | Table-driven tests per cardinality |
| Scope creep into `_count`/depth-2 | Med | Explicitly deferred above |

**Correction (orchestrator, post-proposal)**: this proposal's original risk table claimed a new client test harness was needed because "9 of 10 packages have zero tests." That's stale — `transactions-epic` (archived 2026-08-11) already gave `@indigodb/client` a 21-test PGlite/pg.Pool-backed harness (`test/client.mjs`, `test/transactions.mjs`, `test/transactions-pg.mjs`) and `@indigodb/generator` a 2-file harness (`test/enum-mapping.mjs`, `test/transaction-emission.mjs`). This change extends those existing harnesses with new `include`/`select`/`GetPayload` test files — it does not need to build one from scratch.

## Rollback Plan

Additive only: `include` is optional, existing calls unchanged. Revert the two package commits and regenerate the client; no migration or DB state involved.

## Dependencies

- `relations-epic` (archived) — relation pairing in the IR.

## Decisions (user-confirmed, post-proposal)

All four open questions confirmed the proposal's own recommendation, unchanged: depth-1 `include` for this slice (depth-2 as a stated follow-up); `_count` ships as a separate `relation-count-aggregate` change, not bundled here; if `GetPayload` generics prove intractable mid-implementation, ship with the optional-relation-fields-on-`Row` fallback rather than blocking the change; `include` does not support `where`/`orderBy`/`take` in this slice (cheap to add later under the same batching mechanism, deferred to keep this change's type surface bounded).

## Success Criteria

- [ ] `include` returns correct data for 1-1, 1-N, and N-1 with empty/null cases
- [ ] `select`/`include` return types narrow; excluded fields are compile errors
- [ ] Round trips = 1 + number of included relations
- [ ] Realtime refetch and all existing calls unchanged
