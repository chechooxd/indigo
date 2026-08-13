# Proposal: Batch, Aggregate and Cursor Pagination for @indigodb/client

## Intent

`@indigodb/client` today can only act on one row at a time (`create`/`update`/`delete`) and can only page by offset. Any bulk import, bulk cleanup, dashboard metric, or stable "next page" today forces users out of the typed client into raw SQL, which loses parameterization discipline, typed errors, and relation awareness. This change closes Phase 2 epic 2/5: batch mutations, `upsert`, aggregation, and cursor pagination, so the client covers the everyday Prisma-parity surface without escape hatches.

## Scope

### In Scope
- `createMany` / `updateMany` / `deleteMany` (scalars only, batch counts returned).
- Cursor pagination on `findMany` (`cursor` + `take`), single-column primary key only.
- `aggregate` / `groupBy` / `distinct`, with `_sum`/`_avg` restricted to numeric columns.
- `upsert` with `ON CONFLICT` targeting a declared unique constraint.
- Additive `__meta` extensions: numeric-scalar tag (PR C), unique-constraint groups (PR D).
- Generated arg interfaces in `packages/generator/src/client.ts`; new pglite test suites.

### Out of Scope
- Nested relation writes inside `createMany` (matches Prisma semantics).
- Cursor pagination on composite primary keys — rejected with a typed error, deferred.
- `createMany`'s `skipDuplicates` (depends on PR D's unique meta; revisit after).
- Any `packages/core` IR change — the data already exists and is only forwarded.

## Capabilities

### New Capabilities
- `client-batch-mutations`: `createMany`/`updateMany`/`deleteMany` semantics, return shape, typed errors.
- `client-cursor-pagination`: `cursor`+`take` contract, ordering guarantee, composite-PK rejection.
- `client-aggregation`: `aggregate`/`groupBy`/`distinct`, numeric-only `_sum`/`_avg` enforcement.
- `client-upsert`: `ON CONFLICT` target must match a declared unique group; typed error otherwise.

### Modified Capabilities
- `client-query-type-safety`: generated arg interfaces and additive `__meta` fields must stay backward-compatible with existing generated clients.
- `client-runtime-tests`: per-feature pglite suites for each new operation.

## Approach

Four chained PRs, ordered by escalating meta-model risk (mirrors `where-composition` A/B/C and `nested-writes` A/B):

| PR | Content | Meta change |
|----|---------|-------------|
| A | `createMany`/`updateMany`/`deleteMany` | none |
| B | cursor pagination | none (reuses `pk`) |
| C | `aggregate`/`groupBy`/`distinct` | numeric-scalar tag |
| D | `upsert` | unique-constraint groups |

All SQL reuses the existing `whereExpr`/`buildWhere`/`Params`/`quote`/`buildOrderBy` builders — no second WHERE compiler. `createMany` extends the private scalar-only `insertRow` shape (multi-row `VALUES`), not `create()`'s nested-write planner. `aggregate` generalizes `count()`'s SQL shape. Every rejection is a typed error raised before SQL is issued, consistent with `UNKNOWN_WHERE_KEY`/`UNKNOWN_FIELD`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/delegate.ts` | Modified | New methods; cursor clause in `findMany` |
| `packages/client/src/types.ts` | Modified | New arg interfaces; `FieldMeta`/`ModelMeta` extensions |
| `packages/generator/src/client.ts` | Modified | Emit new interfaces; forward numeric + unique meta |
| `packages/client/test/*.mjs` | New | `batch`/`cursor`/`aggregate`/`upsert` suites |
| `packages/core/src/ir.ts` | Unchanged | Read-only source for type/unique info |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `__meta` shape change breaks existing generated clients | Medium | Additive-only fields; verify against `packages/client/test/typecheck.mjs` fixture compile in both PR C and PR D |
| `ON CONFLICT` target does not match a real constraint → runtime Postgres error | Medium | Validate `where` against exposed unique groups before issuing SQL; typed error |
| Composite-PK users cannot paginate by cursor | Medium | Explicit typed error naming the limitation; documented as deferred |
| `updateMany`/`deleteMany` with empty `where` affects the whole table | Medium | Decide in design: allow with explicit intent, matching Prisma |
| Four-PR chain drifts / later PRs rebase-conflict | Low | Feature-branch chain; each PR independently reviewable under the 800-line budget |

## Rollback Plan

Each PR is additive and independently revertable: `git revert` the slice's merge commit. No migration, no persisted state, no change to existing method behavior, so reverting PR D leaves A–C fully functional. Reverting a meta-adding PR (C or D) also requires regenerating client fixtures, which the test suite covers.

## Dependencies

- `client-where-composition` (archived) — supplies `whereExpr`/`Params`/`quote`.
- `nested-writes` (archived) — supplies `insertRow`/`rawUpdate` scalar-only seams.

## Success Criteria

- [ ] `createMany`/`updateMany`/`deleteMany`/`upsert`/`aggregate`/`groupBy`/`distinct` and cursor pagination are callable from the generated typed client.
- [ ] Every new operation has a pglite runtime suite covering happy path and its typed-error path.
- [ ] `pnpm lint` and `packages/client/test/typecheck.mjs` pass with the extended `__meta`.
- [ ] `_sum`/`_avg` on a non-numeric field and `upsert` on a non-unique `where` both fail with typed errors before SQL is issued.
- [ ] Each of the four PRs stays within the 800-line review budget.
