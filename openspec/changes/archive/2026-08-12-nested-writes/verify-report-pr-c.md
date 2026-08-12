# Verify Report: nested-writes (PR C + whole-change terminal verification)

**Change**: nested-writes
**Scope**: PR C (update-side nested-write planner: disconnect/set, AMBIGUOUS_UPDATE_TARGET, REQUIRED_RELATION_DISCONNECT) — FINAL slice. Whole-change sanity pass across PR A + B + C (21/21 tasks).
**Date**: 2026-08-12
**Branch**: `nested-writes/pr-b-create-planner` (PR C changes present but not yet committed: `delegate.ts`, `package.json`, `tasks.md`, `design.md` modified; `nested-writes-update.mjs` untracked)

## Task Completeness

All 21/21 tasks in `openspec/changes/nested-writes/tasks.md` are `[x]`:
- PR A (8/8): metadata (`fkSide`/`optional`/`optionalFk`/`name`) + `runAtomic` seam.
- PR B (7/7): create planner (3-phase ordering, connect/connectOrCreate, `UNKNOWN_FIELD`).
- PR C (6/6): update planner (`disconnect`/`set`, `AMBIGUOUS_UPDATE_TARGET`, `REQUIRED_RELATION_DISCONNECT`).

No unchecked tasks. Live tree matches: `git status` and diff review confirm `delegate.ts`'s `update()` is a 3-phase planner (`rawUpdate` extracted, phase 1 fkSide FK resolution + disconnect/set gating, `AMBIGUOUS_UPDATE_TARGET` pre-check via `findMany`, phase 2 conditional `rawUpdate`/reuse of `matches[0]`, phase 3 `applyNonFkSideOp` with to-many/to-one disconnect/set).

## Build / Lint / Test Evidence (whole monorepo)

| Command | Result |
|---|---|
| `pnpm build` | Exit 0 — 10/10 Turbo tasks successful |
| `pnpm lint` | Exit 0 — 18/18 Turbo tasks successful (`tsc --noEmit` per package) |
| `pnpm test` | Exit 0 — 16/16 Turbo tasks successful, no `FAIL` lines |

`@indigodb/client:test` (8 suites, all green), including:
- `nested-writes-create.mjs` — 17/17 checks (PR B, create planner: op split, 3-phase ordering, create/connect/connectOrCreate, `CONNECT_NOT_FOUND`, rollback, `$transaction` nesting).
- `nested-writes-update.mjs` — 12/12 checks (PR C, update planner: disconnect/set to-many + to-one, required/optional gating, `set: []`, `set: [where]` replace, relation-ops-only resolution, `AMBIGUOUS_UPDATE_TARGET` (>1 match), 0-match no-op, scalar-only SQL parity, rollback of scalar changes on relation-op failure).

`@indigodb/generator:test` — `nested-write-emission.mjs` (9/9 checks: `fkSide`/`optional`/`optionalFk`/`name` correctly emitted per relation direction and FK nullability).

## Spec Compliance Matrix (client-nested-writes, 6 requirements)

| # | Requirement | Covering test(s) | Status |
|---|---|---|---|
| 1 | `create` sub-op on relations, ordered by FK direction | B1.2a/b, B1.3a/b/j | PASS |
| 2 | `connect`/`connectOrCreate`, `connect` miss throws typed error | B1.3c–h | PASS |
| 3 | `disconnect`/`set` on to-many, `set: []` disconnects all, deletes nothing | C1.1a, C1.3a/b | PASS |
| 4 | Required to-one disconnect/set is a typed error; optional to-one clears FK | C1.1b, C1.2a/b/c | PASS |
| 5 | Unrecognized relation/data keys rejected as `UNKNOWN_FIELD`, never reach SQL | B1.1b | PASS |
| 6 | Atomic execution, ordered by FK direction, full rollback on failure | B1.3i, B1.4b, PR C rollback check (`Publisher.name` unchanged after `REQUIRED_RELATION_DISCONNECT`) | PASS |

`AMBIGUOUS_UPDATE_TARGET` (design.md addendum to Req 3/4, not a separate numbered requirement but explicitly named in the spec's decision log): covered by C1.4a/b/c (>1 match throws, 0 match is a silent no-op, exactly 1 match applies). PASS.

### client-query-type-safety (delta)
`CreateInput`/`UpdateInput` relation members and `__meta.relations[<name>].optional` — confirmed via `nested-write-emission.mjs` (9/9) and `typecheck.mjs`'s `tsc --noEmit` fixture check. PASS.

### client-transactions (delta)
`runAtomic` seam (identity inside active `$transaction`, real thunk at top level, no double-open, full rollback including nested writes) — confirmed via `atomicity.mjs` (4/4) and `transactions.mjs`/`nested-writes-create.mjs` B1.4/B1.4b. PASS.

## Design Coherence

- `design.md`'s Open Question ("`set` via unbounded `update()` — acceptable?") is marked `[x]` resolved in the filesystem twin, confirming the product decision that shipped in code.
- Planner shape (`splitData` → `runAtomic` → 3 phases) matches design.md's Data Flow pseudocode for both `create()` and `update()`, including the update-only `AMBIGUOUS_UPDATE_TARGET` pre-check and the "reads target via `findMany` instead of emitting an empty SET" behavior for relation-ops-only `data`.
- One documented deviation (already captured in apply-progress): relation-ops-only `data` with an empty `finalScalars` skips `rawUpdate` entirely and reuses `matches[0]` — not spelled out line-by-line in the original pseudocode but required to avoid malformed `UPDATE ... SET ` SQL, and is the literal implementation of the stated data-flow intent. No spec conflict.

## Issues

**CRITICAL**: None.

**WARNING**: None. PR C's code changes remain uncommitted on the current branch (`git status` shows `delegate.ts`/`package.json`/`tasks.md`/`design.md` modified, `nested-writes-update.mjs` untracked) — this is a delivery/commit-hygiene note for the orchestrator, not a code defect; all evidence above was gathered against the live working tree.

**SUGGESTION**: None beyond what's already tracked (design.md's `set`-via-`updateMany` alternative was considered and explicitly rejected, not deferred).

## Verdict

**PASS**

All 21 tasks complete and verified against the live tree (not memory claims alone). Full monorepo build/lint/test suite is green (exit 0 across all three). Every client-nested-writes requirement (1–6, including the `AMBIGUOUS_UPDATE_TARGET` addendum) and both spec deltas (client-query-type-safety, client-transactions) have a passing, code-inspected, runtime-executed covering test. Design decisions match implementation; the one documented deviation is intentional and non-conflicting.

**Ready for `sdd-archive`**: Yes — pending the orchestrator committing PR C's working-tree changes (tracked as a delivery note, not a blocker to this verification's PASS verdict).
