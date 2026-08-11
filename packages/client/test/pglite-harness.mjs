/**
 * PGlite lifecycle helper for `@indigodb/client`'s regression suite
 * (`client.mjs`). Mirrors `packages/migrator/test/pg-harness.mjs` and
 * `packages/cli/test/studio-harness.mjs`'s style: a real PostgreSQL engine
 * running in-process over WASM, isolated per fixture, adding no production
 * API of its own.
 */

import { PGlite } from "@electric-sql/pglite";

/**
 * Runs `fn` against a fresh, isolated PGlite instance, always closing it
 * afterwards — even on failure. A brand-new instance per call, so one
 * fixture's data can never leak into another's.
 */
export async function withDatabase(fn) {
  const db = new PGlite();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/**
 * Adapts a PGlite instance to `@indigodb/client`'s `Executor` contract
 * (`(sql, params) => Promise<rows>`) — the same shape `pg.Pool.query`
 * exposes, so it can be injected via `IndigoClientOptions.db.exec`.
 */
export function createPgliteExecutor(db) {
  return async (sql, params) => (await db.query(sql, params)).rows;
}

/**
 * Adapts a PGlite instance to `@indigodb/client`'s full `options.db` shape
 * (`{ exec, transaction }`), including the `transaction` hook used by
 * `$transaction`/`$withSession`. PGlite owns the session for the duration
 * of `db.transaction(...)` — the inner closure must never touch the outer
 * `db`, only the `tx` handle it receives, or PGlite rejects it
 * (electric-sql/pglite#76).
 */
export function createPgliteDb(db) {
  return {
    exec: async (sql, params) => (await db.query(sql, params)).rows,
    transaction: (fn) =>
      db.transaction(async (tx) =>
        fn(async (sql, params) => (await tx.query(sql, params)).rows),
      ),
  };
}
