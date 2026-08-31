/**
 * PGlite-backed test harness for the Studio server (`studio-server.mjs`).
 *
 * `@electric-sql/pglite` runs a real PostgreSQL engine in-process over WASM
 * (mirrors `packages/migrator/test/pg-harness.mjs`'s pattern). This module
 * wires it into `startStudio`'s injectable `StudioDb` port so the suite
 * drives the REAL HTTP server, over real `fetch()` calls, against a real
 * (if in-process) Postgres — including its own transaction-level read-only
 * enforcement. Nothing here re-implements or weakens that enforcement: the
 * adapter's `readOnly` runs the exact same `SET TRANSACTION READ ONLY`
 * statement production does, through PGlite's own transaction primitive.
 */

import { PGlite } from "@electric-sql/pglite";
import { startStudio, readOnlyPreamble } from "../dist/studio-server.js";

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

function toFields(fields) {
  return (fields ?? []).map((f) => ({ name: f.name }));
}

/** Adapts a PGlite instance to the `StudioDb` port `startStudio` expects. */
export function createPgliteStudioDb(db) {
  return {
    async query(sql, params) {
      const result = await db.query(sql, params);
      return { rows: result.rows, fields: toFields(result.fields) };
    },
    async readOnly(fn) {
      return db.transaction(async (tx) => {
        // Uses the shared `readOnlyPreamble` builder — the exact statements
        // `createPgDb` issues in production — so the preamble mechanism gets
        // real runtime coverage through this harness. The timeout value
        // itself is pinned to `0` (disabled) rather than threaded through
        // from `withStudio`'s `queryTimeoutMs` option: empirically confirmed
        // (see apply-progress) that PGlite ACCEPTS `SET LOCAL
        // statement_timeout` without error but does NOT abort a
        // long-running statement once it elapses — a positive value here
        // would give false confidence of enforcement this harness cannot
        // actually prove. Real timeout enforcement is covered by
        // `readOnlyPreamble`'s own unit test plus a deterministic injected
        // `StudioDb` double that rejects with `{ code: "57014" }`.
        for (const stmt of readOnlyPreamble(0)) {
          await tx.query(stmt);
        }
        return fn(async (sql, params) => {
          const result = await tx.query(sql, params);
          return { rows: result.rows, fields: toFields(result.fields) };
        });
      });
    },
    // Real, committed write path: `db.transaction` here is a genuine
    // PGlite transaction that commits on success and rolls back if the
    // callback throws — never a no-op stand-in for `startStudio`'s writable
    // pool.
    async writable(fn) {
      return db.transaction(async (tx) => {
        return fn(async (sql, params) => {
          const result = await tx.query(sql, params);
          return { rows: result.rows, fields: toFields(result.fields) };
        });
      });
    },
    async close() {
      // The PGlite instance's lifecycle is owned by `withDatabase`, not by
      // `startStudio`'s `close()` — a test may want to keep querying the
      // database directly (e.g. to assert row counts) after the server
      // shuts down. So this is intentionally a no-op.
    },
  };
}

/**
 * Starts a real `startStudio` server on an ephemeral port (`port: 0`),
 * backed by `db` (a PGlite instance) via the injected `StudioDb` adapter.
 * Runs `fn({ baseUrl, db })` and always tears the server down afterwards.
 *
 * `options` is forwarded to `startStudio` (e.g. `{ host }`) so bind-address
 * and Origin/Host allowlist tests can exercise those code paths without
 * duplicating the harness.
 */
export async function withStudio(db, { resolved, source }, fn, options = {}) {
  const server = await startStudio({
    resolved,
    source,
    connectionString: "postgres://unused/unused", // never dialed: db is injected
    port: 0,
    open: false,
    db: createPgliteStudioDb(db),
    ...options,
  });
  try {
    return await fn({
      baseUrl: `http://${server.host}:${server.port}`,
      port: server.port,
      host: server.host,
    });
  } finally {
    await server.close();
  }
}
