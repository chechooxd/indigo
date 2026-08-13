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

export interface RealtimeOptions {
  /**
   * Base URL of the realtime server (`indigodb realtime` or an embedded
   * engine). Defaults to `process.env.INDIGO_REALTIME_URL`.
   */
  url?: string;
}

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
  /** Log every executed SQL statement (for debugging). */
  log?: boolean;
  /** Realtime subscription settings (models marked `@@realtime`). */
  realtime?: RealtimeOptions;
  /**
   * User-supplied middleware composing around the query `Executor`
   * (client-query-extensions spec). Consumed only at construction time —
   * `extensions[0]` is outermost (first to see the call, last to see the
   * result), `wrapLog` is always innermost so `log: true` keeps logging the
   * SQL actually sent. Applies to `this.exec`, `$queryRaw`, and every
   * session executor produced by `$withSession` (so `$transaction` is
   * covered identically) — no executor path bypasses the composed chain.
   */
  extensions?: QueryExtension[];
}

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

  /** Wraps an `Executor` with the `log` option's statement logging. */
  private readonly wrapLog =
    (run: Executor): Executor =>
    async (sql, params) => {
      if (this.log) console.log("[indigodb]", sql, params);
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
    return this.$withSession(fn);
  }

  /** Closes the connection pool (or injected executor) and any open realtime subscriptions. */
  async $disconnect(): Promise<void> {
    this.realtimeManager?.close();
    this.realtimeManager = null;
    await this.closeInjected?.();
  }
}
