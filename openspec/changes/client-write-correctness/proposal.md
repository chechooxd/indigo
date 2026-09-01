# Proposal: Client write correctness (`update`/`delete`)

## Intent

`@indigodb/client`'s `update`/`delete` are wrong in three ways: an all-`undefined` `data`
emits invalid `UPDATE "t" SET  WHERE …`; a zero-row match returns a value typed as the row
but actually `undefined` (a typed lie at `rawUpdate:1239`, `deleteImpl:1366`, and
`updateImpl`'s relation-ops-only branch 1331-1334); and `where` accepts any `WhereInput`, so
a single call can silently hit many rows. Nothing is published to npm yet — this is the cheap
moment to fix all three.

## Scope

### In Scope

**PR 1 — runtime correctness** (`stacked-to-main`, ~150-250 lines)
- Empty-`SET` guard on the direct scalar path: `IndigoArgumentError("EMPTY_UPDATE_DATA")`, pre-SQL.
- New `IndigoNotFoundError { code: "RECORD_NOT_FOUND" }` in `delegate.ts`, thrown at all
  **three** sites above.
- **Not purely additive.** `packages/client/test/nested-writes-update.mjs` C1.4c (306-319)
  asserts `result === undefined` — the suite ratifies the defect. Rewriting it to expect a
  throw is scoped work, justified because the current assertion encodes the bug.

**PR 2 — unique selector** (child of PR 1, ~300-450 lines)
- Rename `<Model>UpsertWhereInput` → `<Model>WhereUniqueInput` (approved). Reuse the existing
  9th `ModelDelegate` generic (`UniqueWhere`) for `update`/`delete`; no parallel type.
- Rename sites: `generator/src/client.ts` (110, 349, 360, 395, 451, 519, 722, 731, 734, 746),
  `client/src/delegate.ts:413,1701`, `client/src/types.ts:323`,
  `client/test/fixtures/typecheck-fixture.ts:178,182,193,418,439`, and **9** (not 8) generator
  test literals: `transaction-emission.mjs:61,70,86,92,115,121`, `live-emit.mjs:49`,
  `where-emission.mjs:100,106`. **No spec file contains the literal string** — verified; the
  brief's "archived spec text" touch does not exist.
- Pre-SQL runtime guard for `as any` bypasses, mirroring `resolveUpsertConflictTarget:1683`
  (`IndigoArgumentError("NO_MATCHING_UNIQUE_CONSTRAINT")`).

The PR cut is correct: it is the exact non-breaking/breaking-type boundary, and each slice
rolls back independently.

### Out of Scope (non-goals — stated per `config.yaml`'s scope-creep rule)
- `findUnique`'s selector — deliberately non-unique, returns `Payload | null`, verified
  correct, must not regress.
- `updateMany`/`deleteMany`'s broad `where` — legitimate by design; they are the tolerant
  escape hatch this change depends on.
- Any other `delegate.ts` cleanup. "While we're in there" is out.
- No Studio/CLI call sites; no `crates/`, so no `build:wasm`.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Not-found error home | New `IndigoNotFoundError` in `delegate.ts`; new capability `client-write-preconditions` | `client-database-errors`' Purpose scopes `IndigoDatabaseError` to SQLSTATE wrapping, and one of its requirements says non-pg errors MUST NOT be wrapped. A zero-row UPDATE never reaches the driver. Folding it in would contradict that spec. `delegate.ts` already hosts every pre/post-SQL typed error with the same `code`+message convention. |
| Throw or `null`? | **Throw** | Prisma's contract; `updateMany`/`deleteMany` already ship as the tolerant path. Consequence: callers who relied on a silent no-op must catch or switch to `*Many`. |
| Models with no unique group | Accept; document | `<Model>WhereUniqueInput` emits `never`, so `update`/`delete` become uncallable there — the same limitation `upsert` and cursor pagination already impose. `updateMany`/`deleteMany` remain available. |

## Capabilities

### New
- `client-write-preconditions`: empty-`SET` rejection and typed not-found for `update`/`delete`
  across all three delegate paths.
- `client-unique-write-selector`: `update`/`delete` `where` restricted to `<Model>WhereUniqueInput`
  at compile time, with a pre-SQL runtime guard.

### Modified
- `client-nested-writes`: zero-match semantics for the relation-ops-only branch flip from
  silent `undefined` to `IndigoNotFoundError` (supersedes C1.4c's current behavior).
- `client-upsert`: its unique-`where` type is renamed and now shared with `update`/`delete`;
  behavior unchanged.
- `client-runtime-tests`: coverage for the new guards and the flipped nested-write case.
- `client-query-type-safety`: `<Model>WhereUniqueInput` naming in generated arg types.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/client/src/delegate.ts` | Modified | 1229, 1269, 1331-1334, 1360-1366, 406-418, new error class |
| `packages/client/src/types.ts` | Modified | `UpdateArgs`/`DeleteArgs` 204-211; `UniqueWhere` doc 318-333 |
| `packages/generator/src/client.ts` | Modified | rename only; `uniqueGroups` logic untouched |
| `packages/{client,generator}/test/*` | Modified | C1.4c rewrite, line 294 cast, 9 literals, new `@ts-expect-error` cases |
| `packages/client/src/errors.ts` | Unchanged | deliberately — see Decisions |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| PR 1 flips a green test; reviewer reads it as regression | High | Called out here and in the task's own commit message; spec delta states the new semantics |
| Rename misses a literal (no generator golden snapshots) | Med | Sites enumerated above; `pnpm lint` + `pnpm test` catch the rest |
| A no-unique-group model loses `update`/`delete` | Low | Documented precedent; `*Many` remains |
| Turbo cache masks a stale `dist/` across the client↔generator type change | Med | `pnpm clean && pnpm build --force` before verify |

## Rollback Plan

Two independent revertable commit ranges. Reverting PR 2 restores the `UpsertWhereInput` name
and the wide `where`; reverting PR 1 restores the silent-`undefined` behavior and C1.4c. No
data migration, no released artifact, no schema change.

## Dependencies

PR 2 stacks on PR 1 (shares `delegate.ts` write paths). No external dependencies.

## Success Criteria

- [ ] All-`undefined` `data` throws `IndigoArgumentError("EMPTY_UPDATE_DATA")`; no SQL issued.
- [ ] Zero-row `update`/`delete` throws `IndigoNotFoundError("RECORD_NOT_FOUND")` at all three sites.
- [ ] C1.4c asserts the throw, with the behavior change stated in the delta spec.
- [ ] `db.user.update({ where: { name: "x" } })` fails to typecheck; the `as any` bypass throws pre-SQL.
- [ ] Zero occurrences of `UpsertWhereInput` remain; `pnpm build && pnpm lint && pnpm test` green after `--force`.
