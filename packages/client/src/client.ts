/**
 * @indigodb/client — Runtime client base
 *
 * Owns the PostgreSQL connection pool and exposes a parameterized query
 * executor. The generated `IndigoClient` extends this and attaches one
 * `ModelDelegate` per model.
 */

import type { Pool as PgPool, PoolConfig } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DriverAdapter, Executor, QueryExtension, TransactionHook } from "./types.js";
import { RealtimeConnectionManager, SseTransport } from "./realtime.js";
import { createPgAdapter } from "./adapters/pg.js";
import { IndigoTransactionError } from "./promise.js";
import { decodeHandlePayload, IndigoLiveHandleError, type HandleInfo } from "./live.js";

export interface RealtimeOptions {
  /**
   * Base URL of the realtime server (`indigodb realtime` or an embedded
   * engine). Defaults to `process.env.INDIGO_REALTIME_URL`.
   */
  url?: string;
  /**
   * App-supplied handle provisioning callback for `.live()` queries
   * (`client-live-queries` spec, `realtime-live-endpoint` delta's "Handle
   * provisioning ... pinned to an app-supplied `getHandle` callback"
   * requirement). The app mints the handle itself, server-side, via
   * `@indigodb/realtime`'s `mintHandle` after its own authentication.
   * IndigoDB never exposes an HTTP route that mints a handle on the app's
   * behalf.
   */
  getHandle?: (table: string) => Promise<string>;
}

/** Safety margin the handle cache re-mints AHEAD of actual expiry (design.md
 * Handle failure/retry state machine, "Cache miss; now >= exp - 5s skew").
 * Distinct from — and NOT to be confused with — `live.ts`'s own
 * `EXP_SKEW_SECONDS`, which allows a token that expired up to 5s AGO to
 * still decode as valid. The two skews serve opposite directions. */
const HANDLE_EXPIRY_SKEW_MS = 5_000;

export interface IndigoClientOptions {
  /**
   * PostgreSQL connection string. Defaults to `process.env.DATABASE_URL`.
   */
  connectionString?: string;
  /** Additional `pg` pool configuration. */
  pool?: PoolConfig;
  /**
   * Inject a pre-built query executor instead of letting the client own a
   * `pg.Pool`. Useful for embedding IndigoDB over an existing connection
   * (e.g. PGlite, a shared pool, a test harness). When provided, no
   * `pg.Pool` is constructed and `connectionString`/`pool` are ignored.
   */
  db?: DriverAdapter;
  /**
   * Log every executed statement's SQL for debugging. Bound parameter
   * values are never printed, only positional placeholders (`$1=<redacted>`)
   * preserving order and arity. Output format is a debugging aid, not a
   * parsing contract.
   */
  log?: boolean;
  /** Realtime subscription settings (models marked `@@realtime`). */
  realtime?: RealtimeOptions;
  /**
   * User-supplied middleware composing around the query `Executor`
   * (client-query-extensions spec). Consumed only at construction time —
   * `extensions[0]` is outermost (first to see the call, last to see the
   * result), `wrapLog` is always innermost so `log: true` keeps logging the
   * SQL actually sent, with parameter values redacted. Applies to
   * `this.exec`, `$queryRaw`, and every session executor produced by
   * `$withSession` (so `$transaction` is covered identically) — no executor
   * path bypasses the composed chain.
   */
  extensions?: QueryExtension[];
}

/**
 * Positional placeholders for bound params, used by `wrapLog`. Never reads a
 * value: the `map` callback discards its element argument, so no parameter
 * value can reach stdout through any branch. Not exported — the semantic
 * artifact this change protects is captured stdout, not this helper's
 * return value.
 */
function redactParams(params: unknown[]): string {
  if (params.length === 0) return "(0 params)";
  return params.map((_, i) => `$${i + 1}=<redacted>`).join(", ");
}

/**
 * `IndigoClientBase` — bare runtime client. It supports only the CALLBACK
 * form of `$transaction(fn)` (`client-transaction-array-form` spec,
 * "IndigoClientBase does not support the array form"). The sequential ARRAY
 * form (`$transaction([...])`) requires the generated `IndigoClient`'s
 * `TransactionClient`/`byModel` registry (built by the generator's
 * `__delegates`, design.md Decision 4) to rebind each `IndigoPromise` by
 * model name — a registry this bare base class has no way to build, since it
 * has no compiled model metadata. Compile-time, this is enforced simply by
 * never declaring an array-accepting overload here. At runtime, a caller
 * that bypasses the types (plain JS, or TypeScript `as any`) is caught by
 * the explicit `Array.isArray` guard in `$transaction` below — without it,
 * such a caller would instead get an opaque "fn is not a function" error
 * thrown from inside `$withSession` AFTER `BEGIN` was already issued
 * (design.md Decision 5).
 */
export class IndigoClientBase {
  private readonly pool: PgPool | null;
  private readonly run: Executor;
  private readonly closeInjected: (() => Promise<void>) | undefined;
  private readonly txHook: TransactionHook | undefined;
  private readonly log: boolean;
  private readonly extensions: QueryExtension[];
  private readonly realtimeUrl: string | undefined;
  private realtimeManager: RealtimeConnectionManager | null = null;
  /** Nesting guard for `$transaction`: `true` while a callback is in flight. */
  private readonly txContext = new AsyncLocalStorage<true>();
  private readonly getHandleFn: ((table: string) => Promise<string>) | undefined;
  /** Handle cache + in-flight-mint dedup map (design.md Decision 6):
   * guarantees `getHandle` is called AT MOST ONCE per table per validity
   * window even under concurrent same-tick `.live()` calls. */
  private readonly handleCache = new Map<string, HandleInfo>();
  private readonly handleInflight = new Map<string, Promise<HandleInfo>>();

  /**
   * Parameterized query executor passed to each model delegate.
   *
   * Assigned in the constructor BODY, not as a class-field initializer:
   * class-field initializers run before the constructor body executes, so
   * `this.extensions` (and `options.extensions`) would not yet be stored if
   * this composed `this.exec` at field-initialization time — a real
   * correctness bug the field-initializer form would have (design.md
   * Decision "Where `this.exec` is built").
   */
  protected readonly exec: Executor;

  constructor(options: IndigoClientOptions = {}) {
    if (options.db) {
      this.pool = null;
      // DOCUMENTED BOUNDARY (client-database-errors spec, design.md Decision
      // "injected db.exec path stays unwrapped"): deliberately NOT wrapped
      // with `withDatabaseErrors` — the host engine (PGlite, a shared pool,
      // some other driver) owns its own error shapes, and a Postgres
      // SQLSTATE is not guaranteed to be present at all. Same style as the
      // BEGIN/COMMIT extension-bypass comment on `$withSession` below.
      this.run = options.db.exec;
      this.closeInjected = options.db.close;
      this.txHook = options.db.transaction;
    } else {
      const connectionString =
        options.connectionString ?? process.env.DATABASE_URL;
      if (!connectionString && !options.pool) {
        throw new Error(
          "IndigoClient: no connection string. Pass `connectionString` or set DATABASE_URL.",
        );
      }
      const adapter = createPgAdapter({ connectionString, ...options.pool });
      this.pool = adapter.pool;
      this.run = adapter.exec;
      this.closeInjected = adapter.close;
      this.txHook = adapter.transaction;
    }
    this.log = options.log ?? false;
    this.extensions = options.extensions ?? [];
    this.realtimeUrl =
      options.realtime?.url ?? process.env.INDIGO_REALTIME_URL;
    this.getHandleFn = options.realtime?.getHandle;
    this.exec = this.applyExtensions(
      this.wrapLog((sql, params) => this.run(sql, params)),
    );
  }

  /**
   * Lazy shared realtime connection manager, handed to realtime delegates as
   * a thunk so a missing URL only errors when `subscribe()` is actually called.
   */
  protected readonly $realtime = (): RealtimeConnectionManager => {
    if (!this.realtimeManager) {
      if (!this.realtimeUrl) {
        throw new Error(
          "IndigoClient: realtime is not configured. Pass `realtime: { url }` or set INDIGO_REALTIME_URL.",
        );
      }
      this.realtimeManager = new RealtimeConnectionManager(
        new SseTransport(this.realtimeUrl),
      );
    }
    return this.realtimeManager;
  };

  /**
   * Synchronous config guard for `.live()` (`live.ts`'s `LiveDeps.requireHandle`,
   * design.md handle-failure table's "config" row): throws IMMEDIATELY,
   * mirroring `$realtime()`'s existing missing-config pattern, rather than
   * surfacing as a rejected promise buried inside the async bootstrap.
   */
  protected readonly $requireGetHandle = (): void => {
    if (!this.getHandleFn) {
      throw new Error(
        "IndigoClient: live queries require `realtime.getHandle`. Pass `realtime: { getHandle } }` " +
          "(an app-supplied `(table) => Promise<string>` that mints a handle server-side via " +
          "`@indigodb/realtime`'s `mintHandle`).",
      );
    }
  };

  /**
   * Mints (or reuses) a per-table handle for `.live()` (design.md Decision
   * 6). `opts.refresh` bypasses BOTH the cache and any in-flight mint,
   * forcing a fresh `getHandle` call — used by `live.ts`'s retry-once state
   * machine on a verified handle failure or a provider rejection.
   *
   * Without a `refresh`: a cached, unexpired (with `HANDLE_EXPIRY_SKEW_MS`
   * margin) handle is reused; otherwise an in-flight mint for the same
   * table is awaited instead of starting a second one — two `.live()` calls
   * issued in the same tick, before either resolves, therefore call
   * `getHandle` exactly once (tasks.md 2.1).
   *
   * A handle that fails local decode validation (`decodeHandlePayload`)
   * throws `IndigoLiveHandleError` — `live.ts` classifies this as a
   * "verified handle failure" distinct from `getHandle` itself rejecting
   * (a provider failure) — and is never cached.
   */
  protected readonly $handle = async (
    table: string,
    opts: { refresh?: boolean } = {},
  ): Promise<HandleInfo> => {
    this.$requireGetHandle();

    if (!opts.refresh) {
      const cached = this.handleCache.get(table);
      if (cached && Date.now() < cached.expiresAtMs - HANDLE_EXPIRY_SKEW_MS) {
        return cached;
      }
      const inflight = this.handleInflight.get(table);
      if (inflight) return inflight;
    }

    const mint = (async (): Promise<HandleInfo> => {
      const token = await this.getHandleFn!(table);
      const decoded = decodeHandlePayload(token, table);
      if (!decoded.ok) {
        throw new IndigoLiveHandleError(
          decoded.reason,
          `IndigoDB: the handle minted for "${table}" failed local validation (${decoded.reason}).`,
        );
      }
      const info: HandleInfo = {
        token,
        userId: decoded.payload.u,
        expiresAtMs: decoded.payload.exp * 1000,
      };
      this.handleCache.set(table, info);
      return info;
    })();

    this.handleInflight.set(table, mint);
    try {
      return await mint;
    } finally {
      if (this.handleInflight.get(table) === mint) {
        this.handleInflight.delete(table);
      }
    }
  };

  /**
   * Wraps an `Executor` with the `log` option's statement logging. Logs SQL
   * plus redacted positional placeholders, never bound parameter values.
   */
  private readonly wrapLog =
    (run: Executor): Executor =>
    async (sql, params) => {
      if (this.log) console.log("[indigodb]", sql, redactParams(params));
      return run(sql, params);
    };

  /**
   * Composes `this.extensions` around `run`, `extensions[0]` outermost (first
   * to observe the call, last to observe the result) via `reduceRight`, so
   * reading the array in declared order and folding right-to-left puts the
   * first extension on the outside. Returns `run` unchanged when the list is
   * empty — no composition overhead, and behavior is provably identical to
   * before this capability existed (client-query-extensions spec). Called at
   * every executor-construction site — the constructor's `this.exec` and
   * `$withSession`'s session-executor rewrap — so no path bypasses the chain.
   */
  private applyExtensions(run: Executor): Executor {
    return this.extensions.reduceRight<Executor>((next, ext) => ext(next), run);
  }

  /** Runs a raw parameterized query and returns the result rows. */
  async $queryRaw<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.exec(sql, params)) as T[];
  }

  /**
   * Runs `fn` on an `Executor` bound to one exclusive session for the
   * duration of the call, delegating BEGIN/COMMIT/ROLLBACK lifecycle to
   * `this.txHook` — the built-in `connectionString` path's hook (from
   * `createPgAdapter`, real `pg.Pool` BEGIN/COMMIT/ROLLBACK) and the
   * injected `options.db.transaction` path share this exact same call site
   * (design.md "Technical Approach": "the built-in path and the bring-your-
   * own-driver path become the same code, so they cannot drift"). Rejects
   * if a `$transaction`/`$withSession` call is already in flight on this
   * client — no nested transactions.
   *
   * DOCUMENTED BOUNDARY (client-query-extensions spec, tasks.md 5.5):
   * `BEGIN`/`COMMIT`/`ROLLBACK` are issued inside the adapter's `transaction`
   * hook, never through `this.exec`/`applyExtensions`. This is intentional,
   * not a bug — extensions never observe those three control statements,
   * only the session-scoped queries `fn` itself issues through the composed
   * `sessionExec` it receives (wrapped by `scoped` below).
   */
  protected async $withSession<T>(
    fn: (exec: Executor) => Promise<T>,
  ): Promise<T> {
    if (this.txContext.getStore()) {
      throw new Error("IndigoClient: $transaction cannot be nested.");
    }
    const scoped = (sessionExec: Executor): Promise<T> =>
      this.txContext.run(true, () =>
        fn(this.applyExtensions(this.wrapLog(sessionExec))),
      );

    if (!this.txHook) {
      throw new Error(
        "IndigoClient: the injected executor does not support transactions. Provide `db.transaction`.",
      );
    }
    // The adapter (or host engine) owns BEGIN/COMMIT/ROLLBACK and session release.
    return this.txHook(scoped);
  }

  /**
   * Runs `fn` inside an exclusive transaction: commits on success, rolls
   * back and rethrows on failure. `fn` receives the session-scoped
   * `Executor` directly on the base class — the generated `IndigoClient`
   * overrides `$transaction` to hand `fn` typed per-table delegates bound
   * to that same executor instead.
   */
  async $transaction<T>(fn: (exec: Executor) => Promise<T>): Promise<T> {
    // Runtime boundary guard (see class doc comment above) — checked before
    // any session/BEGIN work, so a JS/`as any` caller passing an array gets
    // an explicit, typed error instead of an opaque failure deep inside
    // `$withSession`.
    if (Array.isArray(fn)) {
      throw new IndigoTransactionError(
        "ARRAY_FORM_REQUIRES_GENERATED_CLIENT",
        "IndigoClientBase.$transaction only supports the callback form " +
          "(fn: (exec) => Promise<T>). The array form ($transaction([...])) " +
          "requires a generated IndigoClient — run `indigodb generate`.",
      );
    }
    return this.$withSession(fn);
  }

  /**
   * Runs `fn` inside a Row-Level Security auth context: sets the `app.user_id`
   * Postgres setting `@@allow`-generated policies read (`current_setting
   * ('app.user_id', true)`), scoped to one exclusive session/transaction via
   * `$withSession`, then delegates to `fn`.
   *
   * Built on `$withSession` (design decision #16), never a reimplemented
   * BEGIN/COMMIT: `$withSession` already owns transaction lifecycle and the
   * nesting guard, so `set_config(..., is_local: true)` — transaction-local
   * by definition — dies at the same `COMMIT`/`ROLLBACK` that closes the
   * session. That is the STRUCTURAL guarantee behind "no identity leak
   * across a recycled pooled connection": there is no code path where the
   * setting could outlive the transaction, because it was never set outside
   * one.
   *
   * `set_config('app.user_id', $1, true)`, NEVER `SET LOCAL app.user_id =
   * $1` (design decision #15): `SET` does not accept bind parameters, so
   * `SET LOCAL` would force string-interpolating `ctx.userId` into SQL text
   * — exactly the injection surface `set_config`'s bound `$1` avoids.
   * `String(ctx.userId)` — `set_config`'s value parameter is text; the
   * RLS policy predicate casts it to the referenced field's actual SQL type
   * (`@indigodb/migrator`'s `renderPolicy`), so no cast decision is made
   * here.
   *
   * DELIBERATELY named `$authSession`, NOT `$auth` (deviation from
   * design.md's literal Interfaces section, discovered during apply):
   * design proposed the generated `IndigoClient` exposing a typed `$auth`
   * by overRIDING this method with a narrower callback parameter
   * (`(tx: TransactionClient) => Promise<T>` instead of `(exec: Executor)
   * => Promise<T>`). That does NOT type-check under `strict` — verified in
   * isolation: TypeScript's class-member-override compatibility check is
   * contravariant on method parameters regardless of method-vs-property
   * syntax (no bivariance escape for a plain override), and `TransactionClient`
   * is not a supertype of `Executor`. `$transaction`'s existing override
   * only compiles because it is declared as an OVERLOAD SET including a
   * generic-constrained array-form signature, which happens to make
   * TypeScript skip the override check — an accidental compiler quirk this
   * change does not want to depend on for a brand-new, single-shape method.
   * Naming this method `$authSession` instead removes the override
   * relationship entirely: the generated `IndigoClient.$auth` (see
   * `generator/src/client.ts`) is then a genuinely NEW public method, not
   * an override, so no contravariance conflict is possible.
   */
  protected async $authSession<T>(
    ctx: { userId: string | number },
    fn: (exec: Executor) => Promise<T>,
  ): Promise<T> {
    return this.$withSession(async (exec) => {
      await exec("SELECT set_config('app.user_id', $1, true)", [String(ctx.userId)]);
      return fn(exec);
    });
  }

  /** Closes the connection pool (or injected executor) and any open realtime subscriptions. */
  async $disconnect(): Promise<void> {
    this.realtimeManager?.close();
    this.realtimeManager = null;
    this.handleCache.clear();
    this.handleInflight.clear();
    await this.closeInjected?.();
  }
}
