/**
 * @indigodb/migrator — Shadow-replay diff source
 *
 * `buildShadowSchema` reconstructs the `ResolvedSchema` that `migrateDev`
 * diffs against, by replaying every recorded migration file — in the order
 * the database actually applied them — into an isolated, throwaway
 * PostgreSQL instance, then introspecting THAT (`introspectResolvedSchema`,
 * `introspect.ts`). It never introspects the real target database directly:
 * the real DB may hold objects IndigoDB never created (design decision #2,
 * `sdd/shadow-replay-diff/design`), and diffing against those would emit
 * destructive DDL for them. Replay yields exactly the state IndigoDB itself
 * is responsible for.
 *
 * `_indigo_migrations` records NAMES, not checksums — there is no stronger
 * signal than "recorded" vs. "on disk" to detect a desynced migrations
 * directory, so `buildShadowSchema` treats every mismatch between those two
 * sets as a hard refusal (`ShadowReplayError`) rather than guessing.
 *
 * I/O-injected by design: this module never touches `node:fs`, `pg`, or
 * `process.cwd()` directly. `MigrationSource` is the seam — the caller
 * (`@indigodb/cli`'s `migrate-runner.ts`) supplies recorded history, the
 * on-disk directory listing, and a file reader. The shadow database itself
 * is built via `@electric-sql/pglite`, loaded with `await import(...)`
 * inside the default `createShadow` so `db push`/`generate`/`migrate
 * deploy`/`migrate status` — none of which call this function — never pay
 * WASM instantiation cost merely by depending on this package.
 */

import type { ResolvedSchema } from "@indigodb/core";
import { splitMigrationSql } from "./plan.js";
import { introspectResolvedSchema, type IntrospectionQuery } from "./introspect.js";

/**
 * Everything `buildShadowSchema` needs to know about the project's
 * migrations, supplied by the caller instead of read directly — this is
 * the I/O injection seam that keeps `shadow.ts` free of `node:fs`.
 */
export interface MigrationSource {
  /** Migration ids in the order `_indigo_migrations` recorded them (`ORDER BY id`). */
  recorded: string[];
  /** Migration directory names under `migrations/`, sorted lexicographically. */
  onDisk: string[];
  /** Reads `migrations/<id>/migration.sql`'s contents for the given id. */
  read(id: string): string;
}

/**
 * A live database connection sufficient to replay migration SQL and then
 * introspect the result. Satisfied by a thin wrapper around
 * `@electric-sql/pglite`'s `PGlite` (the default `createShadow`), or by any
 * test double a caller injects via `options.createShadow`.
 */
export interface ShadowDb {
  exec(sql: string): Promise<unknown>;
  query: IntrospectionQuery;
  close(): Promise<void>;
}

/**
 * Thrown when `MigrationSource`'s recorded history and on-disk directory
 * listing disagree in a way that cannot be safely replayed. `ids` names the
 * exact migration ids responsible, so a caller (or a human reading the
 * error) never has to re-derive which ones from the message text alone.
 */
export class ShadowReplayError extends Error {
  readonly ids: string[];

  constructor(message: string, ids: string[]) {
    super(message);
    this.name = "ShadowReplayError";
    this.ids = ids;
  }
}

export interface BuildShadowSchemaOptions {
  /**
   * Called when replay proceeds despite a NON-fatal desync (recorded order
   * differs from on-disk lexicographic order, over an otherwise identical
   * set of ids). Never called on a refusal — those throw `ShadowReplayError`
   * instead.
   */
  onWarning?: (message: string) => void;
  /**
   * Builds the throwaway database replay runs against. Defaults to a
   * `@electric-sql/pglite`-backed instance, dynamically imported so callers
   * that never invoke `buildShadowSchema` never pay WASM instantiation
   * cost. Tests inject a double here to exercise the desync/refusal paths
   * without touching PGlite at all.
   */
  createShadow?: () => Promise<ShadowDb>;
}

const EMPTY_SCHEMA: ResolvedSchema = { tables: [], enums: [], tableGroups: [] };

async function defaultCreateShadow(): Promise<ShadowDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  return {
    exec: (sql: string) => db.exec(sql),
    query: (sql: string, params?: unknown[]) => db.query(sql, params),
    close: () => db.close(),
  };
}

/**
 * Applies one migration file's SQL against a `ShadowDb`, mirroring
 * `@indigodb/cli`'s `applyMigrationSql` and `pg-harness.mjs`'s `applyPlan`
 * EXACTLY: pre-transaction statements run first, each as its own call, then
 * the transactional body runs inside one `BEGIN`/`COMMIT`. The phase
 * decision always comes from the shipped `splitMigrationSql` — never
 * re-derived here.
 */
async function replayOne(db: ShadowDb, sql: string): Promise<void> {
  const { preTransaction, transactional } = splitMigrationSql(sql);
  for (const statement of preTransaction) await db.exec(statement);
  if (transactional.trim().length > 0) {
    await db.exec(`BEGIN;\n${transactional}\nCOMMIT;`);
  }
}

/**
 * Reconstructs the `ResolvedSchema` `migrateDev` should diff against, by
 * replaying `source`'s recorded migrations — in the order the database
 * actually applied them — into an isolated shadow database, then
 * introspecting it.
 *
 * Desync rules (no checksums exist; `recorded` vs. `onDisk` are the only
 * signals):
 * - A recorded id with no matching on-disk directory REFUSES
 *   (`ShadowReplayError` naming the missing id(s)) — the migrations
 *   directory is missing files the database's history depends on.
 * - An on-disk directory not present in `recorded` (a PENDING migration)
 *   REFUSES, pointing at `indigodb migrate deploy` — applying it silently
 *   as part of `dev` would diverge from what `deploy` would have done.
 * - Over an otherwise IDENTICAL set of ids, `recorded` order differing from
 *   `onDisk`'s lexicographic order WARNS (via `options.onWarning`) and
 *   replays in `recorded` order — that is the order that reproduces the
 *   actual database.
 * - An empty `recorded` history (and therefore empty `onDisk`, once the
 *   rules above pass) yields an empty `ResolvedSchema` without touching a
 *   database at all.
 */
export async function buildShadowSchema(
  source: MigrationSource,
  options: BuildShadowSchemaOptions = {},
): Promise<ResolvedSchema> {
  const { recorded, onDisk } = source;
  const onDiskSet = new Set(onDisk);
  const recordedSet = new Set(recorded);

  const missingOnDisk = recorded.filter((id) => !onDiskSet.has(id));
  if (missingOnDisk.length > 0) {
    throw new ShadowReplayError(
      `shadow replay refused: ${missingOnDisk.length} migration(s) recorded as applied are missing from the migrations/ directory: ${missingOnDisk.join(", ")}`,
      missingOnDisk,
    );
  }

  const pending = onDisk.filter((id) => !recordedSet.has(id));
  if (pending.length > 0) {
    throw new ShadowReplayError(
      `shadow replay refused: ${pending.length} migration(s) exist on disk but are not recorded as applied: ${pending.join(", ")}. Run \`indigodb migrate deploy\` to apply pending migrations before running \`migrate dev\` again.`,
      pending,
    );
  }

  if (recorded.length === 0) {
    return EMPTY_SCHEMA;
  }

  const isReordered = recorded.some((id, i) => id !== onDisk[i]);
  if (isReordered) {
    options.onWarning?.(
      `shadow replay: recorded migration order differs from the on-disk lexicographic order — replaying in the RECORDED (actual database history) order: ${recorded.join(", ")}`,
    );
  }

  const createShadow = options.createShadow ?? defaultCreateShadow;
  const db = await createShadow();
  try {
    for (const id of recorded) {
      await replayOne(db, source.read(id));
    }
    return await introspectResolvedSchema(db.query);
  } finally {
    await db.close();
  }
}
