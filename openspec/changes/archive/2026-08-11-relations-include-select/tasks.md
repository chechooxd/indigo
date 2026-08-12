# Tasks: Relation loading (`include` + typed `select`)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 900–1200 (generator ~250, client types+delegate ~350, realtime ~30, new tests ~500–600) |
| 800-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (generator: `__meta` relations + `IncludeInput`) → PR 2 (client runtime: types + delegate + realtime + all tests) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
800-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Generator emits relation `__meta`, `<Model>Relations`, `IncludeInput<Rel>`, composite-key rejection at codegen | PR 1 | `node packages/generator/test/relation-emission.mjs` | N/A — pure string-assertion codegen test, no DB | Revert `packages/generator/src/client.ts` diff + new test file; no runtime consumer yet |
| 2 | Client runtime: types.ts conditional types, delegate.ts loadRelations/stitch/join-key-stripping, realtime propagation, full integration suite | PR 2 | `node packages/client/test/relations.mjs` | PGlite via `pglite-harness.mjs` (real batched queries) | Revert `types.ts`/`delegate.ts`/`realtime-delegate.ts` diff + new test file; PR 1 stays independently valid (unused metadata) |

## Phase 1: Generator — Relation Metadata & Types (PR 1)

- [x] 1.1 RED: `packages/generator/test/relation-emission.mjs` — assert `__meta.<Model>.relations` shape `{ target, from, to, list }` for a 1-N holder/inverse pair, a nullable N-1, and a `@map`'d fk column, matching `enum-mapping.mjs`/`transaction-emission.mjs` string-assertion style.
- [x] 1.2 RED: same file — assert `<Model>Relations` interface emission (list vs nullable member types) and `IncludeInput<Rel>` type emission per model.
- [x] 1.3 RED: same file — assert a fixture schema with a composite relation key produces the codegen error/rejection (resolve exact wording/mechanism per 1.4 first).
- [x] 1.4 DECISION: resolve composite-key rejection wording and rejection point (compile-time omission from `<Model>Relations` vs thrown codegen error) before writing 1.3/2.x; record the choice inline as a code comment in `client.ts` at the rejection site.
  - **Resolved**: two-layer rejection, not a single mechanism. (1) COMPILE-TIME OMISSION — composite-key relations are left out of `<Model>Relations` (and therefore `<Model>IncludeInput`, keyed off `keyof <Model>Relations`), so a TS caller cannot even write `include: { relName: true }` for one. (2) RUNTIME MARKER — still recorded in `__meta.<Model>.relations[name]` as `{ target, composite: true }` (no `from`/`to`/`list`), so PR 2's `loadRelations` can detect a bypass (`as any`, plain-JS caller, stale compiled client) and throw one precise typed error naming the relation, instead of a generic "unknown relation" failure. No thrown codegen error — `generateClient` never fails the build for a composite-key relation, it just can't be included. See the inline comment above `relationMetaEntry` in `packages/generator/src/client.ts`.
- [x] 1.5 GREEN: `packages/generator/src/client.ts` — add `generateRelationsInterface(table)`, translate physical fk/ref columns to field names once at generation time, normalize holder/inverse direction into symmetric `{ from, to }`, emit into `__meta[*].relations`.
- [x] 1.6 GREEN: `packages/generator/src/client.ts` — emit `IncludeInput<Rel>` type per model and apply the 1.4 decision for composite keys.
- [x] 1.7 Append `relation-emission.mjs` to `packages/generator/package.json`'s `test` script.
- [x] 1.8 Verify: `pnpm --filter @indigodb/generator build && pnpm --filter @indigodb/generator test`.

## Phase 2: Client Runtime — Types & GetPayload Checkpoint (PR 2)

- [x] 2.1 RED (checkpoint): add a compiled generated-client fixture (or reuse an existing one) and a `tsc --noEmit` narrowing check exercising `select`-only, `include`-only, `select`+`include`, and excluded-field/relation access (expect compile errors) per `client-query-type-safety` scenarios.
- [x] 2.2 GREEN: `packages/client/src/types.ts` — add `RelationMeta`, `ModelMeta.relations?`, `IncludeInput<Rel>` (client-side type surface), `SelectedScalars<Row, S>`, `Payload<Row, Rel, A>`; add `include?` to `FindManyArgs`/`FindFirstArgs`/`FindUniqueArgs`.
- [x] 2.3 CHECKPOINT: run 2.1 against `pnpm --filter @indigodb/client lint`. If narrowing fails (select-literal widening or intersection collapsing under `Promise` inference), apply the confirmed fallback `Payload<Row, Rel, A> = Row & Partial<Pick<Rel, …>>` in `types.ts` and record the fallback decision as a comment above the type. Do not silently ship a half-working conditional type.
- [x] 2.4 Verify: no other package needs changes for the fallback path (confirms design's "one-line change" claim).

## Phase 3: Client Runtime — Delegate Wiring & Batched Load (PR 2)

- [x] 3.1 RED: `packages/client/test/relations.mjs` — 1-N include returns array of full child rows (`posts: true`).
- [x] 3.2 RED: same file — N-1 include with nullable FK: null FK resolves to `post.author === null`.
- [x] 3.3 RED: same file — 1-1 include resolves to a single object, not an array.
- [x] 3.4 RED: same file — empty to-many relation resolves to `[]`, never `undefined`/missing key.
- [x] 3.5 RED: same file — many-to-one across multiple parents sharing one FK: each row gets its own correctly matched object, only 1 batched query issued (assert query/round-trip count).
- [x] 3.6 RED: same file — nested `select` inside `include` narrows child rows to exactly the selected scalars.
- [x] 3.7 RED: same file — round-trip count = `1 + distinct included relations` for multi-relation `include` (e.g. `posts` + `comments` → 3 total queries).
- [x] 3.8 RED: same file — `take`/`skip` on the parent query stay correct and unaffected when `include` is present (pagination scenario).
- [x] 3.9 RED: same file — no `include`/`select` → byte-identical SQL and flat rows vs pre-change baseline (regression).
- [x] 3.10 GREEN: `packages/client/src/delegate.ts` — add 4th generic `Rel`, `siblings?` lazy-thunk ctor arg, private `loadRelations(rows, include)` batching one `findMany({ where: { [to]: { in: keys } } })` per relation via the sibling delegate, bucket-and-stitch by cardinality (`list` → array/`[]`, singular → object/`null`), skip the query entirely when `keys` is empty.
- [x] 3.11 GREEN: wire `loadRelations` into `findMany`/`findFirst`/`findUnique` only when `args.include` is set (zero-cost when absent).
- [x] 3.12 Verify Phase 3 RED tests now pass.

## Phase 4: Join-Key Stripping (PR 2)

- [x] 4.1 RED: `packages/client/test/relations.mjs` — parent `select` (omitting the fk/pk column) combined with `include` still stitches correctly, and the final parent row does NOT contain the fk field unless it was explicitly selected.
- [x] 4.2 RED: same file — child `select` inside `include` (omitting the ref column) still stitches correctly, and the final child row does NOT contain the ref field unless explicitly selected.
- [x] 4.3 GREEN: `packages/client/src/delegate.ts` — force the join-key field into the parent's `selectList` and the child's `selectList` when `include` is present and the key isn't already requested; strip both forced keys from the final result objects after stitching (parent side and child side independently).
- [x] 4.4 Verify Phase 4 RED tests now pass.

## Phase 5: Composite-Key Runtime Rejection (PR 2)

- [x] 5.1 RED: `packages/client/test/relations.mjs` — `include` on a relation whose stitch key spans more than one column throws the typed error defined in task 1.4, before issuing any batched query.
- [x] 5.2 GREEN: `packages/client/src/delegate.ts` — detect composite-key relations in `loadRelations` (or earlier, if 1.4 chose compile-time omission) and throw/reject per the 1.4 decision.
- [x] 5.3 Verify 5.1 passes and confirm consistency with the generator-side decision from 1.4 (no divergent behavior between codegen-time and runtime rejection).

## Phase 6: Realtime Regression (PR 2)

- [x] 6.1 RED: `packages/client/test/relations.mjs` — `RealtimeModelDelegate.dispatch`'s internal `findFirst({ where: event.pk })` call passes no `include`, issues no follow-up batched query, and the emitted realtime payload contains only scalar fields.
- [x] 6.2 GREEN (if needed): `packages/client/src/realtime-delegate.ts` — propagate the `Rel` generic and `siblings?` ctor arg through to `super(...)` only; confirm `dispatch` itself needs no behavioral change.
- [x] 6.3 Verify 6.1 passes.

## Phase 7: Wiring, Cleanup, Full Verification

- [x] 7.1 `packages/generator/src/client.ts` — thread the 4th `Rel` generic through every emitted `ModelDelegate`/`RealtimeModelDelegate` type/site; build `__delegates` registry (`const reg = {}; const siblings = () => reg;`, construct each delegate with `siblings`, fill `reg[ModelName]` post-construction).
- [x] 7.2 Append `relations.mjs` to `packages/client/package.json`'s `test` script.
- [x] 7.3 Regenerate any committed generated-client fixtures used by tests/docs; confirm they compile.
- [x] 7.4 Full verification: `pnpm build && pnpm lint && pnpm test` from repo root.
- [x] 7.5 Confirm proposal's Success Criteria are all met: 1-1/1-N/N-1 include correctness incl. empty/null; select/include narrow types with excluded-field compile errors (or documented fallback); round trips = 1 + relations; realtime and existing calls unchanged.
