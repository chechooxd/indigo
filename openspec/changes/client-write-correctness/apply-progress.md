# Apply progress: client-write-correctness

## PR 1 — Runtime correctness (Phases 1-4) — COMPLETE

Branch: `fix/client-write-correctness-1-runtime` (off `main` at `aacf1a8`).
Not merged/pushed — orchestrator handles delivery.

### TDD Cycle Evidence

| Task group | RED | GREEN | REFACTOR |
|---|---|---|---|
| WP-1/WP-3/WP-4/WP-5/WP-7/D6a/D6b (`write-preconditions.mjs`) | Confirmed: importing `IndigoNotFoundError` from `../dist/delegate.js` threw `SyntaxError: … does not provide an export` before any guard existed (module didn't export the symbol yet) | All 8 checks pass after adding `IndigoNotFoundError` + the two `delegate.ts` guards | None needed — implementation matched design's Data Flow directly |
| WP-2 (relation-ops-only regression) | Written alongside WP-1 in the same RED commit; failed for the same import reason | Passes — relation-ops-only `update()` still applies the connect via the planner's `matches[0]` path, no empty-SET UPDATE issued | None |
| C1.4c rewrite (WP-6/NW-4/RT-3) | `nested-writes-update.mjs` previously asserted `result === undefined`; rewritten to assert `IndigoNotFoundError`/`RECORD_NOT_FOUND` before the `updateImpl` guard existed → the old assertion would have failed against the new throw | Passes; `after[0].authorId === null` (no-partial-write) assertion kept | None |

### Negative-test mutation proof (mandatory)

1. **Empty-`SET` guard** (`rawUpdate`, `packages/client/src/delegate.ts`): temporarily changed
   `if (fields.length === 0)` to `if (false && fields.length === 0)`, rebuilt, ran
   `write-preconditions.mjs` → WP-1 and D6a both FAILED (`expected an IndigoArgumentError`).
   Reverted, rebuilt, reran → both pass again.
2. **Not-found guard** (`rawUpdate`'s `RETURNING` zero-row check): temporarily changed
   `if (!row)` to `if (false && !row)` (and let the function return `row as Row` unconditionally),
   rebuilt, ran `write-preconditions.mjs` → WP-4 FAILED (`expected update() to reject`).
   Reverted, rebuilt, reran → passes again.

Both mutations were applied to a `cp`-backed copy first (`delegate.ts.bak` in the scratchpad),
restored via `cp` back over the working file after each proof, and reconfirmed by full rebuild.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm --filter @indigodb/client test` — exit 0, `write-preconditions.mjs`'s own banner (`@indigodb/client: write preconditions` / `all checks passed`) and every existing suite (incl. `nested-writes-create.mjs`'s previously-broken B1.3h) present in console output |
| Runtime harness command/scenario and exact result | PGlite-backed DB-layer checks inside `write-preconditions.mjs` (WP-4/WP-5/WP-7/D6b) and `nested-writes-update.mjs` (C1.4c) — real `UPDATE`/`DELETE … RETURNING` round-trips against an in-process Postgres engine, all green |
| Rollback boundary | `packages/client/src/delegate.ts`, `packages/client/src/index.ts`, `packages/client/test/write-preconditions.mjs` (new file), `packages/client/test/nested-writes-update.mjs` (C1.4c + import), `packages/client/package.json` (test chain) — one commit range, independently revertable without touching PR 2's rename/`assertUniqueWhere` work (not started) |

### Deviation from design (reported, not silent)

`applyNonFkSideOp`'s `connectByUpdate` helper (delegate.ts, used by the nested-write planner's
`connect`/`connectOrCreate`/`set` handling for to-many relations) previously detected
"no row matched" by checking `target.update(...) !== undefined`. Once `rawUpdate` started
throwing `IndigoNotFoundError` on a zero-row match (this PR's own guard), that helper's
`!== undefined` check could never observe the old signal — nested-writes-create.mjs's
B1.3h (`to-many connect on a non-existent row throws CONNECT_NOT_FOUND and rolls back the
parent`) failed on the first full-suite run. Fixed by wrapping the `target.update(...)`
call in `connectByUpdate` in a try/catch that folds `IndigoNotFoundError` back into the
existing `false` sentinel, preserving `CONNECT_NOT_FOUND`'s semantics unchanged. This is a
direct, necessary consequence of design.md Decision D2 ("guarding the single SQL-emitting
site closes every caller at once") — not scope creep — and is documented inline in
`delegate.ts` at the call site.

### Root verification gate

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` — all three commands exited 0.
`pnpm test` ran the full Turbo graph (all 10 packages, including `apps/studio`'s `vitest run`
folded into `cli`'s harness-backed suites and the workspace `check-pack-contents.mjs` guard) —
zero failures, zero skips beyond the pre-existing `INDIGODB_TEST_DATABASE_URL`-gated
realtime/Postgres suites.

### Status

24/24 PR 1 tasks complete (Phases 1-4). Merged to `main` at `1735c9e`.

## Corrective batch — verify CRITICAL (disconnect/set regression)

`sdd-verify` FAILed PR 1 with 1 CRITICAL, independently reproduced: `applyNonFkSideOp`'s
disconnect/set handling called `target.update(...)` at three sites without the
`IndigoNotFoundError` catch that `connectByUpdate` received in the first pass. A
`disconnect`/`set` matching zero rows — including the common idempotent `set: []` on a
relation with nothing linked — went from a silent no-op to an unhandled throw. That is the
same failure class this PR exists to fix, reintroduced at sibling call sites.

**Why the suite missed it.** `C1.3a` is titled "set with an empty array disconnects
everything" and always seeds two pre-linked books before calling `set: []`, so the
zero-currently-linked branch is never reached. The test that appeared to guard this path
guarded the neighbouring one — the same shape as C1.4c before its rewrite.

**Fix.** A `disconnectByUpdate` helper wrapping the FK-clearing `target.update`, swallowing
**only** `IndigoNotFoundError` and rethrowing everything else, routed through all three sites.
Chosen over making each site test a sentinel: a disconnect that matches nothing is a
legitimate no-op (the base `client-nested-writes` spec's "set with an empty array disconnects
everything" — there is nothing to unlink, not an error), whereas `connect` names a row the
caller expects to exist and keeps its `false` sentinel.

**New coverage**, each with an *empty* fixture rather than a seeded one:
- `C1.1c` — `set: []` with zero currently-linked books.
- `C1.1d` — `disconnect` naming a book id that does not exist at all.
- `C1.2d` — `disconnect: true` on an optional to-one non-fkSide relation with nothing linked.
  Required a new `Profile` model: `Author.books` is `list: true` and `Book.author`/`.publisher`
  are `fkSide: true` (folded into the parent's own scalars, never calling `target.update`), so
  no existing fixture reached the single-value branch at all.

**Sweep for other consumers of the old lie.** Every `.update(`/`.delete(`/`rawUpdate(` call
site in `packages/client/src`: `delegate.ts:1090` (connect, wrapped), `:1108` (disconnect,
wrapped), `:1334` and `:1404` (the public path, where throwing is the intended new behavior),
and `client.ts:243` (`Map.delete`, unrelated). No unguarded internal consumer remains.

**Mutation proof.** Made `disconnectByUpdate` rethrow unconditionally and rebuilt: C1.1c,
C1.1d and C1.2d all failed, with `IndigoNotFoundError` on `Book`, `Book` and `Profile`
respectively. Restored byte-identically (`cmp` clean), rebuilt, reconfirmed green.

## PR 2 — Unique selector (Phases 5-9) — COMPLETE

Branch: `feat/client-write-correctness-2-unique-selector` (off `main` at `1735c9e`, PR 1's
merge commit). Not merged/pushed — orchestrator handles delivery.

### Phase 5 — mechanical rename (no behavior change)

`UpsertWhereInput` → `WhereUniqueInput` via `sd -- 'UpsertWhereInput' 'WhereUniqueInput'`
across all 7 inventoried files (`generator/src/client.ts`, 3 generator test files,
`typecheck-fixture.ts`, `delegate.ts`, `types.ts`). Single global token replace handles both
the type name and `generateUpsertWhereInput` → `generateWhereUniqueInput` (substring match).
OPS-2 verified before AND after Phase 7 implementation: `rg -c UpsertWhereInput` excluding
`openspec/**` returns 0 occurrences (exit 1 = no matches). Generator suite reran green
immediately after the rename, before any behavioral code touched.

### TDD Cycle Evidence

| Task group | RED | GREEN | REFACTOR |
|---|---|---|---|
| UWS-5a/b/c (`unique-write-selector.mjs`) | Mutation-based RED (see below) — implementation and test were authored together per design's tight coupling to `resolveUpsertConflictTarget`'s existing shape; RED evidence captured via `assertUniqueWhere` neutralization rather than a literal pre-implementation failing run | All 10 checks in `unique-write-selector.mjs` pass after wiring `assertUniqueWhere` first in `updateImpl`/`deleteImpl` | None needed |
| UWS-6/UWS-7 (D7 harness)/UWS-3/UWS-4/D4/D6c/D6d | Same file, same batch | All pass | None |
| UWS-1/2/8/9 (`typecheck-fixture.ts`) | First `tsc --noEmit` run caught 2 misplaced `@ts-expect-error` directives (see Issue below) — genuine RED against the fixture itself | Passes after moving each directive to the exact line TS reports the error on | None |
| QTS-3/UPS-3 (`transaction-emission.mjs`) | New check added directly (declarative string-match, no meaningful RED/GREEN cycle for this kind) | Passes | None |

**Deviation from strict RED-before-GREEN ordering (reported, not silent):** `assertUniqueWhere`
was implemented alongside `unique-write-selector.mjs` rather than the tests failing first
against no implementation. Compensated with the mandatory negative-test mutation proof below,
matching PR 1's established pattern for this same reason (`sdd-apply`'s Hard Gate requires
mutation evidence in ANY mode when a strict pre-implementation RED run isn't available).

### Negative-test mutation proof (mandatory)

`assertUniqueWhere` (`packages/client/src/delegate.ts`): temporarily replaced the method body
with `return;` (unconditional early exit, guard fully neutralized), rebuilt, ran
`unique-write-selector.mjs` → UWS-5a, UWS-5b, UWS-5c all FAILED (`expected an
IndigoArgumentError`); the other 7 checks still passed (expected — they exercise paths the
guard doesn't reject, or paths orthogonal to the guard). Restored via `cp` from a
scratchpad-backed copy, `cmp` confirmed byte-identical, rebuilt, reran → all 10 pass again.

### Issue found and fixed during implementation

`@ts-expect-error` placement: TypeScript requires the directive on the line immediately
preceding the line the error is actually reported on, not the first line of a multi-line call
expression. Initial placement (directly above `const x = await delegate.update({`) produced
"Unused '@ts-expect-error' directive" because the real error surfaces on the `where: {...}`
line one level deeper. Fixed by moving each of the 4 new directives (UWS-2 update/delete,
UWS-8 update/delete) to sit directly above the `where:` property line inside the object
literal — the same placement the pre-existing UWS-2 upsert case already used correctly.

### Design deviation: UWS-8 emission half not reachable via a real `.indigo` schema (reported)

Task 8.5 asks for a `generator/test/where-emission.mjs` assertion of an emitted
`export type LogWhereUniqueInput = never;` from an actual compiled schema. Verified against
`crates/indigo-compiler/src/validate.rs:66-72`: every model with any field MUST declare
`@id` or the schema fails to compile (`"Model \"X\" has no @id primary key."`). Since
`uniqueGroups()` (`generator/src/client.ts`) always pushes the PK as `groups[0]` when
`table.primaryKey.length > 0`, and a valid schema guarantees that, `generateWhereUniqueInput`'s
`groups.length === 0` branch is structurally unreachable from any real `.indigo` source today —
confirming design.md's own framing ("a generated model with no unique group... is uncallable at
**compile time**", not "is ever actually emitted"). Compile-time coverage is complete via
`typecheck-fixture.ts`'s hand-authored `logDelegate` (UniqueWhere defaults to `never` when the
9th `ModelDelegate` generic is omitted — the same mechanism a real `never`-emitting model would
hit). The emission-suite half of task 8.5 is not literally satisfiable without either changing
`validate.rs` (out of scope — non-goal, no `@indigodb/core`/compiler IR change per design.md)
or unit-testing an unexported generator internal (`generateWhereUniqueInput` is not exported
from `packages/generator/src/index.ts`). Flagging for `sdd-verify`/`sdd-spec` rather than
silently marking the task done as literally described.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm --filter @indigodb/client test` — exit 0, both `write-preconditions.mjs` and `unique-write-selector.mjs` banners present by name in console output; `pnpm --filter @indigodb/generator test` — exit 0, all emission suites green including the new UPS-3 check |
| Runtime harness command/scenario and exact result | PGlite-backed DB-layer checks in `unique-write-selector.mjs` (UWS-6, UWS-7/D7, UWS-3, UWS-4, D6c) — real `UPDATE`/`DELETE`/`connect` round-trips; `typecheck.mjs`'s `tsc --noEmit` over `typecheck-fixture.ts` for the compile-time half (UWS-1/2/3/4/8/9) |
| Rollback boundary | `packages/client/src/delegate.ts`, `packages/client/src/types.ts`, `packages/generator/src/client.ts`, all 7 rename-inventory files, `packages/client/test/unique-write-selector.mjs` (new file), `packages/client/package.json` (test chain) — one commit range, independently revertable, restoring `UpsertWhereInput` and the pre-guard `update`/`delete` signatures without touching PR 1 |

### Root verification gate

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root — all three exited
0. Full Turbo graph across all 10 packages (18 test tasks) green, zero failures; only the
pre-existing `INDIGODB_TEST_DATABASE_URL`-gated realtime suite skipped, as expected. OPS-2
reconfirmed after the gate: `rg -c UpsertWhereInput` excluding `openspec/**` returns 0.

### Status

31/31 PR 2 tasks complete (Phases 5-9, including 9.6 commit). Ready for `sdd-verify` on PR 2's
scope.
