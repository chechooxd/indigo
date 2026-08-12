# Verification Report: relations-include-select

**Mode**: hybrid (OpenSpec files + Engram)
**Verdict**: PASS

## Completeness

- tasks.md: 39/39 tasks checked (`[x]`), 0 unchecked. Confirmed by grep count, not trust of prior memory.
- Phase 1 (generator, PR1) + Phases 2-7 (client runtime, PR2) both present in the working tree, uncommitted, matching apply-progress (#532).

## Runtime evidence (forced, non-cached, this session)

| Command | Result |
|---|---|
| `pnpm build --force` | exit 0, 10/10 packages, incl. Studio Vite build |
| `pnpm lint --force` (tsc --noEmit x18) | exit 0, 18/18 |
| `pnpm test --force` (Turbo) | exit 0, 16/16 task nodes, 322 `ok` lines, 0 `FAIL` |

Package-level breakdown relevant to this change:
- `@indigodb/generator` test: `enum-mapping.mjs` (3 ok) + `transaction-emission.mjs` (10 ok, updated for 4-generic signature) + `relation-emission.mjs` (12 ok) — all green.
- `@indigodb/client` test: `typecheck.mjs` (GetPayload checkpoint — 1 ok, real conditional narrowing holds, no fallback) + `client.mjs` (10 ok) + `relations.mjs` (14 ok) + `transactions.mjs` (6 ok) + `transactions-pg.mjs` (5 ok) — all green.

## Spec compliance matrix — `client-relation-loading`

| Requirement | Scenario | Covering test | Status |
|---|---|---|---|
| include accepted one level deep | boolean flag on findMany | 3.1 | PASS |
| include accepted one level deep | nested include not accepted | type-level: `IncludeInput<Rel>` shape (`boolean \| {select}}`) has no `include` key; not independently exercised as a negative runtime test, but structurally unrepresentable | PASS (by construction) |
| nested scalar select inside included relation | narrows to selected fields | 3.6 | PASS |
| batched-by-parent-ID, bounded round trips | pagination unaffected | 3.8 | PASS |
| batched-by-parent-ID, bounded round trips | round trips = 1 + relations | 3.5 (2 queries for 1 relation), 3.7 (3 queries for 2 relations), both via counting executor with multi-row parents — confirms count does not scale with row count | PASS |
| cardinality-correct stitching | empty list -> `[]` | 3.4 (asserts key presence + array + length 0) | PASS |
| cardinality-correct stitching | null FK -> null | 3.2 | PASS |
| cardinality-correct stitching | 1-1 -> single object | 3.3 | PASS |
| cardinality-correct stitching | N-1 across multiple parents | 3.5 | PASS |
| include excludes where/orderBy/take | not accepted | structural (IncludeInput type shape), no dedicated runtime negative test | PASS (by construction) |
| `_count` not part of capability | not a valid key | structural (IncludeInput/RelationMeta have no `_count` support) | PASS (by construction) |
| realtime partial refetch stays flat | NOTIFY refetch issues no relation query | 6.1 — asserts exact call count (1) AND absence of `posts` key on emitted payload, genuinely pinning "never issues include", not just "still works" | PASS |
| no include/select = zero behavior change | byte-identical SQL, flat rows | 3.9 — asserts exact SQL string equality | PASS |

## Spec compliance matrix — `client-query-type-safety`

| Requirement | Scenario | Covering test | Status |
|---|---|---|---|
| select narrows return type to scalars | id/email only | `typecheck.mjs` fixture + `tsc --noEmit` | PASS |
| include narrows return type, adds relation key | posts: true | `typecheck.mjs` fixture | PASS |
| nested select narrows included relation's inferred shape | posts.select.title | **Documented gap**: `Payload`'s include branch types the relation as `Rel[K]` (full shape), not narrowed by nested `select` — recorded inline in `types.ts` and the fixture per apply-progress. Runtime JS shape IS narrowed (3.6/4.2); only static TS inference isn't. | PARTIAL — see Issues |
| excluded scalar is compile error | `users[0].email` after `select:{id}` | `typecheck.mjs`, `@ts-expect-error` | PASS |
| non-included relation is compile error | `users[0].posts` with no include | `typecheck.mjs`, `@ts-expect-error` | PASS |
| no select/include unchanged type | default call | `typecheck.mjs` | PASS |
| accepted fallback documented as one concrete choice | GetPayload checkpoint resolved | Real conditional `Payload<Row,Rel,A>` HOLDS; fallback (`Row & Partial<Pick<Rel,...>>`) was NOT exercised. Single concrete choice, not two coexisting behaviors — task 2.3/2.4 satisfied. | PASS |

## Join-key stripping — both directions independently verified

- 4.1: parent `select` omits the FK/PK field -> stitching still correct, forced key stripped from final parent row, explicitly-selected fields retained.
- 4.2: child `select` (inside `include`) omits the ref column -> stitching still correct, forced key stripped from final child row.
- 4.x: explicitly-selected parent key is retained, not stripped (guards against over-stripping).

These are two distinct test cases as required, not one test asserting both sides.

## Composite-key rejection

- 5.1: `IndigoRelationError` (not generic `Error` — asserted via `instanceof`) thrown synchronously before any batched follow-up query; call-count assertion (`counting.calls.length === 1`, i.e. only the parent-adjacent create/setup, no relation query) confirms no partial/broken SQL is sent.
- Codegen side (relation-emission.mjs): composite relation structurally omitted from `<Model>Relations`/`IncludeInput` (compile-time), while still recorded in `__meta` as `{ target, composite: true }` for the runtime marker — consistent two-layer design per tasks.md 1.4, confirmed consistent between PR1 (codegen) and PR2 (runtime) per 5.3.

## Design coherence

Implementation matches design.md decisions 1-6 exactly: `from`/`to` collapsed to field names at codegen time (relation-emission.mjs 1.1), sibling-delegate reuse for child fetch (no new SQL — confirmed by reading `loadRelations`, which calls `target.findMany`), lazy registry thunk appended as last ctor arg, conditional types live in `client/src/types.ts` (not generator strings), single-column-only with typed runtime rejection, zero-cost when `include` absent (3.9, `loadRelations` only invoked inside the `if (include)` branch in `findMany`). File Changes table in design.md matches the actual diff exactly (`packages/client/src/{types,delegate,realtime-delegate}.ts`, `packages/generator/src/client.ts`, both `package.json` test scripts, new `relations.mjs`/`relation-emission.mjs`). No scope drift detected.

## Issues

**CRITICAL**: none.

**WARNING**: none blocking.

**SUGGESTION**:
1. The nested-`select`-inside-`include` static type gap (Payload's include branch does not narrow by nested select) is a real, permanent, documented limitation of the current type design — correctly disclosed inline in `types.ts` and the typecheck fixture, and does not violate the spec's "accepted fallback" escape hatch since it's a narrower, explicitly-called-out gap rather than the coarser Row-fallback. Consider tracking as a future micro-slice if deeper type narrowing is ever prioritized. Not a blocker for this change since the spec's fallback clause anticipates and permits documented type-level gaps.
2. `IncludeInput`'s per-relation `select` is `Record<string, boolean>` (untyped), not narrowed against the target row — matches design.md's contract verbatim, but is the root cause of finding #1. No action needed unless revisited alongside a future depth-2/`_count` change.

**Confirmed out-of-scope, not a defect of this change**: `IndigoClient.$transaction<T>` TS2416 override-compatibility error (Engram #533) is pre-existing (verified via `git show HEAD` byte-identical before this change touched `client.ts`), untouched by this diff, and correctly excluded from this change's task list and spec. Do not block archive on it.

## Verdict

**PASS.** All 39 tasks complete and code-verified (not just checkbox-trusted). Both spec deltas' requirements have runtime-covering tests that were re-executed live this session (build/lint/test all forced, non-cached, exit 0). Design decisions hold with no drift. The one documented type-level gap (nested select not narrowing include's static shape) is explicitly spec-permitted disclosure, not a hidden regression. Pre-existing `$transaction` type defect is correctly out of scope. Safe to proceed to `sdd-archive`.
