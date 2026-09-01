# Tasks: Client write correctness (`update`/`delete`)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR 1 ~180-260; PR 2 ~330-460 |
| 400-line budget risk | PR 1: Low; PR 2: Medium (near budget, generator+client+fixtures) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (runtime correctness) → PR 2 (unique selector, stacks on PR 1) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low (PR1) / Medium (PR2)

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Empty-`SET` guard + `IndigoNotFoundError` at 3 sites | PR 1 | `pnpm --filter @indigodb/client test` | PGlite via `write-preconditions.mjs`, `nested-writes-update.mjs` | `delegate.ts`, `index.ts`, `write-preconditions.mjs`, C1.4c rewrite — revertable as one commit range |
| 2 | Rename + `UniqueWhere`-narrowed `update`/`delete` + `assertUniqueWhere` guard | PR 2 | `pnpm --filter @indigodb/client test && pnpm --filter @indigodb/generator test` | PGlite via `unique-write-selector.mjs`; compile-time via `typecheck-fixture.ts` | `delegate.ts`, `types.ts`, `generator/src/client.ts`, all rename sites — independent revert restoring `UpsertWhereInput` |

## PR 1 — Runtime correctness

### Phase 1: RED — write-preconditions.mjs (WP-1..7, D6a, D6b)

- [x] 1.1 Create `packages/client/test/write-preconditions.mjs`; RED test for WP-1: all-undefined `data`, no relation ops → expect `IndigoArgumentError` code `EMPTY_UPDATE_DATA`, `calls.length === 0`.
- [x] 1.2 RED test WP-2: relation-ops-only path still guarded — no `UPDATE … SET  ` SQL emitted; pre-existing guard unchanged.
- [x] 1.3 RED test WP-3: single defined scalar accepted, SQL matches `UPDATE "user" SET "name" = $1 WHERE`.
- [x] 1.4 RED test WP-4: zero-row direct-scalar update throws `IndigoNotFoundError` code `RECORD_NOT_FOUND`.
- [x] 1.5 RED test WP-5: zero-row delete throws `IndigoNotFoundError` code `RECORD_NOT_FOUND`.
- [x] 1.6 RED test WP-7: matching update resolves with the updated row (no throw).
- [x] 1.7 RED test D6a: zero-row `where` × all-undefined `data` — `EMPTY_UPDATE_DATA` wins, no SQL issued.
- [x] 1.8 RED test D6b: multi-row `where` × scalar-only `data` — still updates many, returns `rows[0]`, no `RECORD_NOT_FOUND`/`AMBIGUOUS_UPDATE_TARGET`.
- [x] 1.9 Confirm all 1.1-1.8 tests fail (RED) before touching `delegate.ts`.

### Phase 2: GREEN — delegate.ts guards

- [x] 2.1 Add `IndigoNotFoundError` class (`code: "RECORD_NOT_FOUND"`) to `packages/client/src/delegate.ts`; export it from `packages/client/src/index.ts`.
- [x] 2.2 Add empty-`SET` guard at the top of `rawUpdate` (delegate.ts:1229-1240): throw `IndigoArgumentError("EMPTY_UPDATE_DATA")` pre-SQL when no assignments.
- [x] 2.3 Throw `IndigoNotFoundError` when `rawUpdate`'s `RETURNING` yields zero rows (was: silent `undefined`).
- [x] 2.4 Throw `IndigoNotFoundError` in `updateImpl`'s relation-ops-only branch (1331-1339) when `matches[0]` is absent (WP-6/NW-4).
- [x] 2.5 Throw `IndigoNotFoundError` in `deleteImpl` (1360-1367) when `RETURNING` yields zero rows (WP-5).
- [x] 2.6 Run Phase 1 tests; confirm 1.1-1.8 now pass (GREEN).

### Phase 3: RED→GREEN — C1.4c rewrite (WP-6, NW-1..4, RT-3)

- [x] 3.1 In `packages/client/test/nested-writes-update.mjs` lines 306-319 (C1.4c): replace the `result === undefined` assertion with an expected `IndigoNotFoundError` throw; keep the existing `after[0].authorId === null` assertion so the no-partial-write guarantee is proven at its new location, not dropped.
- [x] 3.2 Confirm C1.4b (282-304) is unchanged and stays green — untyped `.mjs`, no `uniqueGroups` in `authorMeta`, still fires `AMBIGUOUS_UPDATE_TARGET` (D5, deferred verification in PR 2).
- [x] 3.3 Confirm NW-1, NW-2, NW-3 (existing connect/connectOrCreate cases) remain unchanged and green.
- [x] 3.4 `rg -c "result === undefined" packages/client/test/nested-writes-update.mjs` returns 0 (RT-3).

### Phase 4: OPS-1 (PR 1 half) + verification

- [x] 4.1 Append `write-preconditions.mjs` to the `test` chain in `packages/client/package.json`.
- [x] 4.2 Run `pnpm --filter @indigodb/client test`; confirm `write-preconditions.mjs` name appears in console output (not just present on disk).
- [x] 4.3 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root; confirm green.
- [x] 4.4 Commit PR 1 as a standalone, independently revertable range.

### Phase 4C: Corrective batch — verify CRITICAL (disconnect/set regression)

Added after `sdd-verify` FAILed PR 1 with 1 CRITICAL. The empty-`SET`/not-found guard made
`rawUpdate` throw, and `applyNonFkSideOp`'s disconnect/set handling consumed the old silent
`undefined` as a sentinel at three sites the first apply pass missed — turning a legitimate
idempotent no-op into a hard throw. Same failure class this PR exists to fix, reintroduced.

- [x] 4C.1 Add `disconnectByUpdate` helper wrapping `target.update(... = null)`; swallow **only** `IndigoNotFoundError`, rethrow everything else.
- [x] 4C.2 Route all three sites through it: the per-item `disconnect` loop, the `set` clear, and the to-one `disconnect: true` / `set: null` branch.
- [x] 4C.3 RED: `C1.1c` — `set: []` on an author with ZERO currently-linked books is a no-op. Fixture seeds an **empty** relation; C1.3a's seeded fixture is exactly what hid this.
- [x] 4C.4 RED: `C1.1d` — `disconnect` naming a book id that does not exist at all is a no-op.
- [x] 4C.5 RED: `C1.2d` — `disconnect: true` on an optional to-one non-fkSide relation with nothing linked is a no-op. Needed a new `Profile` model: `Author.books` is `list: true` and `Book.author`/`.publisher` are `fkSide: true`, so no existing fixture reaches the single-value branch.
- [x] 4C.6 GREEN: all three pass; `pnpm --filter @indigodb/client test` exit 0.
- [x] 4C.7 Sweep every internal consumer of an `update`/`delete` result in `packages/client/src`. Result: only two `await target.update(...)` sites remain (`delegate.ts:1090` connect, `:1108` disconnect), both wrapped. `:1334` and `:1404` are the public path where throwing is correct; `client.ts:243` is `Map.delete`, unrelated. No unguarded internal consumer left.
- [x] 4C.8 Mutation proof: made `disconnectByUpdate` rethrow unconditionally, rebuilt — C1.1c, C1.1d and C1.2d all FAILed with `IndigoNotFoundError` on `Book`/`Book`/`Profile` respectively. Restored byte-identically (`cmp` clean), rebuilt, reconfirmed green.
- [x] 4C.9 Re-run the root gate `pnpm clean && pnpm build --force && pnpm lint && pnpm test`.

## PR 2 — Unique selector (stacks on PR 1)

### Phase 5: Rename inventory (mechanical, no behavior change)

- [x] 5.1 `packages/generator/src/client.ts`: rename all 10 occurrences (`generateUpsertWhereInput` → `generateWhereUniqueInput`, `<Model>UpsertWhereInput` → `<Model>WhereUniqueInput`, 3× `generics` templates); `uniqueGroups` derivation logic untouched.
- [x] 5.2 `packages/generator/test/transaction-emission.mjs`: rename 6 literals.
- [x] 5.3 `packages/generator/test/live-emit.mjs`: rename 1 literal.
- [x] 5.4 `packages/generator/test/where-emission.mjs`: rename 2 literals.
- [x] 5.5 `packages/client/test/fixtures/typecheck-fixture.ts`: rename 5 literals (lines 178, 182, 193, 418, 439).
- [x] 5.6 `packages/client/src/delegate.ts`: rename 2 occurrences (doc comment 406-418, resolver reference ~1701).
- [x] 5.7 `packages/client/src/types.ts`: rename 1 occurrence (`UniqueWhere` doc, 318-333).
- [x] 5.8 OPS-2: run `rg -c UpsertWhereInput` repo-wide (excluding `openspec/changes/archive/**` and this change's own docs); confirm 0.

### Phase 6: RED — unique-write-selector.mjs (UWS-3..7, D4, D5, D6c, D6d)

- [x] 6.1 Create `packages/client/test/unique-write-selector.mjs`; RED test UWS-5: `as any` bypass with non-unique `where` throws `IndigoArgumentError` code `NO_MATCHING_UNIQUE_CONSTRAINT`, `calls.length === 0`; sub-cases: operator-object `where`, partial composite key.
- [x] 6.2 RED test UWS-6: `as any` bypass with a valid unique `where` proceeds and returns the row (guard does not over-reject).
- [x] 6.3 RED test UWS-7 with D7 harness: hand-authored meta declares `uniqueGroups: [["name"]]`; PGlite DDL creates no unique constraint on `name`; insert two rows sharing `name: "Dup"`. State the rationale inline (declared-but-unenforced constraint = schema-drift scenario) so it isn't misread as a fixture bug. Assert `assertUniqueWhere` passes, then `IndigoNestedWriteError` code `AMBIGUOUS_UPDATE_TARGET` fires; no `connect` happened.
- [x] 6.4 RED test UWS-3 (runtime half): `findUnique({ where: { name: "A" } })` still resolves `Payload | null` (non-regression).
- [x] 6.5 RED test UWS-4 (runtime half): `updateMany`/`deleteMany` with a multi-row `where` still update/delete every match.
- [x] 6.6 RED test D4: delegate whose meta declares no `uniqueGroups` issues SQL unguarded (`update({ where: { name: "x" } })`) — guard is opt-in.
- [x] 6.7 RED test D6c: unique `where` × zero rows — passes the guard, then throws PR 1's `RECORD_NOT_FOUND`.
- [x] 6.8 RED test D6d: unique `where` × all-undefined `data` — `EMPTY_UPDATE_DATA` still reached through the new signature.
- [x] 6.9 Confirm nested-writes-update.mjs C1.4b (D5) still throws `AMBIGUOUS_UPDATE_TARGET` unchanged — guard did not shadow it.
- [x] 6.10 Confirm all 6.1-6.8 tests fail (RED) before implementing `assertUniqueWhere`.

### Phase 7: GREEN — assertUniqueWhere + type narrowing

- [x] 7.1 Implement `assertUniqueWhere(where, op)` in `delegate.ts` as a separate sibling function to `resolveUpsertConflictTarget` (not a reuse) — applies only when `meta.uniqueGroups` is present and non-empty (D4); exact key-set equality check.
- [x] 7.2 Wire `assertUniqueWhere` first in `updateImpl`/`deleteImpl`, before `splitData`/`findMany` (D5); precedence: `NO_MATCHING_UNIQUE_CONSTRAINT` → `EMPTY_UPDATE_DATA` → `AMBIGUOUS_UPDATE_TARGET` → `RECORD_NOT_FOUND` (D6).
- [x] 7.3 Change `update`/`delete` signatures in `delegate.ts` to accept the 9th generic `UniqueWhere` instead of `WhereInput<Row>`.
- [x] 7.4 Update `UpdateArgs`/`DeleteArgs` in `types.ts` (204-211) to take a `UniqueWhere` parameter.
- [x] 7.5 Run Phase 6 tests; confirm 6.1-6.8 now pass (GREEN).

### Phase 8: Compile-time cases + emission assertions (UWS-1,2,8,9, QTS-1..3, UPS-1..3)

- [x] 8.1 Add UWS-1 positive control to `typecheck-fixture.ts`: `db.user.update({ where: { email: "a@x.com" }, data: … })` compiles with no cast, no `@ts-expect-error`.
- [x] 8.2 Add UWS-2: `@ts-expect-error` on `db.user.update({ where: { name: "A" }, … })` and matching `@ts-expect-error` on `db.user.delete({ where: { name: "A" } })`.
- [x] 8.3 Add UWS-3 compile-time half: `db.user.findUnique({ where: { name: "A" } })` compiles with no cast.
- [x] 8.4 Add UWS-4 compile-time half: `updateMany`/`deleteMany` compile against full `WhereInput<Row>` with a non-unique `where`.
- [x] 8.5 Add UWS-8: emitted `LogWhereUniqueInput = never` (no-unique-group model) in `where-emission.mjs`; `@ts-expect-error` on `db.log.update(...)` and `db.log.delete(...)` in the fixture.
- [x] 8.6 Add UWS-9: `db.log.updateMany(...)`/`db.log.deleteMany(...)` compile with no cast, no `@ts-expect-error`.
- [x] 8.7 QTS-1: confirm existing per-model arg-interface emission assertions in `{where,transaction,live}-emission.mjs` stay green after rename.
- [x] 8.8 QTS-2: confirm every pre-existing fixture call site not deliberately edited still compiles; `@ts-expect-error` count grows only by UWS-2/8 markers.
- [x] 8.9 QTS-3: assert emitted `UserUpdateArgs`/`UserDeleteArgs` reference `UserWhereUniqueInput`, not `UserWhereInput`, in `where-emission.mjs` and the fixture.
- [x] 8.10 UPS-1: confirm existing `upsert` `NO_MATCHING_UNIQUE_CONSTRAINT` case in `upsert.mjs` stays green after rename.
- [x] 8.11 UPS-2: confirm existing `upsert` `@ts-expect-error` case, retargeted to the renamed type, still errors.
- [x] 8.12 UPS-3: assert exactly one `WhereUniqueInput` type is emitted per model and `upsert`/`update`/`delete` all reference it, in `transaction-emission.mjs`.

### Phase 9: OPS-1 (PR 2 half) + verification

- [x] 9.1 Append `unique-write-selector.mjs` to the `test` chain in `packages/client/package.json`.
- [x] 9.2 Run `pnpm --filter @indigodb/client test`; confirm both `write-preconditions.mjs` and `unique-write-selector.mjs` names appear in console output.
- [x] 9.3 Run `pnpm --filter @indigodb/generator test`; confirm rename-affected emission suites pass.
- [x] 9.4 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root (mandatory for this cross-package type change); confirm green.
- [x] 9.5 Re-run OPS-2 (`rg -c UpsertWhereInput` repo-wide, excluding archive/docs) — confirm 0.
- [x] 9.6 Commit PR 2 stacked on PR 1.

## Non-goals (do not touch)

`findUnique`'s selector, `updateMany`/`deleteMany`'s broad `where`, re-homing `AMBIGUOUS_UPDATE_TARGET` to a different error class, unrelated `delegate.ts` cleanup.
