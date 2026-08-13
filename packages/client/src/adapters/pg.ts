/**
 * @indigodb/client — `pg.Pool`-backed driver adapter (`client-driver-adapters`
 * spec).
 *
 * Extracted, not reinvented (design.md "Technical Approach"): this is the
 * exact pool/transaction/error-wrapping logic that used to live inline in
 * `IndigoClientBase`'s constructor `else` branch and `$withSession`'s pool
 * branch. `client.ts`'s `connectionString` construction path now calls this
 * factory internally, so the built-in path and the "bring your own driver"
 * path share one implementation and cannot drift.
 */

import pg from "pg";
import type { Pool as PgPool, PoolConfig } from "pg";
import type { DriverAdapter, Executor, TransactionHook } from "../types.js";
import { withDatabaseErrors } from "../errors.js";

const { Pool } = pg;

/**
 * Either a `pg.PoolConfig` (the adapter constructs and owns its own
 * `pg.Pool`) or an existing `pg.Pool` instance to embed over without taking
 * ownership of its lifecycle (design.md Decision 2). Discriminated via
 * `"pool" in config`, never `instanceof pg.Pool` — `instanceof` breaks
 * across duplicate `pg` copies in a pnpm tree (same reasoning `errors.ts`
 * already documents for `DatabaseError`).
 */
export type PgAdapterConfig = PoolConfig | { pool: PgPool };

export interface PgAdapter extends Required<DriverAdapter> {
  /**
   * The `pg.Pool` this adapter uses — either newly constructed (`PoolConfig`
   * input) or the exact instance passed in (`{ pool }` input). Exposed so
   * `IndigoClientBase` can keep its own `pool` field truthful (design.md
   * Decision 4) and so callers get an escape hatch without reconstructing
   * one themselves.
   */
  pool: PgPool;
}

/**
 * Builds a `pg.Pool`-backed `DriverAdapter`: `exec` wrapped with
 * `withDatabaseErrors`, a real `BEGIN`/`COMMIT`/`ROLLBACK` `transaction`
 * hook with poison-aware `client.release(poison)`, and a `close()` that only
 * calls `pool.end()` when this adapter constructed the pool itself
 * (design.md Decision 3 — never end a caller-owned pool).
 */
export function createPgAdapter(config: PgAdapterConfig = {}): PgAdapter {
  const ownsPool = !("pool" in config);
  const pool: PgPool = ownsPool
    ? new Pool(config as PoolConfig)
    : (config as { pool: PgPool }).pool;

  const exec: Executor = withDatabaseErrors(async (sql, params) =>
    (await pool.query(sql, params as unknown[])).rows as Record<string, unknown>[],
  );

  const transaction: TransactionHook = async <T>(
    fn: (exec: Executor) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    // Same wrapping as the built-in path's `execControl` (design.md Decision
    // "all three exec paths, including BEGIN/COMMIT"): a DEFERRABLE unique
    // constraint can raise SQLSTATE 23505 at COMMIT rather than at the
    // failing statement. ROLLBACK is deliberately excluded — it keeps its
    // own poison/console.error handling below, unwrapped.
    const execControl = withDatabaseErrors(async (sql) => {
      await client.query(sql);
      return [];
    });
    let poison: unknown;
    try {
      await execControl("BEGIN", []);
      let result: T;
      try {
        result = await fn(
          withDatabaseErrors(
            async (sql, params) =>
              (await client.query(sql, params as unknown[]))
                .rows as Record<string, unknown>[],
          ),
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
      await execControl("COMMIT", []); // COMMIT failure propagates as-is, now typed
      return result;
    } finally {
      // Truthy `poison` tells `pg` to destroy the connection instead of
      // returning a poisoned session to the pool.
      client.release(poison as Error | undefined);
    }
  };

  const close = async (): Promise<void> => {
    if (ownsPool) await pool.end();
  };

  return { exec, transaction, close, pool };
}
