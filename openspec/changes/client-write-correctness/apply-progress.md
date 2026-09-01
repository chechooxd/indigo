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

### Remaining tasks (PR 2 — not started, per scope)

- [ ] Phase 5-9 (rename `UpsertWhereInput` → `WhereUniqueInput`, `assertUniqueWhere`,
      `UpdateArgs`/`DeleteArgs` signature change, compile-time cases, OPS-2) — explicitly
      out of scope for this apply batch.

### Status

24/24 PR 1 tasks complete (Phases 1-4). Ready for `sdd-verify` on PR 1's scope, or a fresh
`sdd-apply` batch for PR 2 (stacked on this branch per `stacked-to-main`).
