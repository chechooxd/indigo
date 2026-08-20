# Verification Report: client-transaction-array-form

**Change**: client-transaction-array-form (3 commits on main: 88f5930 slice1, 35eef8a slice2, 751b116 slice3)
**Mode**: full artifact set (proposal, spec x2 domains, design, tasks) — verified against real committed source, not narrative.
**Verdict**: PASS

## Task completeness
All executable tasks (1.1-1.7, 2.1-2.6, 3.1-3.8) checked [x] in tasks.md. Task 3.9 [COMMIT] and the 2 "Post-slice-3 cleanup" items (archive-time housekeeping, explicitly out of any slice budget) remain unchecked — WARNING, cosmetic only: commit 751b116 verifiably exists on main and matches 3.9's exact description; the spec's stale "out of scope" sentence (client-transactions/spec.md:20) is still present, correctly deferred to sdd-archive per tasks.md's own plan.

## Build/Test evidence (fresh, this session)
- `pnpm --filter @indigodb/client build` — clean, exit 0.
- `pnpm --filter @indigodb/client test` — 205 `ok` lines, 0 `not ok`, exit 0. Matches apply-progress's claimed 205/205.
- `pnpm --filter @indigodb/generator test` — all green incl. transaction-emission.mjs golden assertions for the new `{tx,byModel}` shape and both `$transaction` overloads.
- `pnpm build` (root) — 10/10 packages green (confirms downstream Studio/CLI compile against changed return types).
- `pnpm lint` (root) — 18/18 green.
- `pnpm test` (root) — fails only on the pre-existing `13-ambiguous-relations.indigo` ValidationError-ordering flake in `@indigodb/compiler`, which aborts Turbo's run and shows ELIFECYCLE on other packages (client/generator already independently verified green above — Turbo abort-on-failure, not a real regression). `git diff --stat 88f5930^..751b116 -- crates/ packages/compiler/` is empty — compiler untouched by any of the 3 commits, confirming the flake is unrelated.

## Source-level spec compliance

1. **promise.ts** — `IndigoPromise<T,D> implements Promise<T>` (structural, not `extends`), `then`/`catch`/`finally`/`[Symbol.toStringTag]` present, `BRAND = Symbol.for("indigodb.deferred")`, `isIndigoPromise` brand check, `defer()` factory, `runDeferred()` sequential engine with empty-array short-circuit before any lookup, `IndigoTransactionError` with exactly the 5 codes (`OPERATION_REUSED`, `NOT_A_DEFERRED_OPERATION`, `MODEL_NOT_IN_REGISTRY`, `EMPTY_TRANSACTION`, `ARRAY_FORM_REQUIRES_GENERATED_CLIENT`). CONFIRMED by direct read.

2. **delegate.ts** — all 13 public methods return `defer(...)`, verified via grep across the full file. The 4 newly-extracted methods (findFirstImpl, findUniqueImpl, deleteImpl, countImpl) were checked via `git diff 88f5930 35eef8a -- delegate.ts`: the diff shows each old inline body relocated verbatim into a private `*Impl` method with zero logic changes — CONFIRMED FROM DIFF, not merely trusted from apply-progress narrative. Combined with 205/205 unchanged test suite passing at slice 2's gate, this is doubly proven.

3. **client.ts** — `IndigoClientBase.$transaction` has `if (Array.isArray(fn))` throwing `IndigoTransactionError("ARRAY_FORM_REQUIRES_GENERATED_CLIENT")` positioned before `this.$withSession(fn)` is ever called — confirmed no session/BEGIN work precedes the throw.

4. **generator/src/client.ts** — `__delegates` returns `{ tx, byModel }`. `$transaction` overloads: callback form + `<const Ops extends readonly IndigoPromise<unknown>[]>(ops: Ops): Promise<DeferredResults<Ops>>`. Array branch: a `for` loop validates `isIndigoPromise(op)` for every element (throwing `NOT_A_DEFERRED_OPERATION` otherwise), THEN checks empty-array (short-circuits to `Promise.resolve([])`), and only then calls `this.$withSession(...)` wrapping `runDeferred`. Pre-validation loop confirmed positioned before `$withSession`/BEGIN.

5. **defer() D-erasure deviation** — confirmed type-only: `defer<T,D>` constructs `new IndigoPromise<T,D>(...)` but declares return type `IndigoPromise<T>` via `as unknown as IndigoPromise<T>` cast. No runtime branch added/removed; necessary because `run: (delegate:D)=>Promise<T>` is contravariant in D, otherwise blocking every real delegate call site from satisfying the array-form generic constraint. Root build/lint green independently proves no downstream breakage.

6. **Atomicity/rollback** — `transactions.mjs` asserts exactly one BEGIN/COMMIT for two ops, and exactly one ROLLBACK + absent first-op row on second-op failure. `transactions-pg.mjs` real-Postgres test uses `pool: { max: 1 }`, proves rollback then re-uses the same 1-connection pool for a second transaction to prove connection release (a leak would deadlock under the test's timeout wrapper) — CONFIRMED exactly as claimed.

7. **Typecheck fixture** — confirmed standalone `Promise<T>` assignability + `Promise.all` composition, tuple-typed `DeferredResults` via `arrayTransaction([...])` returning `[User, Post]`, and `@ts-expect-error` on `baseClient.$transaction([...])` proving no array overload on the base client.

8. Commands re-run fresh this session (not reused from apply-progress).

9. tasks.md: ~24 executable tasks across 3 slices, all checked except 3.9 (cosmetic, commit demonstrably exists) and the explicitly-deferred archive-time cleanup pair.

## Design coherence
All 7 numbered design decisions traced to source and confirmed: structural Promise implementation, single-field memo/reuse detector, Symbol.for brand, byModel surfaced from __delegates, compile-time+runtime base-client boundary, withQueryContext moved inside the thunk, nested-write identity-default session reuse (proven by the "no inner transaction" test).

## Issues
- **WARNING**: tasks.md checkbox 3.9 and the 2 post-slice-3 cleanup items remain unchecked on the filesystem, though the underlying work (commit 751b116) is real and verifiable. Recommend sdd-archive complete: (a) check off 3.9, (b) remove the stale "out of scope" sentence from `openspec/specs/client-transactions/spec.md` line 20 (currently still present), (c) add the `instanceof Promise === false` release note.
- No CRITICAL issues found.
- No SUGGESTION-level issues beyond the above archive housekeeping.

## Final Verdict: **PASS**
Implementation genuinely matches proposal, both spec domains (client-deferred-queries, client-transactions), design, and tasks. All runtime test evidence is fresh and green; the one root-level test failure is a pre-existing, unrelated, out-of-scope compiler fixture-ordering flake, proven unrelated via an empty diff on compiler/crates paths across all 3 commits. Ready for sdd-archive, which owns the deferred spec-purpose-sentence cleanup and release-note item.
