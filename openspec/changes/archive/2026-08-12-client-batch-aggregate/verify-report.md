# Verification Report: client-batch-aggregate

**Change**: client-batch-aggregate (whole-change terminal verification, PR A+B+C+D)
**Mode**: Full artifacts (proposal, 6 spec deltas, design, tasks) — all present.
**Date**: 2026-08-12

## Completeness

Live-grepped `tasks.md`: 51 `- [x]` lines, 0 `- [ ]` lines, 51 total `- [` lines.
All 51/51 tasks across PR A (11), PR B (11), PR C (15), PR D (14) are checked.
No unchecked task found.

## Command Evidence

| Command | Result | Notes |
|---|---|---|
| `pnpm build --force` | PASS (10/10 tasks) | Bypassed cache; all packages including `@indigodb/client`/`@indigodb/generator` rebuilt clean |
| `pnpm lint --force` | PASS (18/18 tasks) | `tsc --noEmit` per package, cache bypassed |
| `pnpm test --force` | PASS (16/16 tasks, ~2m51s) | Cache bypassed; includes new `batch.mjs`, `cursor.mjs`, `aggregate.mjs`, `upsert.mjs` suites plus all pre-existing suites (relations, where-*, transactions, nested-writes, extensions) |
| `node packages/client/test/typecheck.mjs` | PASS | `tsc --noEmit` over `typecheck-fixture.ts` with additive `numeric`/`uniqueGroups` `__meta` fields and `CreateManyInput`/`Cursor`/`UniqueWhere` generics |

## Spec Compliance Matrix

### client-batch-mutations (4 requirements, 6 scenarios)
| Scenario | Test | Status |
|---|---|---|
| All rows insert together | `batch.mjs` A.3, A.8a | PASS |
| Constraint violation rolls back whole batch | `batch.mjs` A.8b | PASS |
| Nested relation writes rejected (compile-time) | `typecheck-fixture.ts` (A.7, generator scalar-only `CreateManyInput`) | PASS |
| Missing where rejected (EMPTY_WHERE) | `batch.mjs` A.2a/c | PASS |
| Empty where object rejected | `batch.mjs` A.2b/d | PASS |
| Non-empty where accepted, returns count | `batch.mjs` A.4a, A.8c | PASS |
| deleteMany reports zero, no throw | `batch.mjs` A.8d | PASS |

### client-cursor-pagination (3 requirements, 6 scenarios)
| Scenario | Test | Status |
|---|---|---|
| Cursor pages forward | `cursor.mjs` B.8a | PASS |
| Cursor + explicit orderBy, pk tiebreaker | `cursor.mjs` B.3c, B.4 | PASS |
| Cursor at nonexistent row → empty page | `cursor.mjs` B.8b | PASS |
| Composite-PK rejects cursor | `cursor.mjs` B.1 | PASS |
| Composite-PK still supports offset | `cursor.mjs` B.1b | PASS |
| No cursor → no behavior change | `cursor.mjs` B.4b | PASS |

### client-aggregation (4 requirements, 7 scenarios)
| Scenario | Test | Status |
|---|---|---|
| Multiple aggregates in one call | `aggregate.mjs` C.3, C.12a | PASS |
| Runtime rejection of non-numeric _sum | `aggregate.mjs` C.1a | PASS |
| Compile-time rejection of non-numeric _avg | `typecheck-fixture.ts` (@ts-expect-error, C.10) | PASS |
| groupBy count per group | `aggregate.mjs` C.4, C.12b | PASS |
| having not part of accepted shape | `typecheck-fixture.ts` (no `having` key emitted; C.4b runtime confirms no HAVING clause) | PASS |
| distinct narrows findMany, no standalone method | `aggregate.mjs` C.5a, C.12c | PASS |

### client-upsert (3 requirements, 6 scenarios)
| Scenario | Test | Status |
|---|---|---|
| Existing row updated | `upsert.mjs` D.4a, D.11a | PASS |
| Nonexistent row created | `upsert.mjs` D.11a (insert-then-update lifecycle) | PASS |
| where on non-unique field rejected | `upsert.mjs` D.1 | PASS |
| Compile-time restriction to declared unique groups | `typecheck-fixture.ts` (D.9, object-literal assignment against generated `UpsertArgs`) | PASS |
| Composite unique target succeeds | `upsert.mjs` D.4b, D.11b | PASS |
| Partial composite match rejected | `upsert.mjs` D.3 | PASS |

### client-query-type-safety (delta — 2 requirements, 5 scenarios)
| Scenario | Test | Status |
|---|---|---|
| New arg interfaces emitted per model | `packages/generator/test/*` golden emission tests + `typecheck-fixture.ts` | PASS |
| Existing generated clients keep compiling unchanged | `pnpm build --filter=@indigodb/generator` + full `pnpm test` (generator goldens green) | PASS |
| Numeric field tagged | `typecheck-fixture.ts` C.10 narrowing | PASS |
| Unique groups listed, including composites | `typecheck-fixture.ts` D.9 (`UserUpsertWhereInput`/composite `MembershipUpsertWhereInput`-equivalent shapes) | PASS |
| __meta additions don't break fixture compile | `typecheck.mjs` (C.11, D.10 explicit regression checks) | PASS |

### client-runtime-tests (delta — 1 requirement, 4 scenarios)
| Scenario | Test | Status |
|---|---|---|
| Batch suite: happy path + EMPTY_WHERE | `batch.mjs` | PASS |
| Cursor suite: pagination + composite-PK rejection | `cursor.mjs` | PASS |
| Aggregate suite: numeric enforcement | `aggregate.mjs` | PASS |
| Upsert suite: create/update + non-unique rejection | `upsert.mjs` | PASS |

**Total**: 6 capability specs (4 new + 2 delta), 17 requirements, 34 scenarios — all with a passing covering test at runtime (verified via fresh `pnpm test --force`).

## Design Coherence

- **Generic-slot chain** (design.md Decision #7 said Cursor would be "the 6th generic";
  PR A's `CreateManyInput` claimed slot 6 first, so Cursor became 7th, Numeric 8th (PR C),
  UniqueWhere 9th (PR D)). Verified this drift is documented **consistently** across every
  site: `types.ts:98-100` (Cursor doc comment), `types.ts:236-238` (Numeric doc comment),
  `types.ts:299-300` (UniqueWhere doc comment), `delegate.ts:322-353` (all three doc
  comments), `realtime-delegate.ts:32-38` (forwarding doc comments), and
  `generator/client.ts:525,551,565,576,592` (generator-side doc comments). All state the
  same fact chain ("Cursor specced as 6th, PR A claimed that slot, so 7th... Numeric 8th...
  UniqueWhere 9th, appended not renumbered") with no contradiction found anywhere.
- **Empty-where error naming reconciliation** (design.md's explicit note: PR A's
  `EMPTY_WHERE` guard is on `IndigoWhereError`/`WhereErrorCode`, not a new
  `IndigoArgumentError` code, despite Decision #4's table and the interfaces section
  originally naming it `EMPTY_WHERE_NOT_ALLOWED` on `ArgumentErrorCode`). Verified
  `delegate.ts:70-74` defines `EMPTY_WHERE` on `WhereErrorCode`, thrown as
  `IndigoWhereError` at `delegate.ts:577-578`, and every test (`batch.mjs` A.2a-d) and
  spec scenario (client-batch-mutations spec.md) uses `IndigoWhereError`/`EMPTY_WHERE`
  consistently — no stray `EMPTY_WHERE_NOT_ALLOWED` or wrong error class found anywhere
  in `packages/client/src` or `packages/client/test`.
- Design's SQL shapes (multi-row INSERT, DISTINCT ON prepend, positional agg aliases,
  ON CONFLICT target resolution) match implementation and test assertions exactly.
- No `packages/core` IR change occurred, matching design's "read-only source" decisions
  for both numeric tagging (PR C) and unique groups (PR D).

## Issues

**CRITICAL**: none.

**WARNING**: none.

**SUGGESTION**: none blocking; two design.md Open Questions remain genuinely open
(documented, not defects): `_sum`/`_avg` `::float8` precision above 2^53 for
BigInt/Decimal columns, and whether `groupBy` should accept `orderBy` on an aggregate
alias in a future slice. Both are explicitly out-of-scope per proposal.md and do not
block this change.

## Out-of-Scope Finding (not a blocker)

A pre-existing bug was independently rediscovered during PR A.7 (documented in the
design.md file-changes rationale for `A.7`): `packages/generator/src/client.ts`'s
generated `IndigoClient.$transaction<T>` override is not structurally compatible with
`IndigoClientBase.$transaction<T>`'s base signature (TS2416-class issue). This was
first logged as its own bugfix observation (Engram #533, dated 2026-08-11, filed against
the earlier `nested-writes` change) and predates `client-batch-aggregate` entirely. It
does not manifest as a build/lint failure in the current `tsc --noEmit` run (confirmed:
`pnpm build --force` and `pnpm lint --force` are both green), and none of this change's
new methods (`createMany`/`updateMany`/`deleteMany`/cursor/`aggregate`/`groupBy`/
`upsert`) touch `$transaction`'s override signature. Tracked as an unrelated,
pre-existing, non-blocking finding — not part of this change's scope or acceptance
criteria.

## Final Verdict

**PASS**

- CRITICAL: 0
- WARNING: 0
- SUGGESTION: 0 (2 non-blocking open design questions carried forward, explicitly documented)

All 51/51 tasks complete, all 4 new capability specs plus both delta specs (34 total
scenarios) have passing covering tests re-run fresh (`--force`, no cache), full monorepo
build/lint/test green, generic-slot chain and empty-where error-naming are internally
consistent across all touched files, and the typecheck fixture compiles cleanly with all
additive `__meta`/generic changes. Ready for `sdd-archive`.
