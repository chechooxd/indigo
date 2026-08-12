# Verify Report: nested-writes — PR B (Create Planner)

**Scope**: PR B only (7 tasks: create planner — 3-phase FK ordering, `connect`/`connectOrCreate`
for to-one/to-many on `create`, `UNKNOWN_FIELD` rejection, `IndigoNestedWriteError`). PR A is
already verified PASS and committed on `nested-writes/pr-a-metadata-atomicity-seam`
(`d3f48d6`). PR C (update planner) is NOT implemented — intentionally out of scope, confirmed
unchanged (`[ ]` in tasks.md).

## Completeness — Tasks

| Task | Status | Evidence |
|---|---|---|
| B1.1 RED op-split unit tests | [x] | `nested-writes-create.mjs` B1.1a-c present; scalar-only fast path, UNKNOWN_FIELD w/ zero SQL, relation-key routing |
| B1.2 RED 3-phase ordering unit tests | [x] | B1.2a-b present; fkSide insert before parent, non-fkSide insert after, verified via SQL-recording stub over real PGlite |
| B1.3 RED PGlite integration tests | [x] | B1.3a-j present; to-one/to-many × create/connect/connectOrCreate, CONNECT_NOT_FOUND + rollback (to-one and to-many), full-parent-rollback on child NOT-NULL violation, 1-1 inverse relation |
| B1.4 RED nested create inside active `$transaction` | [x] | B1.4/B1.4b present; single transaction open via real generated-constructor wiring, rollback-after-nested-write |
| B2.1 GREEN planner + runAtomic phases in `create()` | [x] | `delegate.ts` `create()` — `splitData`/`insertRow` fast path, 3-phase `runAtomic` body verified in source |
| B2.2 GREEN `IndigoNestedWriteError` + codes | [x] | `IndigoNestedWriteError extends IndigoRelationError`, `NestedWriteErrorCode` union incl. `UNKNOWN_FIELD`/`CONNECT_NOT_FOUND`/`COMPOSITE_RELATION`/`NO_ATOMIC_SEAM` (PR C's `REQUIRED_RELATION_DISCONNECT`/`AMBIGUOUS_UPDATE_TARGET` correctly reserved, unused) — exported from `index.ts` |
| B3.1 Verify all B1 RED tests GREEN + full suite/lint | [x] | see Runtime Evidence below |

7/7 PR B tasks complete and verified against actual source (not just tasks.md checkmarks).
PR A's 8/8 tasks remain complete and committed; PR C's 9 tasks remain unchecked, confirmed
not started (no `disconnect`/`set`/`AMBIGUOUS_UPDATE_TARGET`/`REQUIRED_RELATION_DISCONNECT`
logic anywhere in `update()`).

## Runtime Evidence

| Command | Result |
|---|---|
| `pnpm build --force` | PASS — 10/10 packages, incl. `@indigodb/client` |
| `pnpm lint --force` (tsc --noEmit per package) | PASS — 18/18 packages green, no type errors |
| `pnpm test --force` | PASS — 16/16 Turbo test tasks green, incl. `@indigodb/client`, `@indigodb/generator`, `@indigodb/migrator`, Rust/compiler harnesses |
| `node packages/client/test/nested-writes-create.mjs` (via `pnpm test`) | PASS — 17/17 checks (B1.1a-c, B1.2a-b, B1.3a-j, B1.4, B1.4b) |
| `pnpm --filter @indigodb/client test` | PASS — 7 suites (incl. `atomicity.mjs`, `transactions.mjs`, `transactions-pg.mjs`, `relations.mjs`, `nested-writes-create.mjs`), all green |

## Spec Compliance Matrix (PR B-relevant requirements only — domain: client-nested-writes)

| Requirement | Scenario | Status | Covering Test |
|---|---|---|---|
| 1. `create` sub-operation on relations | to-one create nested under parent create | PASS | B1.3a, B1.3j (1-1 inverse), B1.2a (ordering) |
| 1. `create` sub-operation on relations | to-many create nested under parent create | PASS | B1.3b, B1.2b (ordering), B1.3i (2-child rollback) |
| 2. `connect`/`connectOrCreate` sub-operations | connect links an existing row | PASS | B1.3c (to-one), B1.3g (to-many) |
| 2. `connect`/`connectOrCreate` sub-operations | connect to a non-existent row throws | PASS | B1.3d (to-one → `CONNECT_NOT_FOUND` + rollback), B1.3h (to-many → `CONNECT_NOT_FOUND` + full parent rollback) |
| 2. `connect`/`connectOrCreate` sub-operations | connectOrCreate falls back to create when not found | PASS | B1.3e (creates), B1.3f (connects existing, no duplicate) |
| 5. Unrecognized relation/data keys are rejected | unknown key throws instead of producing invalid SQL | PASS | B1.1b (`UNKNOWN_FIELD`, zero SQL calls issued) |
| 6. Atomic execution, ordered by FK direction | a failing nested write rolls back the parent | PASS | B1.3h, B1.3i (spec Req 7 explicit), B1.4b (mid-`$transaction` failure rolls back nested write too) |
| 7. (via scenario) failing child write rolls back parent | — | PASS | B1.3i — NOT-NULL violation on 2nd of 2 nested creates rolls back BOTH children and the parent |

Requirements 3 and 4 (`disconnect`/`set`, required-relation-disconnect typed error) are PR C
scope — correctly untested here; no implementation exists in `update()` to test against.

### client-transactions (DELTA — ADDED, PR B-relevant scenarios)

| Scenario | Status | Covering Test |
|---|---|---|
| top-level nested create opens exactly one transaction for the whole call | PASS | B1.4 — real generated-constructor wiring (`(fn) => client.$transaction(fn)`), asserts single commit, post-commit visibility |
| nested create issued via `tx` inside an active `$transaction` joins that session, no double-open | PASS | B1.4 |
| a later failure in `fn` still rolls back everything including the nested writes | PASS | B1.4b |

## Design Coherence

| Design Decision | Code Match | Notes |
|---|---|---|
| Planner splits `data` into scalars/relOps before any SQL (`splitData`) | ✅ | `delegate.ts:370-400` |
| No relation ops ⇒ skip planner, byte-identical `insertRow` fast path | ✅ | `delegate.ts:543-547`, proven by B1.1a's exact-SQL-string assertion |
| 3-phase FK-direction ordering inside one `runAtomic` session | ✅ | `delegate.ts:549-583` — phase 1 `fkSide` before insert, phase 2 parent insert, phase 3 non-`fkSide` after |
| Every child op re-enters the sibling delegate's own public `create`/`update`/`findFirst` — no new SQL construction path | ✅ | `resolveToOneOp`/`applyNonFkSideOp` call `target.create`/`target.update`/`target.findFirst` exclusively |
| `IndigoNestedWriteError extends IndigoRelationError` | ✅ | `delegate.ts:63-70` |
| `tx` lookups use `runAtomic`'s registry, never outer `this.siblings()` | ✅ | `requireSibling(tx, …)` used throughout phase 1/3 |

No deviations found beyond those already disclosed in apply-progress (both pre-existing/PR A
carryovers, not PR B-introduced).

## Strict TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | apply-progress #540 has a full "TDD Cycle Evidence" table for B1.1-B3.1 |
| All tasks have tests | ✅ | 7/7 |
| RED confirmed (tests exist) | ✅ | `nested-writes-create.mjs` exists, 17 checks map 1:1 to reported RED items |
| GREEN confirmed (tests pass) | ✅ | 17/17 pass on this run |
| Triangulation adequate | ✅ | 10 distinct integration scenarios for create/connect/connectOrCreate × cardinality, not single-case |
| Safety Net for modified files | ✅ | apply-progress reports full client suite green before/after; reproduced here |

**TDD Compliance**: 6/6 checks passed

### Assertion Quality Audit

Scanned `packages/client/test/nested-writes-create.mjs` (485 lines, 17 checks) for banned
patterns (tautologies, ghost loops, type-only-alone assertions, smoke-test-only,
implementation-detail coupling, mock-heavy ratio):

- No tautologies (`expect(true).toBe(true)`-style) found.
- No ghost loops — no assertions run inside a loop over a collection that could be empty
  without a prior length assertion; e.g. B1.3b/B1.3j assert `.length === 1` before indexing.
- No orphan empty-array assertions without a companion non-empty case (B1.3d/B1.3h/B1.3i assert
  empty *because* of rollback, each paired with a same-shaped non-empty-success test elsewhere
  in the file, e.g. B1.3a/B1.3b).
- All assertions call production code (`.create`/`.findMany` on real `ModelDelegate` instances
  against a real PGlite backend or a real recording stub) — none assert on mocks alone.
- No CSS/implementation-detail coupling (not applicable — backend test).
- Mock/assertion ratio: stub executors used only in B1.1a/b (SQL-string and call-count
  assertions on the stub itself, which IS the behavior under test for those two cases) — not a
  mock-heavy ratio issue.

**Assertion quality**: ✅ All assertions verify real behavior

### Quality Metrics

**Linter**: ✅ No errors (`pnpm lint --force`, 18/18 packages)
**Type Checker**: ✅ No errors (`tsc --noEmit` per package, included in lint)

## Review Workload Note

Authored diff for PR B (`delegate.ts` + `index.ts` + `package.json` + new
`nested-writes-create.mjs`): ~267 changed lines in existing files + 485 new lines in the new
test file ≈ 750 total. This exceeds the 400-line budget and the tasks.md forecast's own
"High" 400-line-budget-risk call for PR B (~450-600 estimate) — the actual is somewhat above
that estimate, driven mainly by the 17-check integration test file. This is a known, already-
decided tradeoff: the change is delivered as chained/stacked PRs (`stacked-to-main`,
`auto-chain`) per the cached delivery strategy, and PR B is exactly the chain slice this budget
call anticipated. No new decision is needed here — flagged as an informational WARNING, not a
blocker.

## Issues

**CRITICAL**: None.

**WARNING**:
1. Review workload — PR B's authored diff (~750 lines) runs above the 400-line budget and
   somewhat above tasks.md's own ~450-600 forecast; already covered by the accepted
   chained-PR delivery strategy (see Review Workload Note above). Not a defect, but reviewers
   should expect a larger-than-default single review pass.

**SUGGESTION**: None.

## Final Verdict

**PASS**

PR B (create planner) is complete, all 7 tasks are done and match the code state, all
in-scope spec requirements (1, 2, 5, 6, and the Requirement-7 rollback scenario) have a
passing covering test, build/lint/test are all green (10/10, 18/18, 16/16), design decisions
are followed without deviation, and Strict TDD evidence (RED→GREEN, no fabricated coverage)
checks out against the actual test file. PR C (update planner) is correctly untouched and out
of this verify's scope. Ready for commit/PR creation on top of `nested-writes/pr-a-metadata-atomicity-seam`, then `sdd-apply` for PR C.
