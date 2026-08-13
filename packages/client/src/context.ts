/**
 * @indigodb/client — Per-query extension context
 *
 * A module-scoped `AsyncLocalStorage<QueryContext>`, set once per public
 * `ModelDelegate` method call (`findMany`, `findFirst`, `findUnique`,
 * `create`, `update`, `delete`, `count` — see `delegate.ts`) so a
 * `QueryExtension` (`types.ts`) can read `{ model, operation }` without a
 * third `Executor` parameter threaded through every call site
 * (design.md Decision "Context transport").
 *
 * `$queryRaw` and every internal statement (`BEGIN`/`COMMIT`/`ROLLBACK`,
 * issued directly on the raw `pg` client inside `$withSession`) never call
 * `withQueryContext`, so `currentQueryContext()` reads `undefined` there —
 * by construction, not by an extra guard.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryContext } from "./types.js";

const storage = new AsyncLocalStorage<QueryContext>();

/**
 * Runs `fn` with `ctx` bound as the ambient `QueryContext` for the duration
 * of its (async) execution. `AsyncLocalStorage.run` binds the store to one
 * async execution context, so concurrent calls (e.g. two delegate methods
 * invoked via `Promise.all`) never bleed context into each other — each
 * gets its own `.run()` frame.
 *
 * Innermost-wins by ordinary `AsyncLocalStorage` nesting: when one wrapped
 * delegate method calls another internally (`findFirst` → `findMany`, or a
 * nested-write op on a DIFFERENT model's sibling delegate — `create` →
 * `target.create`), the innermost call's own context is what an extension
 * observes for the query it actually issues, and the outer context is
 * restored once the inner call returns. This is what keeps a nested write's
 * child-model query correctly attributed to the child model instead of
 * inheriting the parent call's context.
 */
export function withQueryContext<T>(ctx: QueryContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Reads the ambient `QueryContext` set by the innermost enclosing
 * `withQueryContext` call, or `undefined` outside any such call (e.g. for
 * `$queryRaw` or internal `BEGIN`/`COMMIT`/`ROLLBACK` statements).
 */
export function currentQueryContext(): QueryContext | undefined {
  return storage.getStore();
}
