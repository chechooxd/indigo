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

const { Pool } = pg;

export interface IndigoClientOptions {
  /**
   * PostgreSQL connection string. Defaults to `process.env.DATABASE_URL`.
   */
  connectionString?: string;
  /** Additional `pg` pool configuration. */
  pool?: PoolConfig;
  /** Log every executed SQL statement (for debugging). */
  log?: boolean;
}

export class IndigoClientBase {
  private readonly pool: PgPool;
  private readonly log: boolean;

  constructor(options: IndigoClientOptions = {}) {
    const connectionString =
      options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString && !options.pool) {
      throw new Error(
        "IndigoClient: no connection string. Pass `connectionString` or set DATABASE_URL.",
      );
    }
    this.pool = new Pool({ connectionString, ...options.pool });
    this.log = options.log ?? false;
  }

  /** Parameterized query executor passed to each model delegate. */
  protected readonly exec: Executor = async (sql, params) => {
    if (this.log) console.log("[indigodb]", sql, params);
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as Record<string, unknown>[];
  };

  /** Runs a raw parameterized query and returns the result rows. */
  async $queryRaw<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.exec(sql, params)) as T[];
  }

  /** Closes the underlying connection pool. */
  async $disconnect(): Promise<void> {
    await this.pool.end();
  }
}
