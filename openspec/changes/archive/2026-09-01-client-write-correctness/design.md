# Design: Client write correctness (`update`/`delete`)

## Technical Approach

Two stacked PRs against `main`. PR 1 adds two pre/post-SQL guards inside
`packages/client/src/delegate.ts` only — no cross-package types move, so it builds and
tests standalone. PR 2 renames the generated `<Model>UpsertWhereInput` to
`<Model>WhereUniqueInput` and reuses the existing 9th `ModelDelegate` generic
(`UniqueWhere`, `delegate.ts:406-418`) as the `where` type of `update`/`delete`, backed
by a pre-SQL runtime guard modelled on `resolveUpsertConflictTarget` (`delegate.ts:1683-1705`).
No `@indigodb/core` IR change: `uniqueGroups` is already derived once in
`generator/src/client.ts:112-128` from `ResolvedTable`.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| D1 | `IndigoNotFoundError { code: "RECORD_NOT_FOUND" }` declared in `delegate.ts`, exported from the package root | Add to `errors.ts` | `errors.ts`/`IndigoDatabaseError` is spec-scoped to pg SQLSTATE wrapping and forbids wrapping non-pg errors; a zero-row UPDATE never reaches the driver. Every pre/post-SQL typed error already lives in `delegate.ts`. |
| D2 | Empty-`SET` guard lives at the top of `rawUpdate`, not in `updateImpl` | Guard in `updateImpl` before dispatch | `rawUpdate` is re-entered by the planner (phase 2) and by `applyNonFkSideOp`; guarding at the single SQL-emitting site closes every caller at once. Planner callers only reach it with non-empty `finalScalars`, so the pre-existing relation-ops guard (1331-1334) is unaffected. |
| D3 | Rename is **mechanical and total** — no transitional alias | Keep `export type <Model>UpsertWhereInput = <Model>WhereUniqueInput` for one release | Nothing is published to npm; a deprecated alias would be dead weight from birth and would defeat the "zero occurrences remain" success criterion. Verified: `openspec/specs/` contains the literal zero times; blast radius is 27 occurrences in 7 files, all in-repo. |
| D4 | The PR-2 runtime guard applies **only when `meta.uniqueGroups` is present and non-empty**; otherwise `where` passes through unchanged | Apply unconditionally like `upsertImpl` does | Confirmed blocker: every hand-authored test meta (`nested-writes-update.mjs:41-96`, `client.mjs`, `relations.mjs`, …) omits `uniqueGroups`. An unconditional guard would throw on every `update`/`delete` in the existing suite. Generated clients always emit `uniqueGroups`; a generated model with none emits `never` and is uncallable at compile time (UWS-8), so skipping empty is not a hole. |
| D5 | Guard order in `updateImpl`/`deleteImpl`: unique-selector guard **first**, before `splitData`/`findMany`; `NO_MATCHING_UNIQUE_CONSTRAINT` wins over `AMBIGUOUS_UPDATE_TARGET` | Run it after the ambiguity check | The unique guard is pre-SQL and strictly stronger; the ambiguity check (1293-1300) costs a `findMany` round trip. The two guards protect different surfaces (shape validity vs. actual multi-row match) and both remain in force — UWS-7 pins that the second is not shadowed. |
| D6 | Precedence when several guards fire: `NO_MATCHING_UNIQUE_CONSTRAINT` → `EMPTY_UPDATE_DATA` → `AMBIGUOUS_UPDATE_TARGET` → `RECORD_NOT_FOUND` | Unordered / first-thrown-wins | Cheapest, most-static failure first; `RECORD_NOT_FOUND` is necessarily last because it is the only one requiring the row read. |
| D7 | UWS-7's "unique-shape-valid `where` that still matches multiple rows" is reached by a **declared-but-unenforced** unique group: the hand-authored meta declares `uniqueGroups: [["name"]]` while the PGlite DDL creates no unique constraint on `name`, then two rows with the same `name` are inserted | Force a race; skip the scenario as unreachable | Deterministic, no timing dependency, and it is the real-world case the guard exists for (schema drift / a constraint dropped in the database but still present in the generated meta). The seam already exists: `ModelDelegate` is constructed with a plain meta object in every client test, so meta and DDL are independently authored. **This row is exercisable — verified against `nested-writes-update.mjs:55-118`, whose fixture is this setup minus the `uniqueGroups` declaration.** |

## Data Flow

    update(args)
      └─ [PR2] assertUniqueWhere(where)   ── meta.uniqueGroups non-empty? ──→ NO_MATCHING_UNIQUE_CONSTRAINT
      └─ splitData(data)
           ├─ relOps empty ──→ rawUpdate ─ [PR1] no assignments? → EMPTY_UPDATE_DATA (pre-SQL)
           │                             └─ UPDATE … RETURNING → rows[0] ?? [PR1] RECORD_NOT_FOUND
           └─ relOps present ─ runAtomic
                 ├─ findMany(where) → >1 → AMBIGUOUS_UPDATE_TARGET   (still reachable — D7)
                 ├─ finalScalars empty → matches[0] ?? [PR1] RECORD_NOT_FOUND   (was: return undefined)
                 └─ else rawUpdate(...) (inherits PR1 guards)
    delete(args)
      └─ [PR2] assertUniqueWhere → DELETE … RETURNING → rows[0] ?? [PR1] RECORD_NOT_FOUND

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/delegate.ts` | Modify | PR1: `IndigoNotFoundError` class + export; guard in `rawUpdate` (1229-1240); throw at 1331-1339 and `deleteImpl` 1360-1367. PR2: `assertUniqueWhere` (extracted sibling of `resolveUpsertConflictTarget`, kept as a **separate write-side function** per `config.yaml` design rule — not a reuse of the upsert resolver); `update`/`delete` signatures take `UniqueWhere`; doc comment 406-418. |
| `packages/client/src/types.ts` | Modify | PR2: `UpdateArgs`/`DeleteArgs` (204-211) gain a `UniqueWhere` parameter; `UniqueWhere` doc (318-333) renamed. |
| `packages/client/src/index.ts` | Modify | PR1: re-export `IndigoNotFoundError`. |
| `packages/generator/src/client.ts` | Modify | PR2: rename only (10 occurrences incl. `generateUpsertWhereInput` → `generateWhereUniqueInput`, 3× `generics` templates); `uniqueGroups` logic untouched. |
| `packages/client/test/write-preconditions.mjs` | Create | PR1 suite (RT-1, RT-2). |
| `packages/client/test/unique-write-selector.mjs` | Create | PR2 runtime-guard suite (RT-4, RT-5). |
| `packages/client/test/nested-writes-update.mjs` | Modify | PR1: rewrite C1.4c (306-319). C1.4b (282-304) is **unchanged** — it is `.mjs` (untypechecked) and `authorMeta` declares no `uniqueGroups`, so D4 leaves it firing `AMBIGUOUS_UPDATE_TARGET`. The exploration's "line 294 needs a cast" does not apply. |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modify | PR2: 5 renames (178, 182, 193, 418, 439) + new positive and `@ts-expect-error` cases (UWS-1/2/3/4/8/9, QTS-3, UPS-1/2). |
| `packages/generator/test/{transaction-emission,live-emit,where-emission}.mjs` | Modify | PR2: 9 string literals (6/1/2) + new emission assertions (UWS-8, QTS-1/3, UPS-3). |
| `packages/client/package.json` | Modify | **Append both new files to the `test` chain** (`node test/… && …`) — a test file not in the chain never runs. Pinned by row OPS-1. |

## Interfaces / Contracts

```ts
// delegate.ts (PR 1)
export class IndigoNotFoundError extends Error {
  readonly code = "RECORD_NOT_FOUND";
  constructor(readonly model: string, readonly operation: "update" | "delete") { /* … */ }
}

// delegate.ts (PR 2) — write-side only; read-side selectors are untouched
private assertUniqueWhere(where: Record<string, unknown>, op: "update" | "delete"): void;

// types.ts (PR 2)
export interface UpdateArgs<Row, UpdateInput, UniqueWhere = WhereInput<Row>> { where: UniqueWhere; data: UpdateInput; }
export interface DeleteArgs<Row, UniqueWhere = WhereInput<Row>> { where: UniqueWhere; }
```

Generated emission changes from `export type UserUpsertWhereInput = …` to
`export type UserWhereUniqueInput = …`; the union shape is byte-identical.

## Testing Strategy

Every scenario in all six delta specs has at least one row, keyed by spec ID:
`WP` = `client-write-preconditions` (7), `UWS` = `client-unique-write-selector` (9),
`NW` = `client-nested-writes` (4), `QTS` = `client-query-type-safety` (3),
`UPS` = `client-upsert` (3), `RT` = `client-runtime-tests` (5).
`D*` / `OPS-*` rows carry no spec scenario — they are design-only obligations.

| Spec ID | PR | Scenario | Layer | File | Assertion |
|---|---|---|---|---|---|
| WP-1 | 1 | All-undefined `data`, no relation ops, throws pre-SQL | SQL-shape (recording exec) | `client/test/write-preconditions.mjs` | throws `IndigoArgumentError` code `EMPTY_UPDATE_DATA` **and** `calls.length === 0` |
| WP-2 | 1 | Relation-ops-only empty-scalar guard remains in force | DB (PGlite) | `client/test/write-preconditions.mjs` | relation op applies; no `UPDATE … SET  ` emitted; pre-existing guard error unchanged |
| WP-3 | 1 | Single defined scalar assignment accepted | SQL-shape | `client/test/write-preconditions.mjs` | emitted SQL matches `UPDATE "user" SET "name" = $1 WHERE` |
| WP-4 | 1 | Zero-row update, direct scalar path, throws | DB | `client/test/write-preconditions.mjs` | throws `IndigoNotFoundError` code `RECORD_NOT_FOUND`; does not resolve |
| WP-5 | 1 | Zero-row delete throws | DB | `client/test/write-preconditions.mjs` | throws `IndigoNotFoundError` code `RECORD_NOT_FOUND` |
| WP-6 | 1 | Zero-row update, relation-ops-only branch, throws | DB | `client/test/nested-writes-update.mjs` **C1.4c rewritten** | replaces `assert(result === undefined)` with an expected `IndigoNotFoundError` throw; **keeps** `after[0].authorId === null`, so no-partial-write is still proven |
| WP-7 | 1 | Matching update resolves with the updated row | DB | `client/test/write-preconditions.mjs` | resolves with row; no throw |
| UWS-1 | 2 | A declared unique-group `where` **type-checks** | Compile-time | `client/test/fixtures/typecheck-fixture.ts` + `typecheck.mjs` | `db.user.update({ where: { email: "a@x.com" }, data: … })` compiles with **no** cast and **no** `@ts-expect-error` — the positive control that proves the fixture is not merely rejecting everything |
| UWS-2 | 2 | A non-unique-looking `where` fails to type-check | Compile-time | same | `@ts-expect-error` on `db.user.update({ where: { name: "A" }, … })`; a matching `@ts-expect-error` on `db.user.delete({ where: { name: "A" } })` |
| UWS-3 | 2 | `findUnique` unaffected (non-regression) | Compile-time + DB | `typecheck-fixture.ts`; `client/test/unique-write-selector.mjs` | `db.user.findUnique({ where: { name: "A" } })` compiles with no cast **and** resolves to `Payload \| null` at runtime |
| UWS-4 | 2 | `updateMany`/`deleteMany` keep the broad `where` (non-regression) | Compile-time + DB | `typecheck-fixture.ts`; `client/test/unique-write-selector.mjs` | both compile against the full `WhereInput<Row>` with a non-unique `where` **and** at runtime a multi-row `where` still updates/deletes every match |
| UWS-5 | 2 | `as any` bypass with a non-unique `where` throws pre-SQL | SQL-shape | `client/test/unique-write-selector.mjs` | `IndigoArgumentError` code `NO_MATCHING_UNIQUE_CONSTRAINT`; `calls.length === 0`. Sub-cases in the same row: operator object in `where`, and a partial composite key — both reject with the same code (exact key-set equality, mirroring `resolveUpsertConflictTarget`) |
| UWS-6 | 2 | `as any` bypass with a valid unique `where` is accepted | DB | `client/test/unique-write-selector.mjs` | `delete({ where: { email } } as any)` proceeds and returns the row — the guard does not over-reject |
| UWS-7 | 2 | Unique-shape-valid `where` that still matches multiple rows throws `AMBIGUOUS_UPDATE_TARGET` | DB | `client/test/unique-write-selector.mjs` | **Harness per D7**: meta declares `uniqueGroups: [["name"]]`, the DDL creates no unique constraint on `name`, two rows share `name: "Dup"`. `update({ where: { name: "Dup" }, data: { books: { connect: … } } })` passes `assertUniqueWhere`, then throws code `AMBIGUOUS_UPDATE_TARGET`; assert no `connect` happened. **See Open Questions — the spec names `IndigoArgumentError`, the shipped guard throws `IndigoNestedWriteError`** |
| UWS-8 | 2 | No-unique-group model cannot call `update`/`delete` | Emission + compile-time | `generator/test/where-emission.mjs`; `typecheck-fixture.ts` | emitted source contains `export type LogWhereUniqueInput = never`; `@ts-expect-error` on `db.log.update(...)` and on `db.log.delete(...)`. Distinct from the D4 row below: this is the **generated** compile-time consequence, not the hand-authored runtime one |
| UWS-9 | 2 | `updateMany`/`deleteMany` remain callable on that model | Compile-time | `typecheck-fixture.ts` | `db.log.updateMany({ where: { level: "error" }, data: … })` and `db.log.deleteMany({ where: { level: "error" } })` compile with no cast and no `@ts-expect-error` |
| NW-1 | 1 | `connect` links an existing row | DB | `client/test/nested-writes-update.mjs` (existing) | unchanged case stays green |
| NW-2 | 1 | `connect` to a non-existent row throws | DB | `client/test/nested-writes-update.mjs` (existing) | unchanged case stays green — distinct from `RECORD_NOT_FOUND` on the *parent* |
| NW-3 | 1 | `connectOrCreate` falls back to create when not found | DB | `client/test/nested-writes-update.mjs` (existing) | unchanged case stays green |
| NW-4 | 1 | Top-level relation-ops-only `update` with zero matching rows throws (behavior flip) | DB | `client/test/nested-writes-update.mjs` **C1.4c** | same row as WP-6; the delta's flipped semantics |
| QTS-1 | 2 | New arg interfaces are emitted per model | Emission | `generator/test/{where,transaction,live}-emission.mjs` | existing per-model arg-interface assertions stay green after the rename |
| QTS-2 | 2 | Existing generated clients keep compiling unchanged | Compile-time | `client/test/fixtures/typecheck-fixture.ts` + `typecheck.mjs` | every pre-existing call site in the fixture **that this change does not deliberately edit** still compiles; the `@ts-expect-error` count grows only by the markers UWS-2/8 add — no pre-existing call silently becomes an error |
| QTS-3 | 2 | `UpdateArgs`/`DeleteArgs` `where` typed as the shared unique-selector type | Emission + compile-time | `generator/test/where-emission.mjs`; `typecheck-fixture.ts` | emitted `UserUpdateArgs`/`UserDeleteArgs` reference `UserWhereUniqueInput`, not `UserWhereInput` |
| UPS-1 | 2 | `upsert` `where` on a non-unique field is rejected | SQL-shape | `client/test/upsert.mjs` (existing) | existing `NO_MATCHING_UNIQUE_CONSTRAINT` case stays green after the rename |
| UPS-2 | 2 | `upsert` compile-time restriction to declared unique groups | Compile-time | `typecheck-fixture.ts` | existing `@ts-expect-error` upsert case, retargeted to the renamed type, still errors |
| UPS-3 | 2 | Generated type name is shared with `update`/`delete` (non-breaking to upsert callers) | Emission | `generator/test/transaction-emission.mjs` | exactly one `WhereUniqueInput` type is emitted per model and all three of `upsert`/`update`/`delete` reference it; repo-wide `rg -c UpsertWhereInput` = 0 |
| RT-1 | 1 | Empty-`SET` suite covers direct + relation-ops-guarded paths | Suite | `client/test/write-preconditions.mjs` | suite exists and contains both WP-1 and WP-2 |
| RT-2 | 1 | Not-found suite covers all three write sites | Suite | `client/test/write-preconditions.mjs` + C1.4c | WP-4, WP-5, WP-6 all present |
| RT-3 | 1 | C1.4c rewritten to assert the throw | Suite | `client/test/nested-writes-update.mjs` | no `result === undefined` assertion remains anywhere in the file |
| RT-4 | 2 | Unique-selector suite covers accept, reject, ambiguous-target | Suite | `client/test/unique-write-selector.mjs` | UWS-5, UWS-6, UWS-7 all present |
| RT-5 | 2 | `findUnique` and `*Many` `where` semantics pinned as non-regressions | Suite | `client/test/unique-write-selector.mjs` | UWS-3 and UWS-4 runtime halves present |
| D4 | 2 | Delegate whose meta declares **no** `uniqueGroups` is unguarded at runtime | SQL-shape | `client/test/unique-write-selector.mjs` | `update({ where: { name: "x" } })` issues SQL — proves the guard is opt-in and does not break hand-authored metas. Design-only; complements, does not replace, UWS-8 |
| D5 | 2 | Guard-skipped × multi-row `where` × relation ops | DB | `client/test/nested-writes-update.mjs` C1.4b **unchanged** | still throws `AMBIGUOUS_UPDATE_TARGET` — the new guard did not shadow it |
| D6a | 1 | Zero-row `where` × all-undefined `data` | SQL-shape | `client/test/write-preconditions.mjs` | `EMPTY_UPDATE_DATA` wins; no SQL issued |
| D6b | 1 | Multi-row `where` × scalar-only `data` | DB | `client/test/write-preconditions.mjs` | still updates many and returns `rows[0]`; no `RECORD_NOT_FOUND`, no `AMBIGUOUS_UPDATE_TARGET` — PR 1 does not silently narrow the untyped path |
| D6c | 2 | Unique `where` × zero rows | DB | `client/test/unique-write-selector.mjs` | passes the guard, then throws PR 1's `RECORD_NOT_FOUND` — PR 2 does not retroactively change PR 1's error |
| D6d | 2 | Unique `where` × all-undefined `data` | SQL-shape | `client/test/unique-write-selector.mjs` | `EMPTY_UPDATE_DATA` still reached through the new signature |
| OPS-1 | 1+2 | Both new test files are wired into the package `test` chain | Build config | `packages/client/package.json` | `write-preconditions.mjs` (PR 1) and `unique-write-selector.mjs` (PR 2) each appear in the `test` script's `node … && …` chain. **A file absent from the chain never runs** — verify by confirming both names appear in the `pnpm --filter @indigodb/client test` console output, not only on disk |
| OPS-2 | 2 | No rename literal survives | Repo-wide | apply-time check | `rg -c UpsertWhereInput` across the repo returns 0 (no generator golden-snapshot suite exists, so nothing else catches a miss) |

**Commands.** Per-PR loop: `pnpm --filter @indigodb/client test` (and
`--filter @indigodb/generator` for PR 2). Before either PR is declared green, and
mandatorily for PR 2 (cross-package type change, generator → client via built `dist/`):
`pnpm clean && pnpm build --force && pnpm lint && pnpm test` from the repo root.
`pnpm clean && pnpm build` alone is **not** sufficient — Turbo restores a cached `dist/`
wholesale and will resurrect stale output across exactly this kind of change.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. All changes are in-process TypeScript with parameterized SQL;
no new identifier reaches a query from user text.

## Migration / Rollout

No data migration; nothing published. PR 1 is a documented runtime behavior change (silent
`undefined` → thrown `IndigoNotFoundError`): callers relying on the no-op must catch or use
`updateMany`/`deleteMany`. PR 2 is a compile-time narrowing; models with zero declared unique
groups emit `never` and lose typed `update`/`delete`, matching the existing `upsert`/cursor
limitation. Rollback: revert PR 2, then PR 1 — two independent commit ranges.

## Open Questions

- [ ] **UWS-7 error class mismatch.** The spec scenario says the call "MUST throw
      `IndigoArgumentError` with `code: "AMBIGUOUS_UPDATE_TARGET"`", but the shipped guard
      (`delegate.ts:1293-1300`) throws `IndigoNestedWriteError` with that code, and
      `nested-writes-update.mjs:297` already pins that class. This change does **not**
      re-home the error (that would be scope creep). The test asserts the current class and
      the spec's code; `sdd-spec` should correct the class name in the delta, or `sdd-verify`
      should read the requirement as code-bearing rather than class-bearing.
