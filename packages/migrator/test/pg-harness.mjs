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

const INTROSPECT_SQL = `
SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
       c.is_nullable, c.column_default, c.is_identity, c.identity_generation
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.column_name;`;

/**
 * Introspects `db`'s `public` schema into a normalized, order-independent
 * `Map` keyed `${table}.${column}`, built in `ORDER BY table_name,
 * column_name` sort order (NEVER `ordinal_position` — that would make two
 * structurally identical databases compare unequal purely because one added
 * a column via `ALTER TABLE` while the other declared it inline).
 *
 * This is a POSITIVE SELECTION, not a deep-equal-with-ignore-list: only
 * `table`, `column`, `type`, `nullable`, `default` are ever read off
 * `information_schema`, so constraint names, index names, FK action names,
 * and ordinal position can never silently enter a future comparison — they
 * are never selected in the first place.
 */
export async function introspectPublicSchema(db) {
  const result = await db.query(INTROSPECT_SQL);
  const snapshot = new Map();
  for (const row of result.rows) {
    const table = row.table_name;
    const column = row.column_name;
    const type = row.data_type === "USER-DEFINED" ? `enum:${row.udt_name}` : row.data_type;
    const nullable = row.is_nullable === "YES";
    const defaultShape =
      row.is_identity === "YES"
        ? `identity:${row.identity_generation}`
        : (row.column_default ?? null)?.replace(/\s+/g, " ").trim() ?? null;
    snapshot.set(`${table}.${column}`, { table, column, type, nullable, default: defaultShape });
  }
  return snapshot;
}

/**
 * Compares two `introspectPublicSchema` snapshots and throws ONCE with every
 * divergence, sorted by key and newline-joined, when any exist. A table
 * present on only one side is reported as ONE line (`table "X": present in
 * A, absent in B`), never one line per missing column, so a whole missing
 * table doesn't bury the report under N near-duplicate lines.
 */
export function assertSameStructure(a, b, { aLabel, bLabel }) {
  const lines = [];

  const tablesOf = (snapshot) => new Set([...snapshot.values()].map((entry) => entry.table));
  const tablesA = tablesOf(a);
  const tablesB = tablesOf(b);

  for (const table of [...tablesA].sort()) {
    if (!tablesB.has(table)) {
      lines.push(`table "${table}": present in ${aLabel}, absent in ${bLabel}`);
    }
  }
  for (const table of [...tablesB].sort()) {
    if (!tablesA.has(table)) {
      lines.push(`table "${table}": present in ${bLabel}, absent in ${aLabel}`);
    }
  }

  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of [...keys].sort()) {
    const entryA = a.get(key);
    const entryB = b.get(key);
    if (!entryA || !entryB) {
      // A whole-table divergence already covers this column; a per-column
      // "absent" line here would be exactly the N-lines-per-table noise the
      // table-level check above exists to avoid.
      if (entryA && !tablesB.has(entryA.table)) continue;
      if (entryB && !tablesA.has(entryB.table)) continue;
      if (!entryA) lines.push(`${key}: absent in ${aLabel}`);
      else lines.push(`${key}: absent in ${bLabel}`);
      continue;
    }
    if (entryA.type !== entryB.type) {
      lines.push(`${key}: type mismatch — ${aLabel}=${entryA.type}, ${bLabel}=${entryB.type}`);
    }
    if (entryA.nullable !== entryB.nullable) {
      lines.push(`${key}: nullable mismatch — ${aLabel}=${entryA.nullable}, ${bLabel}=${entryB.nullable}`);
    }
    if (entryA.default !== entryB.default) {
      lines.push(`${key}: default mismatch — ${aLabel}=${entryA.default}, ${bLabel}=${entryB.default}`);
    }
  }

  if (lines.length > 0) {
    throw new Error(lines.sort().join("\n"));
  }
}
