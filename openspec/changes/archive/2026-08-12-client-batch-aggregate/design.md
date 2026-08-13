# Design: Batch, Aggregate and Cursor Pagination for @indigodb/client

## Technical Approach

Four additive PRs on `packages/client/src/delegate.ts`. Every new method is a thin
SQL shape over the existing `Params`/`quote`/`buildWhere`(`whereExpr`)/`buildOrderBy`
/`selectList` builders, wrapped in `withQueryContext` so extensions observe it. No
second WHERE compiler, no `packages/core` change. All argument validation throws a
typed error **before** `exec` is called.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Batch counts | `... RETURNING 1`, `count = rows.length` | Widen `Executor` to `{rows,rowCount}` | `Executor` (`types.ts:279`) returns rows only. Widening breaks every injected `db.exec` (PGlite harness, user pools) and all `QueryExtension`s — a breaking change for a count. |
| 2 | Typed errors | One new `IndigoArgumentError extends Error` with a `code` union, extended additively per PR | Class per PR | Mirrors `IndigoWhereError`'s code-union pattern; one `catch` for all new arg rejections. |
| 3 | `createMany` atomicity | Single multi-row `INSERT`, **no** `runAtomic` | Wrap in `runAtomic` | One statement is already atomic; `runAtomic` would open a needless transaction and break usage inside an active `$transaction`'s identity path. Same for `upsert`. |
| 4 | Empty `where` on `updateMany`/`deleteMany` | Reject `undefined`/`{}` with `IndigoWhereError` code `EMPTY_WHERE` (naming reconciled during apply — see note below) | Prisma's permissive whole-table mutation | `buildWhere` returns `""` for `{}`, so the accident silently becomes `DELETE FROM t`. |
| 5 | Cursor inclusivity | Inclusive `>=`/`<=`; `skip: 1` excludes the cursor row via the existing `OFFSET` | Exclusive `>` | Exactly Prisma's semantics and reuses `skip` untouched. |
| 6 | Cursor ordering | Append `pk <dir>` as the final `ORDER BY` term when absent; `dir` from the pk's own `orderBy` entry, else `asc` | Force pk-only ordering | Keeps user `orderBy` intact while guaranteeing a total order (a cursor over a non-deterministic order silently skips rows). |
| 7 | Composite-PK cursor | 6th defaulted generic `Cursor = never` on `ModelDelegate`/`FindManyArgs`; generator passes `<Model>CursorInput` only for single-PK models — **plus** a runtime pk-count check | Runtime-only | Follows the `Where` 5th-generic precedent (`types.ts:98`); `cursor?: never` makes it unwritable in TS, runtime guards `as any`/stale clients. |
| 8 | `distinct` | `SELECT DISTINCT ON (<cols>) …` with the distinct cols **prepended** to `ORDER BY` (skipped if already the leading terms) | `SELECT DISTINCT` | Postgres requires the `DISTINCT ON` prefix to match `ORDER BY`'s leftmost terms; `SELECT DISTINCT` cannot return full rows keyed on a subset. |
| 9 | Aggregate aliases | Positional aliases `agg0…aggN` + a JS-side descriptor array rebuilding the nested result | `_sum_<field>` string aliases | Collision-free against real field names; no alias parsing. |
| 10 | Numeric tag | `FieldMeta.numeric?: true` (set for Int/Float/Decimal/BigInt, `!isEnum`) | Carrying the scalar kind | Only gate needed; matches the existing `json?: true` bit and stays `as const`-safe. |
| 11 | `_sum`/`_avg` typing | Cast `::float8`, return `number \| null` | Native pg text for Decimal/BigInt | Consistent return type; `Decimal`→`string` already. Precision >2^53 is an accepted limitation (Open Questions). `_min`/`_max` uncast, native type. |
| 12 | Unique meta | `ModelMeta.uniques?: readonly (readonly string[])[]` (field names: PK first, then `@unique`, then unique indexes) | `string[][]` | **`__meta` is emitted `as const`** — a mutable array type would fail `typecheck.mjs`. Readonly props are already assignable, so `numeric` needs no change. |
| 13 | `ON CONFLICT` target | Match `where`'s plain-equality keys against `uniques`: the group must equal the key set exactly; else `NO_MATCHING_UNIQUE_CONSTRAINT` | Trust the caller's `where` | Guarantees the emitted target names a real declared constraint instead of a raw Postgres 42P10. |

> **Naming reconciliation (PR A apply, mirrors the `RealtimeModelDelegate` doc-gap fix
> in the archived `client-where-composition` change):** this table's Decision #4 and
> the `ArgumentErrorCode` union below both named the empty-`where` guard
> `IndigoArgumentError` code `EMPTY_WHERE_NOT_ALLOWED`. The implementation instead
> extends the existing `WhereErrorCode` union with `"EMPTY_WHERE"` and throws
> `IndigoWhereError` — matching spec.md's canonical acceptance scenarios verbatim
> (`IndigoWhereError` / `code: "EMPTY_WHERE"`) and reusing the `where`-defect error
> class `whereExpr` already raises, rather than opening a second class for the same
> concern. `IndigoArgumentError` (with its own `ArgumentErrorCode` union) is real and
> shipped, but scoped to non-`where` argument-shape rejections — `EMPTY_BATCH` is its
> first and, for PR A, only member.

## Data Flow

    args ──→ validate (typed errors, no SQL) ──→ Params + whereExpr/buildOrderBy
                                                        │
                                          one statement ▼──→ exec ──→ shape result
                                                                       (count / rows /
                                                                        agg descriptors)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/types.ts` | Modify | `CreateManyArgs`/`UpdateManyArgs`/`DeleteManyArgs`/`BatchPayload`, `AggregateArgs`/`GroupByArgs`/`UpsertArgs`; `cursor`+`distinct` on `FindManyArgs`; 6th `Cursor` generic; `FieldMeta.numeric`, `ModelMeta.uniques` |
| `packages/client/src/delegate.ts` | Modify | `IndigoArgumentError`; `createMany`/`updateMany`/`deleteMany`/`aggregate`/`groupBy`/`upsert`; cursor + `DISTINCT ON` clauses in `findManyImpl` |
| `packages/generator/src/client.ts` | Modify | Emit new arg interfaces + `<Model>CursorInput`; `numeric: true` (PR C) and `uniques` (PR D) in `__meta`; 6th generic |
| `packages/client/test/{batch,cursor,aggregate,upsert}.mjs` | Create | PGlite suites per PR |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modify | Cover `numeric`/`uniques`/`Cursor` in PR C+D |

## Interfaces / Contracts

```ts
// EMPTY_WHERE (updateMany/deleteMany's required-where guard, PR A) is on
// WhereErrorCode / IndigoWhereError instead — see the naming reconciliation
// note above Data Flow.
export type ArgumentErrorCode =
  | "EMPTY_BATCH"                  // PR A: createMany([])
  | "CURSOR_COMPOSITE_PK" | "CURSOR_NO_PK"          // PR B
  | "NON_NUMERIC_AGGREGATE" | "UNKNOWN_AGGREGATE_FIELD" | "EMPTY_AGGREGATE"  // PR C
  | "NO_MATCHING_UNIQUE_CONSTRAINT";                // PR D

export interface BatchPayload { count: number }
export interface AggregateResult {
  _count?: number;
  _sum?: Record<string, number | null>;
  _avg?: Record<string, number | null>;
  _min?: Record<string, unknown>;
  _max?: Record<string, unknown>;
}
```

SQL shapes (all reusing `buildWhere`):
`INSERT INTO t (cols) VALUES (…),(…) RETURNING 1` ·
`UPDATE t SET … WHERE <expr> RETURNING 1` · `DELETE FROM t WHERE <expr> RETURNING 1` ·
`SELECT … WHERE <expr> AND "pk" >= $c ORDER BY …, "pk" ASC LIMIT $t OFFSET $s` ·
`SELECT DISTINCT ON ("a","b") … ORDER BY "a","b",<user>` ·
`SELECT count(*)::int AS agg0, sum("c")::float8 AS agg1 … WHERE <expr> [GROUP BY …]` ·
`INSERT INTO t (…) VALUES (…) ON CONFLICT ("u") DO UPDATE SET … RETURNING <selectList>`.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | SQL text + params for each new shape; every typed-error path fires before `exec` | Fake executor recording `(sql, params)`, per `client.mjs` |
| Integration | Real counts, cursor stability across pages, `DISTINCT ON` row identity, aggregate values, upsert insert-then-update | PGlite via `pglite-harness.mjs` (`createPgliteDb`) |
| Type | Additive `__meta`, `cursor?: never` on a composite-PK model, aggregate arg narrowing | `typecheck.mjs` + `// @ts-expect-error` lines in the fixture (run in **both** PR C and PR D) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. All SQL stays parameterized through `Params`; identifiers pass through `quote` and originate from `__meta`, never caller strings.

## Migration / Rollout

No migration. Four chained PRs (A→B→C→D), each independently revertable; a revert of C or D also requires regenerating client fixtures, which the suites cover.

## Open Questions

- [ ] `_sum`/`_avg` `::float8` loses precision above 2^53 for `BigInt`/`Decimal` columns — accept as a documented limitation, or defer a `Decimal`-preserving path to a follow-up?
- [ ] Should `groupBy` accept `orderBy` on an aggregate alias in this change, or restrict ordering to group fields only (no `HAVING` is already settled)?
