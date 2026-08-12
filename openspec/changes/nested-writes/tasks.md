# Tasks: Nested writes

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR A ~250-350, PR B ~450-600, PR C ~350-450 |
| 400-line budget risk | PR A Medium, PR B High, PR C Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR A -> PR B -> PR C |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Metadata (`fkSide`/`optional`/`optionalFk`/`name`) + `runAtomic` seam, no planner logic | PR A | `pnpm --filter @indigodb/generator test`, `pnpm --filter @indigodb/client test` | N/A — pure metadata/type plumbing, no DB behavior change | Revert `types.ts`/`client.ts`/`generator/src/client.ts` additions; scalar-only SQL unchanged |
| 2 | Create planner: 3-phase ordering, connect/connectOrCreate, UNKNOWN_FIELD | PR B | `pnpm --filter @indigodb/client test -- nested-writes-create` | `packages/client/test/pglite-harness.mjs` (real PGlite create scenarios incl. rollback) | Revert planner branch in `delegate.ts`; `create` falls back to scalar-only path from PR A |
| 3 | Update planner: disconnect/set, AMBIGUOUS_UPDATE_TARGET | PR C | `pnpm --filter @indigodb/client test -- nested-writes-update` | `packages/client/test/pglite-harness.mjs` (update rollback + disconnect/set scenarios) | Revert update-planner branch; `update` falls back to PR B state |

## PR A: Metadata + Atomicity Plumbing (Req 4, 5 groundwork, client-transactions)

- [x] A1.1 RED: `packages/generator/test/nested-write-emission.mjs` asserts `RelationMeta.fkSide/optional/optionalFk` and `ModelMeta.name` in emitted `__meta`.
- [x] A1.2 GREEN: `packages/generator/src/client.ts` emits those fields from `core`'s `RelationInfo`.
- [x] A2.1 RED: typecheck fixture (`packages/client/test/fixtures/typecheck-fixture.ts`) expects typed nested-relation members on Create/UpdateInput (no sub-op logic required to compile).
- [x] A2.2 GREEN: `packages/client/src/types.ts` adds `ToOneRelationInput`/`ToManyRelationInput` (+Update variants) and `RunAtomic`; generator references them on Create/UpdateInput.
- [x] A3.1 RED: client unit test asserts `__delegates` 4th arg (`runAtomic`) defaults to identity inside `$transaction`, and to `(fn) => this.$transaction(fn)` at top level.
- [x] A3.2 GREEN: `packages/client/src/delegate.ts` constructor accepts/stores `runAtomic`; `client.ts`'s `$transaction`/`__delegates` wiring passes identity vs. real transaction thunk.
- [x] A4.1 GREEN: `packages/client/src/index.ts` exports new input types.
- [x] A4.2 Verify scalar-only `create`/`update` SQL is byte-identical to pre-change output.

## PR B: Create Planner (Req 1, 2, 5, 6, 7)

- [ ] B1.1 RED: unit tests (stub Executor) for op split — scalars vs. relation ops vs. unknown key -> `UNKNOWN_FIELD`.
- [ ] B1.2 RED: unit tests for 3-phase ordering (fkSide before parent insert, non-fkSide after).
- [ ] B1.3 RED: `pglite-harness.mjs` integration tests — to-one/to-many `create`, `connect`, `connectOrCreate`; `connect` miss -> `CONNECT_NOT_FOUND` + rollback; child failure rolls back parent (Req 7).
- [ ] B1.4 RED: integration test — nested create inside active `$transaction`/`tx.<model>.create` joins the session, no double-open.
- [ ] B2.1 GREEN: implement planner + `runAtomic` phases in `packages/client/src/delegate.ts` `create()`.
- [ ] B2.2 GREEN: add `IndigoNestedWriteError` (extends `IndigoRelationError`) with `code` enum; wire `UNKNOWN_FIELD`/`CONNECT_NOT_FOUND`/`COMPOSITE_RELATION`.
- [ ] B3.1 Verify all B1 RED tests pass GREEN; run full `pnpm --filter @indigodb/client test` + `pnpm lint`.

## PR C: Update Planner (Req 3, 4)

- [ ] C1.1 RED: unit/integration tests for `disconnect`/`set` on to-many via existing `update` (FK = NULL, requires `optionalFk`).
- [ ] C1.2 RED: test — required to-one `disconnect`/`set` throws `REQUIRED_RELATION_DISCONNECT`.
- [ ] C1.3 RED: test — `set: []` disconnects entire linked set, deletes nothing.
- [ ] C1.4 RED: test — relation-ops-only `data` resolves target via `findMany`; >1 match -> `AMBIGUOUS_UPDATE_TARGET`.
- [ ] C2.1 GREEN: implement update planner (phase 2 = `tx[self].update`, phase 3 reads parent key from RETURNING) in `delegate.ts` `update()`.
- [ ] C2.2 GREEN: wire `REQUIRED_RELATION_DISCONNECT`/`AMBIGUOUS_UPDATE_TARGET` error codes.
- [ ] C3.1 Verify all C1 RED tests pass GREEN; run full test suite + `pnpm lint`; update `openspec/changes/nested-writes/design.md` Open Question with chosen `set`-via-`update` behavior confirmation.
