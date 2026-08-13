# Tasks: Client Query Extension Seam

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~340-420 (types.ts +25, context.ts new ~35, client.ts ~50, delegate.ts ~40, index.ts +2, extensions.mjs new ~180-220) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Full seam: types, context, client wiring, delegate context, tests | PR 1 | `node packages/client/test/extensions.mjs` | PGlite harness (`packages/client/test/`) | `git revert` — additive only, `wrapLog`/`exec` shape preserved when `extensions` absent |

Single M-effort epic per roadmap; no dependency-free sub-slices exist (context wiring needs the client-side composition helper first), so no chain split is proposed. Re-forecast if `extensions.mjs` grows beyond ~250 lines.

## Phase 1: Foundation — Types and Context

- [x] 1.1 RED: `packages/client/test/extensions.mjs` — assert `QueryExtension`/`QueryContext` types compile via a `.mjs` runtime shape check (extension is a plain function taking/returning an `Executor`).
- [x] 1.2 GREEN: Add `QueryContext` and `QueryExtension = (next: Executor) => Executor` to `packages/client/src/types.ts` next to `Executor` (line ~225).
- [x] 1.3 RED: extensions.mjs — `currentQueryContext()` returns `undefined` outside any `withQueryContext` run.
- [x] 1.4 GREEN: Create `packages/client/src/context.ts` — module-scoped `AsyncLocalStorage<QueryContext>`, internal `withQueryContext(ctx, fn)`, public `currentQueryContext()`.
- [x] 1.5 Re-export `QueryExtension`, `QueryContext`, `currentQueryContext` from `packages/client/src/index.ts`.

## Phase 2: Core Implementation — Composition and Constructor Fix

- [x] 2.1 RED: extensions.mjs — a client constructed with `extensions: [a, b]` observes `a` before `b` on call and `a` after `b` on result (order scenario from spec).
- [x] 2.2 RED: extensions.mjs — `wrapLog` logs the SQL each extension actually forwards after mutation (innermost placement).
- [x] 2.3 RED: extensions.mjs — absent/empty `extensions` produces byte-identical behavior to pre-change client (existing suites stay green, no composition overhead).
- [x] 2.4 GREEN: Add `extensions?: QueryExtension[]` to `IndigoClientOptions` in `packages/client/src/client.ts`.
- [x] 2.5 GREEN: Add private `applyExtensions(run: Executor): Executor` using `this.extensions.reduceRight<Executor>((next, ext) => ext(next), run)`; store `this.extensions = options.extensions ?? []` in the constructor.
- [x] 2.6 GREEN (correctness fix, design.md): move `protected readonly exec` from a class-field initializer to constructor-body assignment (`this.exec = applyExtensions(this.wrapLog(...))`), since `options.extensions` is not yet stored when field initializers run. Verify the generated subclass still reads `this.exec` correctly after `super(options)` (`packages/generator/src/client.ts:350`).
- [x] 2.7 GREEN: wire `applyExtensions` into `$withSession`'s `scoped` session-executor rewrap (`client.ts:148-149`) so `$transaction`/`$withSession` executors pass through the same chain, with `wrapLog` still innermost.

## Phase 3: Integration — Per-Query Context on Delegate Methods

- [x] 3.1 RED: extensions.mjs — `db.user.findMany(...)` extension observes `{ model: "user", operation: "findMany" }`.
- [x] 3.2 RED: extensions.mjs — `$queryRaw(sql, params)` extension observes `undefined` context.
- [x] 3.3 RED: extensions.mjs — two concurrent delegate calls for different models (`Promise.all([db.user.findMany(), db.post.create(...)])`) each observe only their own context, no bleed.
- [x] 3.4 GREEN: wrap `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `count` in `packages/client/src/delegate.ts` with `withQueryContext({ model: this.meta.name, operation: "<methodName>" }, () => ...)`.
- [x] 3.5 GREEN: confirm `$queryRaw`/internal statement paths in `client.ts` never set context (no `withQueryContext` wrapper there).

## Phase 4: Extension Semantics — Mutation, Short-Circuit, Errors

- [x] 4.1 RED: extensions.mjs — an extension that rewrites `sql`/`params` before calling `next` causes the base executor to receive the rewritten values.
- [x] 4.2 RED: extensions.mjs — an extension that returns rows without calling `next` short-circuits; base executor and inner extensions are never invoked; caller receives the extension's rows.
- [x] 4.3 RED: extensions.mjs — a throwing extension (sync throw and rejected promise) fails the query with the unwrapped original error; no fallback/swallowed result.
- [x] 4.4 RED: extensions.mjs — with `extensions: [outer, inner]` where `inner` throws, `outer`'s call to `next` rejects with `inner`'s error and propagates unless `outer` explicitly substitutes a result.
- [x] 4.5 GREEN: confirm 2.5/2.6/2.7's plain-function composition already satisfies 4.1-4.4 (no `try/catch` swallowing added in `applyExtensions` or `wrapLog`); fix if any interposed logic masks rejections.

## Phase 5: Coverage — Pool, Injected Executor, Transactions

- [x] 5.1 RED: extensions.mjs (pg harness) — extension wraps the default `pg.Pool`-backed executor; queries reach the pool only after the composed chain.
- [x] 5.2 RED: extensions.mjs (PGlite/injected harness) — extension wraps an injected executor identically to the pool path; no extension behavior depends on construction path.
- [x] 5.3 RED: extensions.mjs — extension observes each query issued inside `$transaction(fn)`, in the same composition order as the non-transaction path (both pg pool `BEGIN/COMMIT/ROLLBACK` path and injected `db.transaction` hook path).
- [x] 5.4 GREEN: fix any gap surfaced by 5.1-5.3 in `applyExtensions` call sites from Phase 2.
- [x] 5.5 Document (code comment in `client.ts` near `$withSession`) and add an explicit test note in `extensions.mjs`: `pg.Pool`'s `BEGIN`/`COMMIT`/`ROLLBACK` statements are issued directly against `client.query(...)`, outside `this.exec`/`applyExtensions` — extensions never observe those three control statements, only the session-scoped queries `fn` issues.
- [x] 5.6 RED: extensions.mjs — a demonstration timing/slow-query extension observes end-to-end query duration across pool + delegate paths without forking the client (success-criteria e2e scenario).
- [x] 5.7 GREEN: verify 5.6 passes with the composition built in Phase 2/3; add no client-internal logic beyond the seam.

## Phase 6: Regression and Closing

- [x] 6.1 Run `pnpm build --filter=@indigodb/client` — confirm `dist/` emits `context.ts` output and updated `client.ts`/`delegate.ts`/`types.ts`/`index.ts`.
- [x] 6.2 Run `pnpm lint` (typecheck-as-lint across the monorepo) — confirm no type errors from the new public exports.
- [x] 6.3 Run `pnpm test` — confirm `@indigodb/compiler` regression harness and `packages/client/test/*` (including new `extensions.mjs`) all pass.
- [x] 6.4 Confirm zero-behavior-change scenarios (2.3) still hold by re-running any pre-existing `packages/client/test/` suites unmodified.
