/**
 * @indigodb/client — Runtime client base
 *
 * Owns the PostgreSQL connection pool and exposes a parameterized query
 * executor. The generated `IndigoClient` extends this and attaches one
 * `ModelDelegate` per model.
 */

import pg from "pg";
import type { Pool as PgPool, PoolConfig } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Executor, TransactionHook } from "./types.js";
import { RealtimeConnectionManager, SseTransport } from "./realtime.js";

const { Pool } = pg;

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
  db?: {
    /** Runs a parameterized SQL statement and returns its result rows. */
    exec: Executor;
    /** Optional teardown hook invoked by `$disconnect()`. */
    close?: () => Promise<void>;
    /**
     * Optional transaction hook. When present, `$transaction`/`$withSession`
     * delegates session lifecycle (begin/commit/rollback) to the host
     * engine instead of issuing raw `BEGIN`/`COMMIT`/`ROLLBACK` itself.
     * Required for `$transaction` to work on the injected-executor path;
     * absent it, `$transaction` rejects with an explicit error.
     */
    transaction?: TransactionHook;
  };
  /** Log every executed SQL statement (for debugging). */
  log?: boolean;
  /** Realtime subscription settings (models marked `@@realtime`). */
  realtime?: RealtimeOptions;
}

export class IndigoClientBase {
  private readonly pool: PgPool | null;
  private readonly run: Executor;
  private readonly closeInjected: (() => Promise<void>) | undefined;
  private readonly txHook: TransactionHook | undefined;
  private readonly log: boolean;
  private readonly realtimeUrl: string | undefined;
  private realtimeManager: RealtimeConnectionManager | null = null;
  /** Nesting guard for `$transaction`: `true` while a callback is in flight. */
  private readonly txContext = new AsyncLocalStorage<true>();

  constructor(options: IndigoClientOptions = {}) {
    if (options.db) {
      this.pool = null;
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
      const pool = new Pool({ connectionString, ...options.pool });
      this.pool = pool;
      this.run = async (sql, params) =>
        (await pool.query(sql, params as unknown[]))
          .rows as Record<string, unknown>[];
      this.closeInjected = undefined;
      this.txHook = undefined;
    }
    this.log = options.log ?? false;
    this.realtimeUrl =
      options.realtime?.url ?? process.env.INDIGO_REALTIME_URL;
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

  /** Parameterized query executor passed to each model delegate. */
  protected readonly exec: Executor = this.wrapLog((sql, params) =>
    this.run(sql, params),
  );

  /** Runs a raw parameterized query and returns the result rows. */
  async $queryRaw<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.exec(sql, params)) as T[];
  }

  /**
   * Runs `fn` on an `Executor` bound to one exclusive session for the
   * duration of the call, committing on success and rolling back on
   * failure (pg.Pool path), or delegating that lifecycle to the injected
   * `db.transaction` hook. Rejects if a `$transaction`/`$withSession` call
   * is already in flight on this client — no nested transactions.
   */
  protected async $withSession<T>(
    fn: (exec: Executor) => Promise<T>,
  ): Promise<T> {
    if (this.txContext.getStore()) {
      throw new Error("IndigoClient: $transaction cannot be nested.");
    }
    const scoped = (sessionExec: Executor): Promise<T> =>
      this.txContext.run(true, () => fn(this.wrapLog(sessionExec)));

    if (!this.pool) {
      if (!this.txHook) {
        throw new Error(
          "IndigoClient: the injected executor does not support transactions. Provide `db.transaction`.",
        );
      }
      // The host engine owns BEGIN/COMMIT/ROLLBACK and session release.
      return this.txHook(scoped);
    }

    const client = await this.pool.connect();
    let poison: unknown;
    try {
      await client.query("BEGIN");
      let result: T;
      try {
        result = await scoped(
          async (sql, params) =>
            (await client.query(sql, params as unknown[]))
              .rows as Record<string, unknown>[],
        );
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          poison = rollbackErr;
          console.error("[indigodb] ROLLBACK failed", rollbackErr);
        }
        throw err; // original error is never masked
      }
      await client.query("COMMIT"); // COMMIT failure propagates as-is
      return result;
    } finally {
      // Truthy `poison` tells `pg` to destroy the connection instead of
      // returning a poisoned session to the pool.
      client.release(poison as Error | undefined);
    }
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
    if (this.pool) await this.pool.end();
    else await this.closeInjected?.();
  }
}
