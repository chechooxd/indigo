# Tasks: Batch, Aggregate and Cursor Pagination for @indigodb/client

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~700-800 total (4 PRs, ~150-220 each) |
| 400-line budget risk | Medium (per-PR); High if shipped as one PR |
| Chained PRs recommended | Yes |
| Suggested split | PR A -> PR B -> PR C -> PR D |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | createMany/updateMany/deleteMany + EMPTY_WHERE guard | PR A | `node packages/client/test/batch.mjs` | pglite (`pglite-harness.mjs`) | revert `batch.mjs`, delegate/types batch additions |
| 2 | cursor pagination (`cursor`+`skip`+6th generic) | PR B | `node packages/client/test/cursor.mjs` | pglite | revert `cursor.mjs`, findMany cursor branch, `Cursor` generic |
| 3 | aggregate/groupBy/distinct + `numeric` meta bit | PR C | `node packages/client/test/aggregate.mjs && node packages/client/test/typecheck.mjs` | pglite | revert `aggregate.mjs`, aggregate/groupBy/distinct methods, `numeric` meta |
| 4 | upsert + `uniqueGroups` meta | PR D | `node packages/client/test/upsert.mjs && node packages/client/test/typecheck.mjs` | pglite | revert `upsert.mjs`, upsert method, `uniqueGroups` meta |

Base boundary (feature-branch-chain): PR A base = `feature/client-batch-aggregate`; PR B base = PR A branch; PR C base = PR B branch; PR D base = PR C branch.

## PR A: createMany / updateMany / deleteMany

- [x] A.1 RED: `packages/client/test/batch.mjs` — fake-executor test asserting `createMany([])` throws `IndigoArgumentError` code `EMPTY_BATCH` before `exec`.
- [x] A.2 RED: same file — `updateMany`/`deleteMany` with absent/`{}` `where` throw `IndigoWhereError` code `EMPTY_WHERE` before `exec`.
- [x] A.3 RED: same file — `createMany` emits single multi-row `INSERT ... VALUES (...),(...) RETURNING 1` with `Params`-bound values; `count = rows.length`.
- [x] A.4 RED: same file — `updateMany`/`deleteMany` reuse `whereExpr`/`buildWhere`, return `{ count: rows.length }` via `RETURNING 1`.
- [x] GREEN A.5 `packages/client/src/types.ts`: add `CreateManyArgs`/`UpdateManyArgs`/`DeleteManyArgs`/`BatchPayload`.
- [x] GREEN A.6 `packages/client/src/delegate.ts`: add `IndigoArgumentError` (code union starts with `EMPTY_BATCH`), `createMany`/`updateMany`/`deleteMany` per design SQL shapes, no `runAtomic`.
- [x] A.7 `packages/generator/src/client.ts`: emit `<Model>CreateManyArgs`/`UpdateManyArgs`/`DeleteManyArgs` interfaces and delegate method signatures. Closed: `ModelDelegate` gained a 6th defaulted generic `CreateManyInput = CreateInput` (mirrors the `Where` 5th-generic precedent), forwarded through `RealtimeModelDelegate`; the generator emits a scalar-only `<Model>CreateManyInput` (same column set/optionality as `<Model>CreateInput`, every relation key omitted) plus `<Model>CreateManyArgs`/`UpdateManyArgs`/`DeleteManyArgs` type aliases, and passes `<Model>CreateManyInput` as the delegate's 6th generic in `TransactionClient`, `__delegates`, and `IndigoClient`. Verified with a real `tsc --noEmit` compile of generated output (not just string assertions): a scalar-only `createMany` call type-checks, and `{ author: { create: {...} } }` inside `createMany`'s `data` fails with `TS2561` (excess property) when the `@ts-expect-error` is removed — closing spec.md's "Nested relation writes are not accepted" scenario.
- [x] A.8 Integration: `packages/client/test/batch.mjs` pglite suite — real counts for createMany/updateMany/deleteMany happy paths.
- [x] A.9 `pnpm build --filter=@indigodb/client`.
- [x] A.10 `pnpm build --filter=@indigodb/generator` (build-order: client before generator).
- [x] A.11 `pnpm build && pnpm lint && pnpm test` (full monorepo, closing gate).

## PR B: Cursor Pagination

- [x] B.1 RED: `packages/client/test/cursor.mjs` — composite-PK model with `cursor: {...}` throws `IndigoArgumentError` code `CURSOR_COMPOSITE_PK` before `exec` (runtime pk-count guard).
- [x] B.2 RED: same file — model with no PK and `cursor` set throws code `CURSOR_NO_PK`.
- [x] B.3 RED: same file — single-PK model: `cursor` + `skip: 1` emits `WHERE ... AND "pk" >= $c` and appends `"pk" <dir>` as final `ORDER BY` term only when absent from user `orderBy`.
- [x] B.4 RED: same file — cursor combines correctly with existing `where`/`orderBy`/`take` (all reused unmodified).
- [x] GREEN B.5 `packages/client/src/types.ts`: add defaulted generic `Cursor = never` on `FindManyArgs`/`ModelDelegate` (7th slot — PR A's `CreateManyInput` already claimed the 6th); `cursor`/`skip` on `FindManyArgs`.
- [x] GREEN B.6 `packages/client/src/delegate.ts`: cursor + pk-order-append logic in `findManyImpl`, runtime pk-count guard (`resolveCursorPk`/`cursorDirection`).
- [x] B.7 `packages/generator/src/client.ts`: emit `<Model>CursorInput` only for single-PK models; composite-PK models get `cursor?: never`; thread 7th generic through delegate binding.
- [x] B.8 Integration: `packages/client/test/cursor.mjs` pglite suite — stable pagination across pages, inclusive-cursor-then-skip semantics verified against real rows.
- [x] B.9 `pnpm build --filter=@indigodb/client`.
- [x] B.10 `pnpm build --filter=@indigodb/generator`.
- [x] B.11 `pnpm build && pnpm lint && pnpm test`.

## PR C: aggregate / groupBy / distinct

- [x] C.1 RED: `packages/client/test/aggregate.mjs` — `_sum`/`_avg` on a non-numeric field throws `IndigoArgumentError` code `NON_NUMERIC_AGGREGATE` before `exec`.
- [x] C.2 RED: same file — unknown aggregate field throws code `UNKNOWN_AGGREGATE_FIELD`; empty aggregate selection throws code `EMPTY_AGGREGATE`.
- [x] C.3 RED: same file — `aggregate()` emits one `SELECT count(*)::int AS agg0, sum("c")::float8 AS agg1, ... WHERE <expr>` with positional aliases, JS-side descriptor rebuild into `AggregateResult`.
- [x] C.4 RED: same file — `groupBy()` emits `GROUP BY <fields>`, no `having` support (compile-time excluded from arg type).
- [x] C.5 RED: same file — `findMany({ distinct: [...] })` emits `SELECT DISTINCT ON ("a","b") ...` with distinct columns prepended to `ORDER BY` (skipped if already leading terms).
- [x] GREEN C.6 `packages/core/src/ir.ts`: confirm/forward numeric scalar classification (Int/Float/Decimal/BigInt, `!isEnum`) — read-only source, no IR shape change beyond what's already resolved.
- [x] GREEN C.7 `packages/client/src/types.ts`: add `FieldMeta.numeric?: true` (readonly, `as const`-safe), `AggregateArgs`/`GroupByArgs`, `distinct` on `FindManyArgs`, `AggregateResult`.
- [x] GREEN C.8 `packages/client/src/delegate.ts`: `aggregate`/`groupBy` methods, `DISTINCT ON` clause in `findManyImpl`.
- [x] C.9 `packages/generator/src/client.ts`: emit `numeric: true` in `__meta.fields[<name>]`, `<Model>AggregateArgs`/`GroupByArgs`, `distinct` on `FindManyArgs`.
- [x] C.10 Type: `packages/client/test/fixtures/typecheck-fixture.ts` — add `numeric`-gated aggregate narrowing coverage, `// @ts-expect-error` on `_sum` of a non-numeric field.
- [x] C.11 Verify `packages/client/test/typecheck.mjs` still passes against the additive `__meta` (existing fixture compiles unchanged).
- [x] C.12 Integration: `packages/client/test/aggregate.mjs` pglite suite — real `_count`/`_sum`/`_avg`/`_min`/`_max` values, `groupBy` grouping, `DISTINCT ON` row identity.
- [x] C.13 `pnpm build --filter=@indigodb/client`.
- [x] C.14 `pnpm build --filter=@indigodb/generator`.
- [x] C.15 `pnpm build && pnpm lint && pnpm test`.

## PR D: upsert

- [x] D.1 RED: `packages/client/test/upsert.mjs` — `where` not matching any declared unique group throws `IndigoArgumentError` code `NO_MATCHING_UNIQUE_CONSTRAINT` before `exec`.
- [x] D.2 RED: same file — `where` containing operator objects or `AND`/`OR` (non-plain-equality) is rejected with the same code (only plain scalar equalities allowed for conflict matching).
- [x] D.3 RED: same file — partial match against a composite unique group is rejected (exact key-set match required).
- [x] D.4 RED: same file — matching `where` emits `INSERT INTO t (...) VALUES (...) ON CONFLICT ("u") DO UPDATE SET ... RETURNING <selectList>`.
- [x] GREEN D.5 `packages/core/src/ir.ts`: confirm/forward unique/primaryKey/indexes info — read-only source for `uniqueGroups`.
- [x] GREEN D.6 `packages/client/src/types.ts`: add `ModelMeta.uniqueGroups: readonly (readonly string[])[]` (readonly required for `as const` `__meta` emission), `UpsertArgs`.
- [x] GREEN D.7 `packages/client/src/delegate.ts`: `upsert()` — match `where` plain-equality keys against `uniqueGroups` exactly, build `ON CONFLICT` target, no `runAtomic`.
- [x] D.8 `packages/generator/src/client.ts`: emit `uniqueGroups` (PK first, then `@unique`, then unique indexes) in `__meta`, `<Model>UpsertArgs`.
- [x] D.9 Type: `packages/client/test/fixtures/typecheck-fixture.ts` — add `uniqueGroups`-gated upsert `where` coverage, `// @ts-expect-error` on a non-unique `where` shape.
- [x] D.10 Verify `packages/client/test/typecheck.mjs` still passes against the additive `__meta` (existing fixture compiles unchanged, mutable-array regression check for `as const`).
- [x] D.11 Integration: `packages/client/test/upsert.mjs` pglite suite — insert-then-update lifecycle, single-column and composite unique group targets.
- [x] D.12 `pnpm build --filter=@indigodb/client`.
- [x] D.13 `pnpm build --filter=@indigodb/generator`.
- [x] D.14 `pnpm build && pnpm lint && pnpm test`.
