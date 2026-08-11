/**
 * @indigodb/client — Runtime client base
 *
 * Owns the PostgreSQL connection pool and exposes a parameterized query
 * executor. The generated `IndigoClient` extends this and attaches one
 * `ModelDelegate` per model.
 */

import pg from "pg";
import type { Pool as PgPool, PoolConfig } from "pg";
import type { Executor } from "./types.js";
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
  private readonly log: boolean;
  private readonly realtimeUrl: string | undefined;
  private realtimeManager: RealtimeConnectionManager | null = null;

  constructor(options: IndigoClientOptions = {}) {
    if (options.db) {
      this.pool = null;
      this.run = options.db.exec;
      this.closeInjected = options.db.close;
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

  /** Parameterized query executor passed to each model delegate. */
  protected readonly exec: Executor = async (sql, params) => {
    if (this.log) console.log("[indigodb]", sql, params);
    return this.run(sql, params);
  };

  /** Runs a raw parameterized query and returns the result rows. */
  async $queryRaw<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.exec(sql, params)) as T[];
  }

  /** Closes the connection pool (or injected executor) and any open realtime subscriptions. */
  async $disconnect(): Promise<void> {
    this.realtimeManager?.close();
    this.realtimeManager = null;
    if (this.pool) await this.pool.end();
    else await this.closeInjected?.();
  }
}
