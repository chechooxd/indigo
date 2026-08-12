# Design: Relation loading (`include` + typed `select`)

## Technical Approach

Batch-by-key, in-memory stitch. The parent query in `ModelDelegate.findMany` is unchanged
(so `LIMIT`/`OFFSET` stay correct). When `args.include` is present, a new private
`loadRelations` runs one follow-up query per included relation **through the target
model's own delegate**, using the existing `where: { field: { in: keys } }` operator —
which `buildWhere` already renders as `= ANY($n)`. No new SQL construction, no query
builder, no IR change (`ResolvedRelation` post slice-1 is sufficient).

Return-type narrowing lives in hand-written conditional types in
`packages/client/src/types.ts`, not in generator string templates. The generator only
emits one plain `interface <Model>Relations` per model and passes it as a 4th type
argument to `ModelDelegate`.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| 1 | Direction collapsed at **codegen** time: `__meta` emits `{ name, target, from, to, list }` where `from` = parent field(s), `to` = target field(s) | Emit raw `fkColumns`/`refColumns` + `inverse` and branch at runtime | IR `fkColumns`/`refColumns` are **physical** names and swap sides between holder and inverse. The generator has both tables and can map physical→field once; the runtime then has a single direction-agnostic rule: `target WHERE to IN (parent.from values)`. |
| 2 | Child fetch reuses the **sibling delegate's `findMany`** | Build child SQL inside the parent delegate from a duplicated target meta | Free aliasing, free nested `select`, free `in`→`ANY($1)`, and the child runs on the *same* `exec` (correct inside `$transaction`). |
| 3 | Siblings reached via a **lazy registry thunk** appended as the last ctor arg (`ModelDelegate(meta, exec, siblings?)`, `RealtimeModelDelegate(meta, exec, realtime, model, siblings?)`) | Pass a delegate map eagerly; pass the whole client | Thunk avoids construction-order cycles inside `__delegates`; appending last keeps every existing positional call site and both test harnesses compiling. |
| 4 | Payload conditional types live in `client/src/types.ts`; generator emits only `<Model>Relations` | Generate per-model `GetPayload` conditional types as strings | Conditional generics are type-checked once by the client package's own `tsc --noEmit` instead of being debugged through emitted text. Also makes the fallback a one-line change (see Open Questions). |
| 5 | Slice-1 supports **single-column relation keys only**; composite keys throw a typed runtime error | Row-constructor `(a,b) IN ((..),(..))` path | `{a:{in:[]},b:{in:[]}}` is a cross-product, so composite needs new SQL — exactly the query-builder growth the proposal rejects. Deferred with a clear error. |
| 6 | Zero-cost when `include` is absent: `loadRelations` is only called when `args.include` is set | Always run the stitch pass | Backward compatibility and the realtime refetch path. |

## Data Flow

    findMany(args)
      │  args.include? ── no ──→ SELECT … (unchanged) ──→ Row[]
      │  yes
      ├─ SELECT … (+ join-key fields forced into selectList) ──→ parents[]
      ├─ for each relation r in args.include:
      │     keys = distinct non-null parents[i][r.from]
      │     children = siblings()[r.target].findMany({
      │                   where: { [r.to]: { in: keys } },
      │                   select: r.select ? {…r.select, [r.to]: true} : undefined })
      │     bucket children by child[r.to]
      │     parent[r.name] = r.list ? (bucket ?? []) : (bucket?.[0] ?? null)
      │     strip child key field if it was only added for stitching
      └─ strip parent join-key fields not in args.select ──→ Payload[]

Null parent FK → no query key, attach `null` (to-one) / `[]` (to-many).
Empty `keys` → skip the query entirely (round trips = 1 + relations with keys).

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/types.ts` | Modify | `IncludeInput<Rel>`, `RelationMeta`, `ModelMeta.relations?`, `Payload<Row, Rel, A>` + `SelectedScalars<Row, S>`; `include?` on `FindManyArgs`/`FindFirstArgs`/`FindUniqueArgs` |
| `packages/client/src/delegate.ts` | Modify | 4th generic `Rel`, `siblings?` ctor arg, private `loadRelations`, generic `findMany`/`findFirst`/`findUnique` signatures, key-field augmentation in `selectList` |
| `packages/client/src/realtime-delegate.ts` | Modify | Propagate the `Rel` generic + `siblings` ctor arg to `super`. No behavioural change. |
| `packages/generator/src/client.ts` | Modify | `generateRelationsInterface(table)`; `__meta[*].relations`; registry wiring in `__delegates`; 4th generic at every delegate type/site |
| `packages/client/test/relations.mjs` | Create | PGlite-backed include/select suite |
| `packages/generator/test/relation-emission.mjs` (+ fixture) | Create | Codegen assertions |
| `packages/client/package.json`, `packages/generator/package.json` | Modify | Append new test files to the `test` script |

## Interfaces / Contracts

```ts
// client/src/types.ts (physical names never appear — `from`/`to` are FIELD names)
export interface RelationMeta { target: string; from: string; to: string; list: boolean }
export interface ModelMeta { table: string; fields: Record<string, FieldMeta>;
  relations?: Record<string, RelationMeta> }

export type IncludeInput<Rel> = { [K in keyof Rel]?: boolean | { select: Record<string, boolean> } };

export type SelectedScalars<Row, S> = [S] extends [undefined] ? Row
  : Pick<Row, { [K in keyof S]-?: S[K] extends true ? (K extends keyof Row ? K : never) : never }[keyof S]>;

export type Payload<Row, Rel, A> =
  SelectedScalars<Row, A extends { select: infer S } ? S : undefined> &
  (A extends { include: infer I } ? { [K in keyof I & keyof Rel]: Rel[K] } : unknown);

// delegate.ts
findMany<A extends FindManyArgs<Row, Rel>>(args?: A): Promise<Payload<Row, Rel, A>[]>
```

```ts
// generator emits, per model:
export interface UserRelations { posts: Post[]; profile: Profile | null }
// __meta.User.relations = { posts: { target: "Post", from: "id", to: "authorId", list: true },
//                           profile: { target: "Profile", from: "id", to: "userId", list: false } }
```

`__delegates` builds `const reg = {}; const siblings = () => reg;`, constructs each delegate
with `siblings`, then fills `reg[ModelName]` before returning — one registry per call, so a
`$transaction` client's includes stay on the session executor.

## Testing Strategy

Plain-Node `.mjs`, matching `test/client.mjs` (PGlite via `pglite-harness.mjs`) and
`test/enum-mapping.mjs` (string assertions on `generateClient` output). No new framework.

| Layer | What | Where |
|---|---|---|
| Codegen | `<Model>Relations` shape (list vs nullable), `__meta.relations` `from`/`to`/`list` for holder + inverse + `@map`'d columns, 4th generic + registry wiring emitted | `packages/generator/test/relation-emission.mjs` |
| Integration | 1-N, N-1, 1-1 include; empty to-many → `[]`; null FK / missing to-one → `null`; nested `select` inside include; parent `select` + `include` (key field stripped); round-trip count = 1 + relations; composite-key relation throws typed error | `packages/client/test/relations.mjs` |
| Regression | No `include` → byte-identical SQL and flat rows; `RealtimeModelDelegate.dispatch`'s `findFirst({ where: event.pk })` passes no `include` and returns a flat row | `packages/client/test/relations.mjs` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Child queries stay parameterized through `Params`; relation
identifiers come from `__meta`, never user input.

## Migration / Rollout

No migration. Purely additive: `include` is optional, `Rel` defaults to `{}`, existing
generated clients keep compiling until regenerated.

## Open Questions

- [ ] **GetPayload complexity checkpoint (decision point for `sdd-tasks`)**: implement
      `SelectedScalars`/`Payload` in `types.ts` first and gate on `pnpm lint` (i.e.
      `tsc --noEmit`) across `@indigodb/client` plus a compiled generated-client fixture.
      If narrowing does not hold — most likely failure modes: `select` inference widening to
      `SelectInput<Row>` instead of the literal (needs `const`-ish generic capture), or the
      intersection collapsing under `Promise` inference — take the user-confirmed fallback:
      `Payload<Row, Rel, A> = Row & Partial<Pick<Rel, …>>`. One line in `types.ts`, zero
      generator or runtime change, so the checkpoint is a scoped task, not a rewrite.
- [ ] Composite-key relations: error message wording + whether it is a compile-time
      (omit from `<Model>Relations`) or runtime rejection. Runtime is the current proposal.
