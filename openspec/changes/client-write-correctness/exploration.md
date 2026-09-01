# Exploration: Client correctness — remainder (`packages/client/src/delegate.ts`)

**Change**: `client-write-correctness`
**Roadmap item**: "Client correctness — remainder" (`@indigodb/client`, Phase 0 backlog)
**Engram**: `sdd/client-write-correctness/explore` (obs #848)

> Persisted here by the orchestrator: the exploration phase ran in a context with no
> Write/Edit tool, so the Engram half was written by the phase agent and this filesystem
> half — the other half of the hybrid artifact store — was not. Content is the phase
> agent's, unabridged.

## Current State

### Defect 1 — Empty `SET` on the direct update path (CONFIRMED)

`packages/client/src/delegate.ts:1229-1240` (`rawUpdate`) filters `undefined` out of `data`;
if every value is `undefined` and there are no relation ops, `assignments === ""` and the
emitted SQL is `UPDATE "t" SET  WHERE …` — invalid.

The nested-write planner's own guard (lines 1331-1334) only protects its own
`finalScalars`-empty case *after* relation-op resolution. It does not cover the direct
scalar-only call path (`updateImpl` line 1273, taken when `relOps` is empty).

### Defect 2 — Typed not-found lie (CONFIRMED, wider than the roadmap said)

Three sites, not two:

| Site | Line |
|------|------|
| `rawUpdate` | 1239 |
| `deleteImpl` | 1366 |
| `updateImpl`, relation-ops-only branch (casts `matches[0]`) | 1331-1334 |

`packages/client/test/nested-writes-update.mjs` case **C1.4c** (lines 306-319) **explicitly
asserts today's lying behavior**: `assert(result === undefined, "expected no row to be
returned")`. Fixing this is therefore a genuine runtime behavior change for that path, not a
purely additive guard — the "slice A is non-breaking" framing needs correcting.

### Defect 3 — No unique selector, but cheaper than assumed (CONFIRMED)

`UpdateArgs.where` / `DeleteArgs.where` (`types.ts:204-211`) share the class's 4th generic
(`Where` = full `WhereInput<Row>`) with `findMany` / `findFirst` / `updateMany` /
`deleteMany` / `count`. No `WhereUniqueInput` exists anywhere.

**But the machinery to build one already ships today, for `upsert`:**

- `packages/generator/src/client.ts:112-128` — `uniqueGroups(table)`: PK first, then
  `@unique` columns, then unique `@@index`/`@@unique` groups. Derived purely from
  `ResolvedTable`. **No IR gap** — `primaryKey`, `columns[].unique` and `indexes[].unique`
  all already exist in `@indigodb/core`'s `ir.ts`.
- `packages/generator/src/client.ts:731-747` — `generateUpsertWhereInput` emits
  `export type <Model>UpsertWhereInput = {group0} | {group1} | ...;` — exactly the needed shape.
- `ModelDelegate` already has a **9th generic** (`UniqueWhere = never`, `delegate.ts:406-418`),
  instantiated by the generated client as `<Model>UpsertWhereInput` in all three `generics`
  template strings (`generator/src/client.ts:395, 451, 519`).
- `resolveUpsertConflictTarget` (`delegate.ts:1683-1705`) already validates a `where` against
  `meta.uniqueGroups` and throws `IndigoArgumentError("NO_MATCHING_UNIQUE_CONSTRAINT", …)`
  before any SQL — the exact runtime-guard pattern `update`/`delete` need for `as any` bypasses.

The cheapest correct design reuses that 9th generic / `<Model>UpsertWhereInput` for
`update`/`delete` too (a method-signature-only change in `delegate.ts`) rather than inventing
a parallel type. The type would likely want renaming (e.g. to `WhereUniqueInput`) now that it
serves three call sites — **and that rename is what actually drives blast radius.**

### Not a defect

`findUnique` does **not** have this problem: it already returns `Payload | null`
(`delegate.ts:841-853`, delegating to `findFirst`), and is intentionally *not* restricted to a
unique selector despite its name. No spec asks for that. Must not regress.

## Affected Areas

- `packages/client/src/delegate.ts` — `rawUpdate` (1229), `updateImpl` (1269), `deleteImpl`
  (1360), `resolveUpsertConflictTarget` (1683) as the runtime-guard template, `ModelDelegate`'s
  9th generic (406-418).
- `packages/client/src/types.ts` — `UpdateArgs`/`DeleteArgs` (204-211), `UpsertArgs`/`UniqueWhere`
  doc (318-333).
- `packages/client/src/errors.ts` — the wrong home for not-found: `IndigoDatabaseError` wraps
  real Postgres SQLSTATE failures only, and a 0-row UPDATE/DELETE never throws at the driver.
- `packages/generator/src/client.ts` — `uniqueGroups` (112), `generateUpsertWhereInput` (731),
  3× `generics` template (395, 451, 519).
- `packages/generator/test/{transaction-emission,live-emit,where-emission}.mjs` — 8 exact
  string-literal occurrences of `<Model>UpsertWhereInput` needing rename.
- `packages/client/test/nested-writes-update.mjs` — C1.4c (306-319, behavior flip); line 294
  (`where: { name: "Dup" }` needs a bypass cast once `where` is type-restricted, but must keep
  throwing `AMBIGUOUS_UPDATE_TARGET` at runtime).
- `packages/client/test/fixtures/typecheck-fixture.ts` + `test/typecheck.mjs` — the golden
  compile-time checkpoint; needs new `@ts-expect-error` cases.
- **No Studio/CLI call sites affected.** A sweep of `.update(` / `.delete(` outside `test/`
  found only client/realtime/cli-migration internals and one unrelated `Set.delete()` in Studio.
  Studio's data browser talks to the raw SQL/REST API in `studio-server.ts`, never the
  generated `ModelDelegate`.
- No generator golden-snapshot suite (unlike the compiler's `parity.mjs`) — generator tests are
  bounded exact-substring assertions, not full-file diffs.

## Approaches

### 1. Two-PR split: runtime correctness, then the unique selector

Matches the natural non-breaking/breaking boundary.

- **Pros**: clean rollback per slice; slice B matches the existing
  `IndigoArgumentError`/`NO_MATCHING_UNIQUE_CONSTRAINT` precedent; both slices land comfortably
  under the 800-line budget (~150-250 and ~300-450 lines).
- **Cons**: slice A is **not** fully non-breaking — the not-found fix flips a tested behavior.
  Must be called out explicitly in the proposal, not glossed over.
- **Effort**: Low (A), Medium (B).

### 2. Type design for slice B: reuse `<Model>UpsertWhereInput` vs. mint a new type

- **Pros of reuse**: zero new generator function, zero new generic slot, and it reuses a runtime
  guard pattern that already exists and is already tested.
- **Cons**: renaming a shipped, spec'd type (`UpsertWhereInput`) touches its spec text and 8 test
  string literals — small but real, and a naming decision rather than something to settle
  unilaterally during exploration.
- **Effort**: Low-Medium.

## Recommendation

Proceed with the two-PR split, but:

1. Scope slice A's not-found fix explicitly as a **documented behavior change** with a rewritten
   C1.4c test, not as purely additive.
2. Resolve the `UpsertWhereInput`-rename-vs-new-type naming question in `sdd-propose` rather than
   deferring it further — it materially changes slice B's line count and spec-touch list.

## Risks

- Slice A's not-found fix silently changes nested-write zero-match semantics (currently a
  documented no-op, test C1.4c). Must be an explicit proposal decision, not an
  implementation-time surprise.
- `IndigoDatabaseError` is the wrong vehicle for not-found — it is scoped by its own spec Purpose
  to real pg SQLSTATE failures. A new error class is needed, and its home spec (new capability vs.
  folding into `client-database-errors`) is undecided.
- Renaming `<Model>UpsertWhereInput` retroactively touches an already-shipped, spec'd
  (`client-upsert`) type name. Needs explicit consent in the proposal, never a silent rename
  during apply.
- Models with zero declared unique groups become permanently unable to use `update`/`delete` in
  the typed client — the same limitation `upsert` and cursor pagination already impose. Worth a
  one-line migration note; low risk given the precedent.

## Ready for Proposal

Yes. Investigation is complete, the gap between "assumed new type" and "reuse of existing upsert
machinery" is resolved, blast radius is enumerable, and both open naming/scoping questions are
concrete enough for `sdd-propose` to decide rather than block on.
