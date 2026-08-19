/**
 * @indigodb/client — Deferred operation contract (`client-transaction-array-form`,
 * design.md "Contracts (packages/client/src/promise.ts, new)").
 *
 * Every `ModelDelegate` method returns a lazy `IndigoPromise<T>` instead of
 * executing SQL immediately (design.md "Technical Approach"). It carries
 * `{model, operation, self, run}` rather than pre-built SQL — several
 * operations are multi-statement and result-dependent (`findMany` + relation
 * loads, nested writes, `upsert`), so only a rebindable thunk survives being
 * re-invoked against a different session-scoped delegate
 * (design.md "Source evidence: SQL-capture impossible").
 *
 * `IndigoPromise<T> implements Promise<T>` — structural, NOT `extends
 * Promise<T>` (design.md Decision 1): subclassing runs the executor eagerly
 * via the base constructor (defeats laziness) and `.then` species-constructs
 * `new IndigoPromise(executor)`, incompatible with this class's
 * `(model, operation, self, run)` constructor. TypeScript's `Promise<T>` is a
 * structural interface (`then`/`catch`/`finally`/`Symbol.toStringTag`), so
 * implementing it gives full assignability at every existing
 * `Promise<T>`-typed call site. The one observable cost:
 * `instanceof Promise` is `false` for an `IndigoPromise` (release-note item,
 * design.md "Open questions").
 *
 * Memoization is a single field, `promise: Promise<T> | null`, doubling as
 * both the memo and the reuse detector (design.md Decision 2): `.then()`
 * (via `settle()`) returns the memo if already set, else executes against
 * `this.self`. `__claim(delegate)` throws `OPERATION_REUSED` if the memo is
 * already set, else sets it SYNCHRONOUSLY to `this.run(delegate)` before
 * returning — so duplicate-in-array and cross-transaction reuse are both
 * caught pre-execution, not after an await yields.
 *
 * The stale-client / brand check uses `Symbol.for("indigodb.deferred")`, not
 * `instanceof` (design.md Decision 3): `instanceof` false-negatives across
 * duplicated `@indigodb/client` copies in a pnpm `node_modules` tree.
 */

import type { DeferredResults } from "./types.js";

/**
 * Error taxonomy for the deferred-operation / array-transaction contract,
 * matching the existing `IndigoDatabaseError`/`IndigoRelationError` style in
 * this package (errors.ts, delegate.ts).
 *
 * `EMPTY_TRANSACTION` is reserved for future use — an empty array is a
 * documented no-op (spec "Empty array is a no-op"), not an error, so
 * `runDeferred` never throws it today.
 */
export type TransactionErrorCode =
  | "OPERATION_REUSED"
  | "NOT_A_DEFERRED_OPERATION"
  | "MODEL_NOT_IN_REGISTRY"
  | "EMPTY_TRANSACTION"
  | "ARRAY_FORM_REQUIRES_GENERATED_CLIENT";

export class IndigoTransactionError extends Error {
  readonly code: TransactionErrorCode;

  constructor(code: TransactionErrorCode, message: string) {
    super(message);
    this.name = "IndigoTransactionError";
    this.code = code;
  }
}

/**
 * Brand used to identify an `IndigoPromise` without `instanceof`
 * (design.md Decision 3). `Symbol.for` is a global-registry symbol, so it
 * still matches across duplicated `@indigodb/client` copies loaded from
 * different `node_modules` locations, unlike a module-local `Symbol()`.
 */
const BRAND: unique symbol = Symbol.for("indigodb.deferred");

/**
 * A lazy, rebindable, thenable operation. `T` is the resolved value; `D` is
 * the delegate type `run` is invoked against (defaults to `unknown` so the
 * public-facing type stays `IndigoPromise<T>` at ordinary call sites, while
 * `defer`'s own generic inference lets `run` reach a concrete delegate's
 * private `<op>Impl` members).
 */
export class IndigoPromise<T, D = unknown> implements Promise<T> {
  readonly [BRAND] = true;
  readonly model: string;
  readonly operation: string;

  private readonly self: D;
  private readonly run: (delegate: D) => Promise<T>;
  private promise: Promise<T> | null = null;

  constructor(model: string, operation: string, self: D, run: (delegate: D) => Promise<T>) {
    this.model = model;
    this.operation = operation;
    this.self = self;
    this.run = run;
  }

  get [Symbol.toStringTag](): string {
    return "IndigoPromise";
  }

  /**
   * Standalone-await path: memoized, executes against `this.self` (the
   * delegate the op was created from) on first settle, identical SQL/result
   * to the pre-change eager implementation (spec "Standalone await executes
   * immediately, identical to today").
   */
  private settle(): Promise<T> {
    if (this.promise === null) {
      this.promise = this.run(this.self);
    }
    return this.promise;
  }

  /**
   * `$transaction([...])` path (design.md "Rebindable by model name, not
   * captured SQL"): claims this op for execution against `delegate` (a
   * session-scoped sibling delegate for the same model), throwing
   * `OPERATION_REUSED` if it was already claimed or standalone-awaited.
   * Sets the memo SYNCHRONOUSLY so a duplicate reference inside the same
   * array, or reuse across two `$transaction` calls, is caught before any
   * `await` yields control.
   */
  __claim(delegate: D): Promise<T> {
    if (this.promise !== null) {
      throw new IndigoTransactionError(
        "OPERATION_REUSED",
        `Operation "${this.operation}" on model "${this.model}" was already awaited or ` +
          "claimed by a transaction and cannot be reused. Build a fresh operation for each " +
          "await/$transaction call.",
      );
    }
    this.promise = this.run(delegate);
    return this.promise;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return this.settle().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<T | TResult> {
    return this.settle().catch(onrejected);
  }

  finally(onfinally?: (() => void) | undefined | null): Promise<T> {
    return this.settle().finally(onfinally);
  }
}

/** Brand check, not `instanceof` (design.md Decision 3). */
export function isIndigoPromise(value: unknown): value is IndigoPromise<unknown> {
  return typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
}

/**
 * Constructs a deferred operation. `D` infers as the polymorphic `this` of
 * the delegate method calling it, so `run` can reach private `<op>Impl`
 * members from inside the delegate class body (design.md "Contracts"):
 *
 * ```ts
 * count(args) {
 *   return defer(this.meta.name, "count", this, (d) => d.countImpl(args));
 * }
 * ```
 */
export function defer<T, D>(
  model: string,
  operation: string,
  self: D,
  run: (delegate: D) => Promise<T>,
): IndigoPromise<T, D> {
  return new IndigoPromise<T, D>(model, operation, self, run);
}

/**
 * Sequential array-transaction engine shared by the generated client's
 * `$transaction([...])` (design.md "Both forms share one wiring path").
 *
 * Validates each element is an `IndigoPromise` (`NOT_A_DEFERRED_OPERATION`
 * otherwise — covers a plain value/`Promise` and a stale pre-upgrade
 * generated client that still returns eager `Promise<T>`s), resolves its
 * session-scoped delegate from `byModel` (`MODEL_NOT_IN_REGISTRY`
 * otherwise), then claims and awaits it before moving to the next element —
 * so ops run strictly in array order against one shared session. An empty
 * array short-circuits to `[]` before any lookup/session work (spec "Empty
 * array is a no-op").
 */
export async function runDeferred<Ops extends readonly IndigoPromise<unknown>[]>(
  ops: Ops,
  byModel: Record<string, unknown>,
): Promise<DeferredResults<Ops>> {
  if (ops.length === 0) {
    return [] as unknown as DeferredResults<Ops>;
  }

  const results: unknown[] = [];
  for (const op of ops) {
    if (!isIndigoPromise(op)) {
      throw new IndigoTransactionError(
        "NOT_A_DEFERRED_OPERATION",
        "$transaction array elements must be deferred operations returned by a model " +
          `delegate method (e.g. db.user.create(...)), got ${typeof op}. If this value comes ` +
          "from a generated client, regenerate it.",
      );
    }
    const delegate = byModel[op.model];
    if (delegate === undefined) {
      throw new IndigoTransactionError(
        "MODEL_NOT_IN_REGISTRY",
        `No delegate registered for model "${op.model}" in this transaction.`,
      );
    }
    results.push(await op.__claim(delegate));
  }
  return results as unknown as DeferredResults<Ops>;
}
