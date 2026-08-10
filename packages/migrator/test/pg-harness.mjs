/**
 * PGlite lifecycle helper for the appliability suite (`appliability.mjs`).
 *
 * PGlite (`@electric-sql/pglite`) runs a real PostgreSQL engine in-process
 * over WASM. This module owns ONLY the mechanics of driving it — a fresh
 * database per fixture, executing a phase-tagged migration plan, and two
 * thin assertion helpers. It adds no production API: the phase decision
 * (what runs pre-transaction vs. inside the transaction) always comes from
 * the real, shipped `splitMigrationSql`, never from a re-derived split.
 */

import { PGlite } from "@electric-sql/pglite";
import { splitMigrationSql } from "../dist/index.js";

/**
 * Runs `fn` against a fresh, isolated PGlite instance, always closing it
 * afterwards — even on failure. Isolation is structural (a brand-new
 * instance per call), not a reset of shared state, so one fixture's schema
 * can never leak into another's.
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
 * Applies a rendered migration file's SQL against `db`, mirroring
 * `@indigodb/cli`'s `applyMigrationSql` (`migrate-runner.ts`): every
 * pre-transaction statement runs first, each as its own call (PGlite's
 * `exec`, like `pg`'s simple query protocol, would otherwise implicitly
 * wrap a multi-statement string in one transaction — exactly what the split
 * exists to avoid), then the transactional body runs inside one
 * `BEGIN`/`COMMIT`. Returns the number of statements actually executed
 * (pre-transaction statements counted individually; the transactional body
 * counts as 1 when non-empty), so callers can assert "nothing executed"
 * for refusal fixtures without the assertion being satisfied by a silently
 * swallowed error.
 */
export async function applyPlan(db, migrationSql) {
  const { preTransaction, transactional } = splitMigrationSql(migrationSql);
  let executed = 0;
  for (const statement of preTransaction) {
    await db.exec(statement);
    executed++;
  }
  if (transactional.trim().length > 0) {
    await db.exec(`BEGIN;\n${transactional}\nCOMMIT;`);
    executed++;
  }
  return executed;
}

/** Asserts `sql` executes against `db` without throwing. Rethrows with context on failure. */
export async function assertApplies(db, sql) {
  try {
    await db.exec(sql);
  } catch (err) {
    throw new Error(`expected SQL to apply cleanly but it errored: ${err.message}\n${sql}`);
  }
}

/** Asserts `sql` (or a `BEGIN; sql; ROLLBACK;` wrapped attempt) rejects, matching `pattern`. */
export async function assertRejects(db, sql, pattern) {
  let threw = false;
  let message = "";
  try {
    await db.exec(sql);
  } catch (err) {
    threw = true;
    message = err.message;
  }
  if (!threw) {
    throw new Error(`expected SQL to be rejected but it applied cleanly:\n${sql}`);
  }
  if (!pattern.test(message)) {
    throw new Error(`rejected, but error did not match ${pattern}: ${message}`);
  }
}
