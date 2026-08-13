# Design: Where Composition and Filters

## Technical Approach

One recursive SQL-expression builder replaces the flat loop in `ModelDelegate.buildWhere`
(`packages/client/src/delegate.ts:161`). `buildWhere` keeps its current signature and stays the
only caller-facing entry (`findManyImpl`, `rawUpdate`, `delete`, `count` are untouched); it
delegates to a new private `whereExpr` that returns a bare boolean SQL expression or `null`
("no constraint"), and wraps a non-null result in ` WHERE `.

```ts
interface WhereCtx { params: Params; alias: string | null; depth: number }
private whereExpr(where: Record<string, unknown> | undefined, meta: ModelMeta, ctx: WhereCtx): string | null
```

`alias: null` at the top level emits unqualified columns, so every existing generated statement
stays byte-identical. Subqueries (PR B) pass `"t{depth}"`. `ctx.params` is the single `Params`
instance already threaded through the statement, so `$N` numbering is inherently correct — no
counter is duplicated. Key dispatch order per object: `AND`/`OR`/`NOT` (structural, never
resolved through `meta.fields`) → `meta.relations[key]` (PR B) → `meta.fields[key]` → throw.

Types stay per-model and generated, mirroring `CreateInput`/`UpdateInput`: PR A emits
`<Model>WhereInput` with scalars + `AND`/`OR`/`NOT`, PR B adds relation keys, PR C adds JSON keys.
`ModelDelegate` gains a 5th generic `Where = WhereInput<Row>`, threaded through `FindManyArgs`,
`FindUniqueArgs`, `UpdateArgs`, `DeleteArgs`, `CountArgs` as an added defaulted parameter.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Type surface | Generated per-model `<Model>WhereInput` | Purely structural `WhereInput<Row>` widened with `AND/OR/NOT` (non-breaking, no generator change) | Structural suffices for PR A but cannot type relation keys against the *target's* own where-input recursively, nor restrict JSON filters to `Json` columns. Paying the break once, now, is the proposal's accepted call. |
| Expr shape | `whereExpr` returns `string \| null` | Returning `""` for empty | `null` distinguishes "no constraint" from a legitimately empty string and makes `AND: []`/`NOT: {}` handling explicit rather than accidental. |
| Column qualification | `alias: null` outer, `"t{depth}"` inside subqueries | Always qualify with the physical table name | Table-name qualification breaks self-relations (`"Comment"."parentId" = "Comment"."id"`) and rewrites every existing emitted statement. Depth aliases are collision-free and keep the diff at the subquery. |
| Relation SQL | Correlated `EXISTS`/`NOT EXISTS` | `JOIN` + `DISTINCT`; reuse of `loadRelations` | Filtering must happen before the outer `SELECT` resolves; `loadRelations` is a post-fetch batch loader (proposal). `EXISTS` needs no de-duplication and composes under `OR`/`NOT`. |
| Target metadata | `siblings()[target].meta` (TS `protected` is instance-accessible within the class) | New `targetMeta` blob in `__meta` | Zero new emitted metadata; the registry already exists for `include` and nested writes. Missing sibling → the existing `IndigoRelationError` message shape. |
| Unknown `where` key | Throw `IndigoWhereError` (PR A) | Silent fallthrough to `"key" = $n` | This is the exact defect the proposal opens with. Accepted key set widens per PR (fields → +relations → +json). |
| JSON detection | New `FieldMeta.json?: true`, emitted when `!col.isEnum && col.type === ScalarType.Json` | Structural detection on the `path` key alone | A `path` key on a non-JSON column must be a typed error, not a silent `#>` on a `text` column. |
| `@>` key name | `jsonContains` | `contains` | `contains` already means string `ILIKE %v%` in `WhereFilter`; same key, two meanings, is a footgun even inside a disjoint shape. |
| `every` | Vacuous truth (`NOT EXISTS (… AND NOT(f))`) | Require ≥1 child | Proposal decision 2; Prisma convention. |

## Data Flow

    args.where ──► buildWhere ──► whereExpr(meta, ctx{params, alias:null})
                                    │
                    ┌───────────────┼────────────────┬──────────────────┐
                 AND/OR/NOT      relation key      scalar field      json field
                    │               │                  │                 │
              recurse, same    whereExpr(target      operator          #> / #>> / @>
              ctx.params       meta, alias=t{d+1})   clauses           (PR C)
                    │               │
              "(a AND b)"      EXISTS ( SELECT 1 FROM "T" AS "t1"
              "(a OR b)"                WHERE "t1"."to" = <parent>."from"
              "NOT (a)"                   AND <nested> )

Empty-value identities: `AND: []` → `TRUE`, `OR: []` → `FALSE`, `AND: [{}]`/`NOT: {}`/`{}` → `null`
(contributes nothing). A single object passed to `AND`/`OR` is normalized to a one-element array.

## Relation SQL Shapes (PR B)

With parent qualifier `P` (table name at depth 0, else `"t{depth}"`), child alias `C = "t{depth+1}"`,
`R = meta.relations[key]` (`{target, from, to, list}` — already emitted):

| Op | SQL |
|---|---|
| `some` | `EXISTS (SELECT 1 FROM "T" AS C WHERE C."to" = P."from" AND (<f>))` |
| `none` | `NOT EXISTS (SELECT 1 FROM "T" AS C WHERE C."to" = P."from" AND (<f>))` |
| `every` | `NOT EXISTS (SELECT 1 FROM "T" AS C WHERE C."to" = P."from" AND NOT (<f>))` |

`<f>` is `whereExpr(nested, targetMeta, {…ctx, alias: C, depth: depth+1})`; a `null` `<f>` drops the
`AND (<f>)` term (`some: {}` = "has any child"). At depth 0, `P."from"` must be qualified with the
physical table name (`"Post"."id"`) even though the outer clause is unqualified — valid because the
outer `FROM` has no alias. Composite relations (`"composite" in relMeta`) throw, as in
`loadRelations`. To-one relation filters stay out of scope.

## JSON Filter (PR C)

`{ path: string[], equals?, not?, gt?, gte?, lt?, lte?, jsonContains? }`, `path: []` = whole column.
`$p = params.add(path)` bound once per filter object as a `text[]`.

| Op | SQL | Cast rule |
|---|---|---|
| `equals` / `not` | `(col #> $p::text[]) = $v::jsonb` | `$v = JSON.stringify(value)` |
| `gt`/`gte`/`lt`/`lte`, numeric operand | `(col #>> $p::text[])::numeric > $v` | `typeof value === "number"` |
| same, string operand | `(col #>> $p::text[]) > $v` | text collation |
| `jsonContains` | `(col #> $p::text[]) @> $v::jsonb` | `$v = JSON.stringify(value)` |

`#>>` returns `text`, hence the explicit `::numeric` for numeric operands — this is the casting
decision. Boolean/null operands are only valid with `equals`/`not` (jsonb equality).

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `packages/client/src/types.ts` | A | Modify | `WhereInput<Row>` + `AND`/`OR`/`NOT`; `Where` generic on the five args interfaces |
| `packages/client/src/delegate.ts` | A | Modify | `whereExpr` recursion, `WhereCtx`, `IndigoWhereError` |
| `packages/client/src/realtime-delegate.ts` | A,B,C | Modify | `Where` generic on five args interfaces (same treatment as `ModelDelegate`) |
| `packages/generator/src/client.ts` | A | Modify | `generateWhereInput`; delegate/args reference `<Model>WhereInput` |
| `packages/client/test/where-composition.mjs` | A | Create | Fake-executor SQL/param assertions + PGlite round-trip |
| `packages/generator/test/where-emission.mjs` | A | Create | Emitted-text assertions on `<Model>WhereInput` |
| `packages/client/src/types.ts` / `delegate.ts` | B | Modify | `RelationFilter<W>`; `EXISTS` branch + alias plumbing |
| `packages/generator/src/client.ts` | B | Modify | Relation keys typed `RelationFilter<<Target>WhereInput>` |
| `packages/client/test/where-relations.mjs` | B | Create | Subquery shape + vacuous-`every` coverage |
| `packages/client/src/types.ts` | C | Modify | `JsonFilter`; `FieldMeta.json?: true` |
| `packages/client/src/delegate.ts` | C | Modify | JSON operator branch |
| `packages/generator/src/client.ts` | C | Modify | Emit `json: true`; JSON columns typed `JsonFilter` |
| `packages/client/test/where-json.mjs` | C | Create | Operator SQL + PGlite `jsonb` round-trip |
| `packages/client/test/fixtures/typecheck-fixture.ts` | A,B,C | Modify | Per-model where-input shape; `@ts-expect-error` negatives |
| `packages/client/package.json` | A,B,C | Modify | Wire each new suite into `test` |

## Testing Strategy

Existing conventions only — plain Node `.mjs` with the local `check`/`assert` helpers, no framework.

| Layer | What | Approach |
|---|---|---|
| Unit (SQL) | Exact clause text and `params` array per PR | Fake executor (`stubExecutor` in `test/client.mjs`) capturing `{sql, params}`; assert parenthesization and strict `$1..$n` ordering across nested `AND`/`OR`/`NOT` |
| Unit (errors) | Unknown key, composite relation, `path` on non-JSON | `assert.rejects` on the typed error `code` |
| Types | `<Model>WhereInput` recursion; relation/JSON key typing | Extend `test/fixtures/typecheck-fixture.ts` + `tsc --noEmit` via `test/typecheck.mjs`, with `@ts-expect-error` negatives |
| Integration | Real semantics | `withDatabase`/`createPgliteExecutor` (`test/pglite-harness.mjs`): `OR` returns the union; zero-children row satisfies `every`; `jsonb` path comparisons round-trip |
| Generator | Emitted text | New `.mjs` in `packages/generator/test/`, same style as `relation-emission.mjs` |

Build order: `@indigodb/client` must be rebuilt before `@indigodb/generator` typechecks the new
type references (`workspace:*` consumes `dist/`).

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. All generated SQL stays parameterized; only identifiers derived from
compiler-resolved metadata are interpolated, through the existing `quote()`.

## Migration / Rollout

No data migration. `<Model>WhereInput` is a generated-type break: consumers re-run
`indigodb generate`. Chained stack — PR A → PR B, PR C independent of B.

## Review Budget Forecast

| PR | Est. authored lines | Risk |
|---|---|---|
| A | ~420 (types 60, delegate 100, generator 40, tests 220) | Medium — over the 400 default, well under 800 |
| B | ~330 | Low |
| C | ~270 | Low |

All three under the 800-line budget. PR A is the largest despite being conceptually smallest,
because the `Where` generic touches five args interfaces and the typecheck fixture.

## Open Questions

- [ ] `NOT` accepts a single object only (type and runtime aligned). Confirm no array form is wanted.
- [ ] `jsonContains` naming — deviates from Prisma, which has no direct equivalent at a path.
- [ ] Should `IndigoWhereError` on an unknown key land in PR A, or stay a follow-up to keep PR A
      strictly additive? Design assumes PR A.
