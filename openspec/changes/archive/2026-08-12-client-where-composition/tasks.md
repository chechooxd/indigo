# Tasks: Where Composition and Filters

Delivery: chained stack of 3 PRs (auto-chain). PR A → PR B (depends on A). PR C is
independent of B and may land directly after A. Strict TDD: every task pair is RED
(failing test committed/verified first) then GREEN (minimal implementation to pass).

## Review Workload Forecast

| PR | Est. authored lines | Risk | Budget note |
|---|---|---|---|
| A | ~420 (types 60, delegate 100, generator 40, tests 220) | Medium | Exceeds the 400-line default single-review size, but fits inside the 800-line session budget confirmed for this change. Recommend reviewing PR A independently rather than folding B/C into one diff. |
| B | ~330 | Low | Within default budget |
| C | ~270 | Low | Within default budget |

Auto-chain delivery is already selected: land and review A, then B and C independently
(B depends on A; C only depends on A, not on B). Do not batch A+B+C into a single review
pass — each stays under budget only when reviewed as its own PR.

---

## PR A — Recursive AND/OR/NOT WhereInput (foundation, ~420 lines)

Satisfies spec requirements: "Recursive per-model WhereInput type", "Structural keys
resolved before field loop", "Correct recursive parenthesization and shared param
numbering", "Empty AND/OR identity semantics".

### A1. Types — per-model WhereInput shape [sequential, blocks A2-A6]
- [x] A1.1 (RED) In `packages/client/test/fixtures/typecheck-fixture.ts`, add expected
      `<Model>WhereInput` shape assertions (`AND?`, `OR?`, `NOT?` self-refs) plus
      `@ts-expect-error` negatives (`NOT` rejecting an array); run `test/typecheck.mjs`
      and confirm it fails against the current flat `WhereInput<Row>`.
      — Satisfies: "NOT accepts a single object only" scenario.
- [x] A1.2 (GREEN) In `packages/client/src/types.ts`: replace flat `WhereInput<Row>`
      with the recursive per-model shape contract (`AND?: Self[]`, `OR?: Self[]`,
      `NOT?: Self`); add the 5th `Where` generic (defaulted) to `ModelDelegate` and
      to `FindManyArgs`, `FindUniqueArgs`, `UpdateArgs`, `DeleteArgs`, `CountArgs`.
      Re-run typecheck fixture to green.
      — Satisfies: "Generated type replaces flat WhereInput".

### A2. Generator — emit per-model WhereInput [sequential, depends on A1]
- [x] A2.1 (RED) Create `packages/generator/test/where-emission.mjs`: assert emitted
      `indigo.ts` text contains `<Model>WhereInput` with `AND?`, `OR?`, `NOT?`
      self-references and per-field predicate keys, and asserts no flat
      `WhereInput<Row>` type is emitted for the model. Wire into
      `packages/generator/package.json` `test` script. Confirm it fails (generator
      still emits old shape).
- [x] A2.2 (GREEN) In `packages/generator/src/client.ts`, add `generateWhereInput`
      emitting the per-model interface; update delegate/args type references to
      `<Model>WhereInput`. Green the new suite.
      — Satisfies: "Generated type replaces flat WhereInput".

### A3. Delegate — whereExpr recursive builder [sequential, depends on A1]
- [x] A3.1 (RED) Create `packages/client/test/where-composition.mjs` using the fake
      executor (`stubExecutor` from `test/client.mjs`): assert `{sql, params}` for
      `where: { OR: [{a:1},{b:2}] }` (previously crashed as `column "OR"`), nested
      `AND: [{a:1}, {OR:[{b:2},{NOT:{c:3}}]}]` with sequential `$1,$2,$3`, and empty
      `AND: []` → `TRUE`/no params, `OR: []` → `FALSE`/no params. Confirm RED against
      current flat `buildWhere`.
      — Satisfies: "OR no longer crashes", "Nested AND/OR/NOT numbering stays
      sequential", "Empty AND matches all rows", "Empty OR matches no rows".
- [x] A3.2 (RED) Same file: assert an unknown `where` key throws `IndigoWhereError`
      (`assert.rejects` on typed `.code`). Confirm RED (current code silently treats
      it as a column).
- [x] A3.3 (GREEN) In `packages/client/src/delegate.ts`: introduce `WhereCtx {params,
      alias: string | null, depth: number}`; add private `whereExpr(where, meta, ctx):
      string | null` implementing structural-key dispatch (`AND`/`OR`/`NOT` before
      `meta.fields`), empty-array identities, `AND:[{}]`/`NOT:{}`/`{}` → `null`,
      single-object normalization to one-element array for `AND`/`OR`, and
      `IndigoWhereError` on unrecognized keys. Rewrite `buildWhere` as a thin wrapper:
      calls `whereExpr(where, meta, {params, alias: null, depth: 0})`, wraps non-null
      result in ` WHERE `. Keep `alias: null` unqualified at depth 0 so existing
      non-where-composition statements stay byte-identical. Green A3.1/A3.2.
      — Satisfies: "Structural keys resolved before field loop", "Correct recursive
      parenthesization and shared param numbering", "Empty AND/OR identity
      semantics".
- [x] A3.4 (GREEN, regression) Run existing `packages/client/test/*` scalar-`where`
      suites to confirm no byte-level SQL regressions from the `buildWhere` rewrite
      (alias:null must reproduce prior unqualified-column output exactly).

### A4. Integration coverage [sequential, depends on A3]
- [x] A4.1 Add PGlite round-trip case(s) to `where-composition.mjs` via
      `withDatabase`/`createPgliteExecutor` (`test/pglite-harness.mjs`): `OR` returns
      the expected row union against a live table.

### A5. Wire test suite [depends on A3, A4]
- [x] A5.1 Add `where-composition.mjs` to `packages/client/package.json` `test` script.

### A6. Build-order-coupled verification [sequential, depends on A1-A5, closes PR A]
- [x] A6.1 `pnpm build --filter=@indigodb/client` (must succeed before generator
      typechecks the new type references, per design's build-order note).
- [x] A6.2 `pnpm build --filter=@indigodb/generator`.
- [x] A6.3 `pnpm build` (full monorepo).
- [x] A6.4 `pnpm lint` (full monorepo).
- [x] A6.5 `pnpm test` (full monorepo, includes new suites via Turbo).

---

## PR B — Relation filters: some/every/none via correlated EXISTS (~330 lines, depends on PR A)

Satisfies spec requirement: "To-many relation filters via correlated subqueries".

### B1. Types — relation filter keys [sequential, blocks B2-B4]
- [x] B1.1 (RED) Extend `typecheck-fixture.ts`: assert relation keys (`some`/
      `every`/`none`) on to-many relations typed as `RelationFilter<<Target>WhereInput>`,
      with `@ts-expect-error` on a to-one relation exposing the same keys. Confirm RED.
- [x] B1.2 (GREEN) In `packages/client/src/types.ts`, add `RelationFilter<W>` type.
      Green fixture (generator wiring lands in B2).

### B2. Generator — emit relation filter keys [sequential, depends on A2, B1]
- [x] B2.1 (RED) Extend `packages/generator/test/where-emission.mjs`: assert to-many
      relation keys typed `RelationFilter<<Target>WhereInput>` in emitted `indigo.ts`;
      to-one relations get no such keys. Confirm RED.
- [x] B2.2 (GREEN) In `packages/generator/src/client.ts`, extend `generateWhereInput`
      to add relation keys for to-many relations, reusing `resolveRelationInfo`'s
      `{target, list, from, to}` metadata (no new runtime metadata). Green.
      — Satisfies: "reusing resolveRelationInfo's {target, list, from, to} metadata".

### B3. Delegate — EXISTS/NOT EXISTS subquery compilation [sequential, depends on A3, B1]
- [x] B3.1 (RED) Create `packages/client/test/where-relations.mjs` (fake executor):
      assert `some` compiles to `EXISTS (SELECT 1 FROM "T" AS "t1" WHERE "t1"."to" =
      "Parent"."from" AND (<f>))`; `none` to the `NOT EXISTS` equivalent; `every` to
      vacuous-truth form `NOT EXISTS (... AND NOT (<f>))`; a zero-children row
      satisfies `every` (PGlite case, see B4). Assert composite relations
      (`"composite" in relMeta`) throw the existing `IndigoRelationError` shape.
      Confirm RED.
      — Satisfies: "some compiles to EXISTS", "none compiles to NOT EXISTS", "every
      uses vacuous truth".
- [x] B3.2 (RED) Same file: assert self-relation nesting (e.g. `Comment` filtering by
      `replies: { some: {...} }` where target === self) produces collision-free
      depth-indexed aliases (`t1`, `t2`, ...) rather than reusing the parent alias.
      Confirm RED.
- [x] B3.3 (GREEN) In `packages/client/src/delegate.ts`: extend `whereExpr` dispatch
      to check `meta.relations[key]` before `meta.fields[key]`; compile `some`/`none`/
      `every` per the design's SQL shapes table, using `t{depth}` aliases and
      `protected` same-class member access to the target model's `meta` (via
      `siblings()[target].meta`, matching `include`'s existing pattern — no new
      runtime metadata). A `null` nested `<f>` drops the `AND (<f>)` term. Recurse
      via `whereExpr(nested, targetMeta, {...ctx, alias: C, depth: depth+1})`. At
      depth 0, qualify `P."from"` with the physical table name even though the outer
      clause is unqualified. Green B3.1/B3.2.
      — Satisfies full "To-many relation filters via correlated subqueries"
      requirement including the `some`/`none`/`every` scenarios.

### B4. Integration coverage [depends on B3]
- [x] B4.1 Add PGlite round-trip to `where-relations.mjs`: `every` on a parent row
      with zero related children returns that row (vacuous truth), confirming the
      spec's explicit zero-children scenario against a live database.

### B5. Wire test suite [depends on B3]
- [x] B5.1 Add `where-relations.mjs` to `packages/client/package.json` `test` script.

### B6. Build-order-coupled verification [sequential, depends on B1-B5, closes PR B]
- [x] B6.1 `pnpm build --filter=@indigodb/client`.
- [x] B6.2 `pnpm build --filter=@indigodb/generator`.
- [x] B6.3 `pnpm build` (full monorepo).
- [x] B6.4 `pnpm lint` (full monorepo).
- [x] B6.5 `pnpm test` (full monorepo).

---

## PR C — JSON path filters (~270 lines, independent of PR B, depends only on PR A)

Satisfies spec requirement: "JSON path filters".

### C1. Types — JsonFilter + json metadata bit [sequential, blocks C2-C4]
- [x] C1.1 (RED) Extend `typecheck-fixture.ts`: assert a `Json`/`jsonb` field is typed
      `JsonFilter` (`{path: string[], equals?, not?, gt?, gte?, lt?, lte?,
      jsonContains?}`) and a non-JSON field is not. Confirm RED.
- [x] C1.2 (GREEN) In `packages/client/src/types.ts`, add `JsonFilter` type and
      `FieldMeta.json?: true` metadata field. Green fixture (emission wiring in C2).
      — Satisfies design decision: JSON detection via `FieldMeta.json`, not
      structural inference from the `path` key alone.

### C2. Generator — emit json:true and JsonFilter typing [sequential, depends on A2, C1]
- [x] C2.1 (RED) Extend `packages/generator/test/where-emission.mjs`: assert emitted
      field metadata sets `json: true` for `Json`/`jsonb` columns and that the
      generated where-input types those fields as `JsonFilter`. Confirm RED.
- [x] C2.2 (GREEN) In `packages/generator/src/client.ts`, emit `json: true` when
      `!col.isEnum && col.type === ScalarType.Json`, and type JSON columns as
      `JsonFilter` in `generateWhereInput`. Green.

### C3. Delegate — JSON operator compilation [sequential, depends on A3, C1]
- [x] C3.1 (RED) Create `packages/client/test/where-json.mjs` (fake executor): assert
      `equals`/`not` compile to `(col #> $p::text[]) = $v::jsonb` with
      `$v = JSON.stringify(value)`; `gt`/`gte`/`lt`/`lte` with numeric operand compile
      to `(col #>> $p::text[])::numeric > $v` (and gte/lt/lte equivalents); same with
      string operand compile without the `::numeric` cast; `jsonContains` compiles to
      `(col #> $p::text[]) @> $v::jsonb`. Assert `path` on a non-JSON column throws
      `IndigoWhereError` rather than silently emitting `#>`. Confirm RED.
      — Satisfies: "equals compiles to containment", "gt/lt compile to path text
      comparison".
- [x] C3.2 (GREEN) In `packages/client/src/delegate.ts`, extend `whereExpr`'s
      field-level dispatch: when `fieldMeta.json` and value has a `path` key, compile
      per the design's JSON operator table; bind `$p = params.add(path)` once per
      filter object as `text[]`; raise `IndigoWhereError` when a `path` key appears
      against a non-`json` field. Green C3.1.

### C4. Integration coverage [depends on C3]
- [x] C4.1 Add PGlite round-trip to `where-json.mjs`: `jsonb` path comparisons
      (`equals`, `gt`) round-trip against a live table with `jsonb` columns.

### C5. Wire test suite [depends on C3]
- [x] C5.1 Add `where-json.mjs` to `packages/client/package.json` `test` script.

### C6. Build-order-coupled verification [sequential, depends on C1-C5, closes PR C]
- [x] C6.1 `pnpm build --filter=@indigodb/client`.
- [x] C6.2 `pnpm build --filter=@indigodb/generator`.
- [x] C6.3 `pnpm build` (full monorepo).
- [x] C6.4 `pnpm lint` (full monorepo).
- [x] C6.5 `pnpm test` (full monorepo).

---

## Parallelization notes

- Within a PR, `*.1` type tasks are sequential blockers for the generator (`*2`) and
  delegate (`*3`) tasks that consume the type shape, but generator and delegate work
  can proceed in parallel with each other once the type task for that PR is GREEN
  (they touch disjoint files: `packages/generator/src/client.ts` vs
  `packages/client/src/delegate.ts`).
- PR C's task tree has no file overlap with PR B's (B touches relation dispatch, C
  touches field-level JSON dispatch in the same `whereExpr` function but different
  branches) — both may be developed in parallel branches off PR A, but land as two
  separate reviewed PRs per the chained-stack rollback plan (proposal: "PR C and
  PR B revert cleanly on their own").
- PR B may NOT start before PR A is merged (depends on `whereExpr`/`WhereCtx`
  existing). PR C may NOT start before PR A is merged, for the same reason, but does
  not need PR B.
- Build-order coupling (`A6`/`B6`/`C6`, `client` before `generator`) is sequential
  within each PR's closing verification and cannot be parallelized — the generator
  consumes `@indigodb/client`'s built `dist/` type references.

## Unresolved items carried from design (do not block PR A on these; flag for review)

- [ ] Confirm `NOT` accepts a single object only, no array form (design assumption,
  encoded in A1.1's `@ts-expect-error` negative).
- [ ] Confirm `jsonContains` naming is acceptable (deviates from Prisma; encoded in
  C1/C3).
- [ ] Confirm `IndigoWhereError` on unknown `where` key lands in PR A rather than as a
  follow-up (design assumes PR A; encoded in A3.2/A3.3 — flag explicitly at PR A
  review since this is the one behavior change beyond pure type restructuring).
