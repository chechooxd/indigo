# Design: Client Query Extension Seam

## Technical Approach

Formalize the existing private `wrapLog` pattern (`packages/client/src/client.ts:114-125`) into a
public `QueryExtension = (next: Executor) => Executor`. `IndigoClientBase` composes the user's
`extensions` once and applies them through a single private `applyExtensions(executor)` helper called
at both executor-construction sites — `this.exec` and the session executor inside `$withSession`
(`client.ts:148-149`) — so `$transaction`, `$queryRaw` and delegate queries all pass the same seam.
Per-query metadata (`model`, `operation`) travels through a module-scoped `AsyncLocalStorage` set once
per public `ModelDelegate` method; `sql`/`params` are already the executor's own arguments.

## Architecture Decisions

| Decision | Options | Choice + rationale |
|---|---|---|
| Extension shape | `(next: Executor) => Executor` vs. object hooks (`before`/`after`) vs. Prisma-style `$extends` | **`(next) => Executor`** — identical to `wrapLog`, so composition, mutation of `sql`/`params`, short-circuit (never call `next`), and error observation all fall out of plain functions with zero new machinery. |
| Composition order | `extensions[0]` outermost vs. innermost | **`extensions[0]` outermost** via `reduceRight((next, ext) => ext(next), base)` — reads like middleware/`compose`: first registered sees the call first and the result last. `wrapLog` is the `base` argument, therefore always innermost, so logs show the SQL actually executed and `log: true` behavior is unchanged. |
| Application sites | wrap only `this.exec` vs. a shared helper at both sites | **Private `applyExtensions(run: Executor): Executor`**, called as `applyExtensions(wrapLog(...))` at `this.exec` and inside `$withSession`'s `scoped`. Wrapping only `this.exec` would let `$transaction` bypass extensions entirely — the exact defect the proposal names. Returns `run` unchanged when the list is empty (no overhead, provable zero behavior change). |
| Where `this.exec` is built | field initializer (today) vs. constructor body | **Constructor body.** ES class-field initializers run before the constructor body, so `options.extensions` is not yet stored when a field initializer would compose. `protected readonly exec: Executor;` declared, assigned in the constructor after options are read. `wrapLog`/`applyExtensions` remain arrow fields (already initialized), and the generated subclass only reads `this.exec` after `super(options)` (`packages/generator/src/client.ts:350`), so ordering stays safe. |
| Context transport | `AsyncLocalStorage` vs. third `Executor` parameter | **`AsyncLocalStorage`.** Threading a parameter would change the public `Executor` type — breaking every injected `db.exec` (PGlite harness, generator, existing tests) and forcing all ~10 `this.exec` call sites plus `$queryRaw`/`$withSession` to carry it. ALS binds a store to one async execution context, so concurrent queries cannot bleed: each delegate call gets its own `.run()` frame. `node:async_hooks` is already imported for `txContext`, and the client is Node-only (`pg`). Cost: one `.run()` wrap per public delegate method. |
| Context content | `model`/`operation` strings vs. full `ModelMeta` | **Strings only** (`meta.name`, method name), keeping the public surface minimal and stable. `undefined` for `$queryRaw` and internal statements (`BEGIN`/`COMMIT` are issued on the raw pg client, outside the seam by construction). |
| Registration | constructor-only vs. `$use()` | **Constructor-only, immutable** — composition happens once; no mid-flight mutation semantics or re-composition races. |

## Data Flow

    delegate.findMany() ── withQueryContext({model,operation}) ─┐
                                                               ▼
      ext[0] ──→ ext[1] ──→ ... ──→ wrapLog ──→ run (pool | injected | session)
        │                                                      │
        └───────────── rows / rejection bubble back ───────────┘
                    extensions read context via currentQueryContext()

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/types.ts` | Modify | Add `QueryExtension`, `QueryContext` next to `Executor` (line 225) |
| `packages/client/src/context.ts` | Create | Module `AsyncLocalStorage<QueryContext>`, internal `withQueryContext(ctx, fn)`, public `currentQueryContext()` |
| `packages/client/src/client.ts` | Modify | `IndigoClientOptions.extensions?`, stored list, `applyExtensions`, `exec` moved to constructor, `$withSession` rewrap |
| `packages/client/src/delegate.ts` | Modify | Wrap `findMany`/`findFirst`/`findUnique`/`create`/`update`/`delete`/`count` bodies in `withQueryContext` |
| `packages/client/src/index.ts` | Modify | Re-export `QueryExtension`, `QueryContext`, `currentQueryContext` |
| `packages/client/test/extensions.mjs` | Create | Ordering, mutation, short-circuit, error, transaction, concurrency tests |

## Interfaces / Contracts

```ts
// types.ts
export interface QueryContext { model: string; operation: string }
export type QueryExtension = (next: Executor) => Executor;

// context.ts
export function currentQueryContext(): QueryContext | undefined;

// client.ts
private applyExtensions(run: Executor): Executor {
  return this.extensions.reduceRight<Executor>((next, ext) => ext(next), run);
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Order (`ext[0]` outermost), sql/params mutation reaching the base, short-circuit skipping the base, throwing extension propagating unwrapped, rejection observable | Fake-executor pattern from `client-executor-seam` (`stubExecutor()` recording `{sql, params}`) against `IndigoClientBase` |
| Unit | `applyExtensions` is identity when `extensions` absent | Existing suites (`client.mjs`, `relations.mjs`, `nested-writes-*.mjs`) must stay green unchanged |
| Integration | Extensions fire inside `$transaction`/`$withSession` (injected + `pg` paths) and for `$queryRaw`; context `model`/`operation` correct, `undefined` for `$queryRaw` | PGlite harness (`pglite-harness.mjs`), plus `transactions-pg.mjs` style for the pool path |
| Integration | No context bleed across concurrent queries | `Promise.all` of interleaved delegate calls on different models, extension asserts each observed context matches its own SQL |
| E2E | Timing / slow-query extension demonstrated without forking | One example extension in the test suite measuring per-query duration |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The seam executes only user-supplied in-process functions around already-parameterized SQL; it introduces no new string concatenation into SQL.

## Migration / Rollout

No migration. `extensions` is additive and off by default; no schema, IR, WASM or generated-output change. Rollback is a plain revert.

## Non-Goals

Declarative filter injection (soft delete, tenant scoping) is explicitly out of scope — the `Executor`
boundary sees only SQL text and params. Epic 1 (`client-where-composition`) will add a recursive
`WhereInput` and a delegate-level hook that composes filters before SQL generation, layering above
this seam rather than replacing it.

## Open Questions

- [ ] None blocking.
