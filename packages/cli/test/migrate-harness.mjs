/**
 * PGlite-backed test harness for the migration runner (`migrate-runner.ts`).
 *
 * Mirrors `studio-harness.mjs`'s pattern: `@electric-sql/pglite` runs a real
 * PostgreSQL engine in-process over WASM, adapted to the `MigrationClient`
 * port `migrate-runner.ts` consumes instead of a real `pg.Client` — so the
 * suite drives the REAL runner functions (`ensureHistory`, `migrateDev`,
 * `migrateDeploy`, `migrateStatus`) against a real (if in-process) Postgres,
 * with no `node:fs`/`pg` mocking anywhere.
 */

import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Adapts a PGlite instance to the `MigrationClient` port `migrate-runner.ts`
 * expects: `query` maps straight to `db.query` (PGlite supports `$n`
 * parameter binding natively), `exec` maps to `db.exec` — required for
 * multi-statement bodies and explicit `BEGIN`/`COMMIT` text, which PGlite's
 * `query` (unlike `pg`'s simple query protocol) does not accept — and `end`
 * is a no-op: `withDatabase` owns the PGlite instance's lifecycle, not the
 * runner under test.
 */
export function createMigrationClient(db) {
  return {
    async query(sql, params) {
      const result = await db.query(sql, params);
      return { rows: result.rows };
    },
    async exec(sql) {
      return db.exec(sql);
    },
    async end() {
      // no-op: `withDatabase` closes the underlying PGlite instance.
    },
  };
}

/**
 * Wraps a `MigrationClient` and records every `{ sql, params }` pair passed
 * to `query`/`exec`, in order, in the returned `queries` array — so tests
 * can assert on call sequence and arguments (e.g. advisory-lock ordering)
 * without inspecting database state. By default every call forwards to
 * `inner` untouched; `onQuery(sql, params)` may return an override result
 * instead (used to force `pg_try_advisory_lock` to resolve `false` for the
 * contention case) — `inner` is never touched when an override is returned.
 */
export function spyMigrationClient(inner, { onQuery } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      const override = onQuery?.(sql, params);
      if (override !== undefined) return override;
      return inner.query(sql, params);
    },
    async exec(sql) {
      queries.push({ sql, params: undefined });
      const override = onQuery?.(sql, undefined);
      if (override !== undefined) return override;
      return inner.exec(sql);
    },
    async end() {
      return inner.end();
    },
  };
  return { client, queries };
}

/**
 * Creates a fresh, isolated `mkdtempSync`-based directory to use as a
 * migrations root (`cwd` seam) for a single test, plus a `cleanup()` to
 * remove it afterwards. Kept separate from `migrationsRoot()`'s
 * `migrations/` subdirectory convention — callers pass this directory as
 * `cwd` and the runner appends `migrations/` itself.
 */
export function createMigrationsRoot() {
  const dir = mkdtempSync(join(tmpdir(), "indigo-migrate-"));
  return {
    cwd: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
