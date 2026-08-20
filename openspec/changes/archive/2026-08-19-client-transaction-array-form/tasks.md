# Tasks: `$transaction([...])` array form (client-transaction-array-form)

## Review workload forecast

Design total is ~1000 authored lines (~1000 added, ~70 removed across the chain), which
exceeds the 800-line review budget in one shot. Per design's confirmed 3-slice split
(refined by moving `runDeferred` into slice 1), no single slice exceeds 400 authored
changed lines. Each slice is a direct commit to `main` (auto-chain delivery), landed
strictly in order — slice N assumes slice N-1 is already on `main`.

| Slice | Contents | Added | Removed | Verification gate |
|---|---|---|---|---|
| 1 — contract | `promise.ts`, `types.ts`, `index.ts`, `test/deferred.mjs` | ~365 | ~0 | New unit suite green; purely additive, no existing file behavior touched |
| 2 — delegate rewrap | 4 `*Impl` extractions + 13 delegate methods rewritten to `defer(...)` | ~155 | ~55 | Existing PGlite recording-executor suite green **unchanged**, byte-identical SQL for all 13 methods |
| 3 — wiring + tests | `client.ts` guard, `generator/src/client.ts` bundle/overloads, `transactions.mjs`, `transactions-pg.mjs`, `typecheck-fixture.ts` | ~335 | ~15 | New integration + typecheck assertions green; full `pnpm test` green |
| **Total** | | **~855** | **~70** | 3 sequential commits, none exceeding 400 lines |

Chain: slice 1 -> tracker; slice 2 -> slice 1 (must already be on `main`); slice 3 -> slice 2
(must already be on `main`). Per-slice revert restores byte-identical eager Promises (per
design Rollout).

---

## Slice 1 — Contract (`promise.ts` + `types.ts` + `index.ts` + unit tests)

Scope: `packages/client/src/promise.ts` (new), `packages/client/src/types.ts` (MOD),
`packages/client/src/index.ts` (MOD), `packages/client/test/deferred.mjs` (new).
Purely additive — no existing runtime file (`delegate.ts`, `client.ts`) is touched in this
slice, so it ships green standalone with zero behavior change to anything already on `main`.

Satisfies (spec): `client-deferred-queries` — "IndigoPromise extends Promise for type
compatibility" (structural, per design decision 1), "Execution is deferred until awaited or
transacted", "Standalone await executes immediately, identical to today" (contract only;
delegate wiring lands in slice 2), "Result is memoized and single-fire", "Rebindable by
model name, not captured SQL". Also lays groundwork for `client-transactions` — "Ops rebind
by model name against the session" (`runDeferred` engine) and "Non-IndigoPromise array
elements throw" (`NOT_A_DEFERRED_OPERATION`, `MODEL_NOT_IN_REGISTRY` guards).

Parallelizable: tasks 1.1-1.4 (contract types/classes) can be written together since they
land in one file; RED tests (1.5) must exist and fail before GREEN implementation (1.1-1.4)
is considered complete, per strict TDD. Sequential: 1.6 (index.ts exports) depends on 1.1-1.4
existing; 1.7 (verify) depends on all above.

- [x] **1.1 [RED]** Write `packages/client/test/deferred.mjs` covering, per design's exact
      test list for slice 1:
      - zero-exec-on-construct: constructing a deferred op issues no SQL/no executor call
      - memoization-single-execution: awaiting the same `IndigoPromise` twice executes the
        underlying `run` exactly once, both awaits resolve to the same value
      - `OPERATION_REUSED` across two `$transaction`-style claims (call `__claim` twice)
      - `OPERATION_REUSED` for the same op referenced twice inside one array (two `__claim`
        calls before either settles)
      - `NOT_A_DEFERRED_OPERATION` for a plain `Promise`/plain value passed where an
        `IndigoPromise` is expected (via `runDeferred`/guard helpers)
      - `MODEL_NOT_IN_REGISTRY` when `op.model` has no entry in the `byModel` registry passed
        to `runDeferred`
      - empty-array-no-BEGIN: `runDeferred([], byModel)` resolves to `[]` without invoking
        any session/transaction hook
      - base-client-throws-`ARRAY_FORM_REQUIRES_GENERATED_CLIENT`-before-BEGIN: exercised via
        a stub base-client-shaped `$transaction` guard (full wiring lands in slice 3; here
        assert the `IndigoTransactionError` code/message contract exists and is thrown by a
        minimal `Array.isArray` check using the slice-1 error class)
      - `withQueryContext`-fires-at-execution-not-construction: constructing the op does not
        enter the query-context wrapper; awaiting it does (assert via a spy `run` capturing
        call order relative to a context marker)
      All assertions run against not-yet-existing exports — this file MUST fail (module not
      found / undefined) at this point. Confirm RED by running
      `node packages/client/test/deferred.mjs` and observing failure.

- [x] **1.2 [GREEN]** Create `packages/client/src/promise.ts`:
      - `TransactionErrorCode` union: `OPERATION_REUSED | NOT_A_DEFERRED_OPERATION |
        MODEL_NOT_IN_REGISTRY | EMPTY_TRANSACTION | ARRAY_FORM_REQUIRES_GENERATED_CLIENT`
      - `class IndigoTransactionError extends Error` with `code: TransactionErrorCode`,
        matching the existing `IndigoWhereError`/`IndigoArgumentError` style in the package
      - `Symbol.for("indigodb.deferred")` BRAND constant (per design decision 3 — brand, not
        `instanceof`, to survive duplicated `@indigodb/client` copies in `node_modules`)
      - `class IndigoPromise<T> implements Promise<T>` (structural, NOT `extends Promise`,
        per design decision 1) with `[BRAND]`, `[Symbol.toStringTag]`, readonly `model`,
        readonly `operation`, private `self`, private `run`, private `promise: Promise<T> |
        null` (single field doubling as memo + reuse detector, per design decision 2)
      - `__claim(delegate)`: throws `IndigoTransactionError("OPERATION_REUSED")` if
        `this.promise` is already set; otherwise sets it **synchronously** to
        `this.run(delegate)` before returning, so duplicate-in-array and cross-transaction
        reuse are both caught pre-execution
      - private `settle()`: returns `this.promise` if set (memoized), else executes against
        `this.self` and stores the result
      - `then`/`catch`/`finally` delegate to `settle()`
      - `isIndigoPromise(v): v is IndigoPromise<unknown>` — brand check, not `instanceof`
      - `defer<T, D>(model, operation, self, run)` — constructs an `IndigoPromise`; `D` infers
        as polymorphic `this` so `run` can call private `<op>Impl` members from inside the
        delegate class body
      - `runDeferred(ops, byModel)` — sequential array engine: validates every element is an
        `IndigoPromise` via `isIndigoPromise` (else `NOT_A_DEFERRED_OPERATION`), looks up each
        op's session delegate via `byModel[op.model]` (else `MODEL_NOT_IN_REGISTRY`), empty
        array short-circuits to `[]` before any lookup/session work (`EMPTY_TRANSACTION` is
        reserved for future use, not thrown here per spec's "Empty array is a no-op"), then
        awaits `op.__claim(delegate)` for each op in array order, collecting results into a
        tuple

- [x] **1.3 [GREEN]** Add `DeferredResults<Ops>` to `packages/client/src/types.ts`:
      `{ -readonly [K in keyof Ops]: Ops[K] extends IndigoPromise<infer T> ? T : never }` —
      reads `T` directly (not `Awaited<...>`) so a non-deferred array element is a compile
      error instead of silently widening.

- [x] **1.4 [GREEN]** Export `IndigoPromise`, `isIndigoPromise`, `defer`, `runDeferred`,
      `IndigoTransactionError`, `TransactionErrorCode`, `DeferredResults` from
      `packages/client/src/index.ts`.

- [x] **1.5 [GREEN]** Run `node packages/client/test/deferred.mjs` — confirm every RED
      assertion from 1.1 now passes.

- [x] **1.6 [VERIFY]** `pnpm build --filter=@indigodb/client && pnpm lint --filter=@indigodb/client`
      — typecheck clean, no consumers touched yet so nothing else can regress.

- [x] **1.7 [COMMIT]** Direct commit to `main`: `feat(client): add IndigoPromise deferred
      operation contract`. Confirm this slice alone stays green in isolation (no dependency on
      slices 2/3).

---

## Slice 2 — Delegate rewrap (extractions + 13 wrappers)

Scope: `packages/client/src/delegate.ts` only. Depends on slice 1 being on `main`
(`defer`/`IndigoPromise` imports). No new test file — verification is the **existing**
suite staying green, byte-for-byte, proving zero behavior change.

Satisfies (spec): `client-deferred-queries` — "Standalone await executes immediately,
identical to today" (now fully wired: awaiting a wrapped method executes `run` against `this`,
matching pre-change eager SQL), "Rebindable by model name, not captured SQL" (each method now
carries `{model, operation, self, run}` instead of executing inline).

Sequential — extractions (2.1) must land before the wrappers that call the extracted `*Impl`
methods (2.2), since `findFirst`, `findUnique`, `delete`, `count` don't yet have `*Impl` split
out. The 9 already-split methods (2.3) can be rewrapped independently of 2.1/2.2 but are
listed after for a single coherent diff. Each of 2.1-2.4 touches disjoint method bodies in the
same file, so they are logically parallelizable by method but MUST be committed together as
one slice (design's byte-identical-SQL verification gate covers the whole file at once).

- [x] **2.1 [RED->GREEN, extraction]** Extract inline bodies into private `*Impl` methods for
      the 4 methods that don't yet have one (per design's "split already 9/13 done" finding):
      `findFirstImpl`, `findUniqueImpl`, `deleteImpl`, `countImpl` — move the verbatim existing
      body (including `withQueryContext` wrapping, per design decision 6: `withQueryContext`
      moves INSIDE the thunk, wrapping execution not construction) into each `*Impl`. This step
      alone is a pure refactor with no wrapper changes yet — existing test suite MUST still
      pass unchanged at this checkpoint (run `node packages/client/test/*.mjs` covering
      delegate methods before proceeding).

- [x] **2.2 [GREEN, rewrap]** Rewrite the 4 extracted methods' public signatures to return
      `defer(this.meta.name, "<op>", this, (d) => d.<op>Impl(args))` instead of executing
      directly (pattern per design: `count(args) { return defer(this.meta.name, "count",
      this, (d) => d.countImpl(args)); }`). Repeat for `findFirst`, `findUnique`, `delete`.

- [x] **2.3 [GREEN, rewrap]** Rewrite the 9 already-split methods' public signatures the same
      way, calling their existing `*Impl` unchanged: `findMany`, `create`, `update`,
      `createMany`, `updateMany`, `deleteMany`, `aggregate`, `groupBy`, `upsert`. Per design's
      rewrap pattern note: `findMany`'s and `create`'s `*Impl` are untouched, so their own
      `this.exec`/`this.siblings()` calls (including `loadRelations` follow-ups and nested-write
      phases) automatically run against whichever delegate `run` is invoked with — no special
      casing needed for multi-statement operations.

- [x] **2.4 [VERIFY]** Run the full existing suite covering all 13 delegate methods
      (PGlite recording-executor tests) **unchanged** — confirm byte-identical SQL for every
      method vs. pre-slice-2 `main`. This is the slice's entire correctness gate: no new
      assertions are added, the existing ones must pass without modification.

- [x] **2.5 [VERIFY]** `pnpm build --filter=@indigodb/client && pnpm test --filter=@indigodb/client`
      — full package suite green, including slice 1's `deferred.mjs`. (`deferred.mjs` was not
      yet wired into the package `test` script by slice 1 — added it here so `pnpm test` covers
      it, per this gate's explicit expectation.)

- [x] **2.6 [COMMIT]** Direct commit to `main`: `refactor(client): rewrap delegate methods as
      deferred operations`. Requires slice 1 already merged to `main`.

---

## Slice 3 — Wiring + tests (feature lands)

Scope: `packages/client/src/client.ts` (MOD — guard + boundary doc), `packages/generator/src/client.ts`
(MOD — `__delegates` bundle, overloads, array branch), `packages/client/test/transactions.mjs`
(MOD), `packages/client/test/transactions-pg.mjs` (MOD), `packages/client/fixtures/typecheck-fixture.ts`
(MOD, or wherever the typecheck harness fixture lives per repo convention). Depends on slice 2
being on `main`.

Satisfies (spec): `client-transactions` — "Array form executes ops atomically in order on one
session", "Any op failure rolls back the whole array", "Ops rebind by model name against the
session", "Empty array is a no-op", "Non-IndigoPromise array elements throw" (including the
stale-client regenerate-hint scenario), "Nesting the array form inside an interactive callback
is rejected", "IndigoClientBase does not support the array form" (compile-time via base
signature not accepting an array, per design decision 5, PLUS the runtime `Array.isArray`
guard), "Unsupported executors fail explicitly" (MODIFIED — extends to array form). Also
"Client Deferred Queries" — "Existing Promise-typed call sites keep compiling" and "Multi-statement
op rebinds correctly inside a transaction" (via the typecheck fixture + `transactions.mjs`
nested-write assertion).

Sequential: 3.1 (RED tests) before 3.2-3.5 (GREEN wiring); 3.2 (`client.ts` base guard) and
3.3 (generator `__delegates` bundle) can be implemented in either order but both are needed
before 3.4 (call sites + overloads) compiles; 3.5 (real-Postgres rollback) depends on 3.4.
3.6 (typecheck fixture) is independently addable once 3.3/3.4 land (parallelizable with 3.5).

- [x] **3.1 [RED]** Write/extend tests, expected to fail against pre-slice-3 `main`:
      - `packages/client/test/transactions.mjs` — add:
        - one-BEGIN/COMMIT-array-order-one-session: `db.$transaction([opA, opB])` issues
          exactly one `BEGIN`, executes `opA` then `opB` in that order, exactly one `COMMIT`
        - rollback-op2-fails-op1-absent-one-ROLLBACK: second op throws, first op's row is
          absent afterward, exactly one `ROLLBACK` issued, no partial `COMMIT`
        - nested-write-create-inside-array-opens-no-inner-transaction: a `create` with nested
          relation writes inside the array opens exactly one `BEGIN` for the whole array (not
          one per op), proving the identity-default session delegate reuse from design point 7
        - empty array `[]` resolves with no `BEGIN` (cross-check with slice-1 unit coverage,
          now through the real generated-client call site)
        - non-`IndigoPromise` element throws before any `BEGIN` (plain value, plain `Promise`,
          and a simulated stale-client plain-`Promise`-returning delegate method all rejected
          pre-session with a regenerate hint on the stale-client case)
        - array form called from inside an active `$transaction(fn)` callback (both via `tx`
          structurally missing `$transaction`, and via outer `client` hitting the existing
          `AsyncLocalStorage` reentrancy guard) rejects with the existing nesting error
        - injected executor without a `transaction` hook rejects the array form with the same
          explicit unsupported-operation error as the callback form, none of the ops invoked
      - `packages/client/test/transactions-pg.mjs` — add: same-rollback-against-real-Postgres,
        proving the array form's rollback against a real Postgres instance (not PGlite),
        mirroring the existing callback-form real-Postgres rollback test
      - `packages/client/fixtures/typecheck-fixture.ts` (or equivalent typecheck harness
        fixture) — add: `const p: Promise<User> = db.user.findUnique(...)` assignability,
        `Promise.all([db.user.findMany(), db.post.count()])` typechecks, tuple-typed array
        result `const [u, p]: [User, Post] = await db.$transaction([db.user.create(...),
        db.post.create(...)])`, and `// @ts-expect-error` on `baseClient.$transaction([op1,
        op2])` proving `IndigoClientBase` has no array-accepting overload
      Confirm RED: run `node packages/client/test/transactions.mjs`,
      `node packages/client/test/transactions-pg.mjs` (if a local/CI Postgres is available),
      and the typecheck harness — all MUST fail against pre-slice-3 `main`.

- [x] **3.2 [GREEN]** `packages/client/src/client.ts`: add the `Array.isArray(ops)` runtime
      guard throwing `IndigoTransactionError("ARRAY_FORM_REQUIRES_GENERATED_CLIENT")` in
      `IndigoClientBase.$transaction`, before any session/`BEGIN` work (per design decision 5 —
      catches JS/`as any` callers bypassing the compile-time boundary, which otherwise would
      get an opaque "fn is not a function" error from inside `$withSession` AFTER `BEGIN`).
      Add the boundary doc comment on `IndigoClientBase` explaining the array form is
      generated-client-only and why (per spec's "IndigoClientBase does not support the array
      form").

- [x] **3.3 [GREEN]** `packages/generator/src/client.ts`: change the emitted `__delegates`
      factory to return `{ tx: TransactionClient, byModel: SiblingRegistry }` instead of just
      the `TransactionClient` (per design decision 4 — `reg`, already keyed by model name =
      `IndigoPromise.model`, was closure-private; now surfaced as `byModel` rather than
      re-deriving `delegateName()` in the runtime package or leaking `__models` onto
      user-facing `tx`). Update both existing call sites that construct `__delegates` to
      destructure the new shape.

- [x] **3.4 [GREEN]** `packages/generator/src/client.ts`: add the `$transaction` overloads on
      the generated `IndigoClient` — callback form (existing) plus
      `<const Ops extends readonly IndigoPromise<unknown>[]>(ops: Ops): Promise<DeferredResults<Ops>>`.
      Implement the array branch: empty array resolves to `[]` immediately with no session
      work; non-empty calls `runDeferred(ops, byModel)` inside the same session-acquisition
      path the callback form uses (same executor-support check, same reentrancy guard, same
      commit/rollback wiring) so both forms share one wiring path per design's core approach.

- [x] **3.5 [GREEN]** Run `node packages/client/test/transactions-pg.mjs` against a real
      Postgres instance — confirm the array-form rollback test from 3.1 now passes.

- [x] **3.6 [GREEN]** Run the typecheck harness — confirm all fixture assertions from 3.1 pass,
      including the `@ts-expect-error` on the base client.

- [x] **3.7 [VERIFY]** Run the full suite: `node packages/client/test/transactions.mjs` — all
      new and pre-existing assertions green (unchanged pre-existing ones prove no regression
      to the callback form).

- [x] **3.8 [VERIFY]** `pnpm build && pnpm lint && pnpm test` (full workspace) — confirms
      `@indigodb/generator`'s emitted output still compiles for downstream consumers (e.g.
      Studio, CLI-generated clients) and nothing outside `client`/`generator` regressed.

- [x] **3.9 [COMMIT]** Direct commit to `main`: `feat(client): support $transaction array
      form`. Requires slice 2 already merged to `main`. This lands the full feature described
      in the spec. (Commit 751b116 verifiably on main.)

---

## Post-slice-3 cleanup (not a slice — archive-time housekeeping)

- [x] Remove the now-stale sentence "The sequential array form (`$transaction([...])`) is out
      of scope for this spec." from the `client-transactions` capability's main spec Purpose
      paragraph, per the spec delta's noted purpose update.
- [x] Release-note the one observable user-visible change: `instanceof Promise === false` for
      values returned by delegate methods (per design's structural-vs-subclass decision).
