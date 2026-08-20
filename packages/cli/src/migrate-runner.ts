/**
 * @indigodb/cli — Migration runner
 *
 * Manages versioned migrations on disk (`migrations/<timestamp>_<name>/migration.sql`),
 * a schema snapshot used to diff the next migration (`migrations/.snapshot.json`),
 * and a `_indigo_migrations` history table in the database.
 *
 * `dev` creates + applies a migration from the current schema; `deploy` applies
 * pending migration files (for CI/production); `status` lists applied/pending.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import pg from "pg";
import {
  planMigration,
  renderMigrationSql,
  splitMigrationSql,
  buildShadowSchema,
  ShadowReplayError,
} from "@indigodb/migrator";
import type { MigrationSource } from "@indigodb/migrator";
import type { ResolvedSchema } from "@indigodb/core";

const MIGRATIONS_DIR = "migrations";
const SNAPSHOT_FILE = ".snapshot.json";
const HISTORY_TABLE = "_indigo_migrations";

/**
 * A live database connection sufficient to run the migration runner's DDL,
 * history bookkeeping and migration SQL. Satisfied by a thin wrapper around
 * `pg.Client` (the default `createClient`), or by any test double a caller
 * injects via `RunnerSeams.createClient` — e.g. a PGlite adapter in
 * `migrate-harness.mjs`, mirroring `@indigodb/migrator`'s `ShadowDb` seam.
 */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  /** Multi-statement body (no params) — e.g. a migration file's transactional block. */
  exec(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Injectable seams: `createClient` overrides how the runner obtains a
 * connected `MigrationClient` (defaults to a real, connected `pg.Client`);
 * `cwd` overrides where `migrations/` is resolved from (defaults to
 * `process.cwd()`). Threaded through `migrateDev`'s `DevOptions`,
 * `migrateDeploy` and `migrateStatus` so tests never need `process.chdir`
 * or a real Postgres connection.
 */
export interface RunnerSeams {
  createClient?: () => Promise<MigrationClient>;
  cwd?: string;
}

function migrationsRoot(cwd: string): string {
  return resolve(cwd, MIGRATIONS_DIR);
}

function loadSnapshot(cwd: string): ResolvedSchema | null {
  const p = join(migrationsRoot(cwd), SNAPSHOT_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as ResolvedSchema;
}

function saveSnapshot(schema: ResolvedSchema, cwd: string): void {
  mkdirSync(migrationsRoot(cwd), { recursive: true });
  writeFileSync(join(migrationsRoot(cwd), SNAPSHOT_FILE), JSON.stringify(schema, null, 2));
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "migration";
}

function listMigrationDirs(cwd: string): string[] {
  const root = migrationsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** sha256 hex of `migration.sql`'s exact bytes — no newline/whitespace normalization. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function defaultCreateClient(connectionString: string): Promise<MigrationClient> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
    exec: (sql: string) => client.query(sql),
    end: () => client.end(),
  };
}

/**
 * Idempotent DDL + silent legacy upgrade. Fresh install: creates the full
 * 5-column shape in one statement. Existing (pre-checksum) table: the two
 * `ADD COLUMN IF NOT EXISTS` statements are no-ops on a fresh table and
 * upgrade a legacy one in place. Backfill then hashes every unbackfilled
 * row's on-disk `migration.sql` (silently, no prompt/output) — a row whose
 * file is missing is left `NULL`, deferred to the existing shadow-replay
 * desync rules rather than guessed at here. A second call is a no-op: the
 * `WHERE checksum IS NULL` selection is empty once backfill has run once.
 */
async function ensureHistory(client: MigrationClient, cwd: string): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
       id serial PRIMARY KEY,
       name text NOT NULL UNIQUE,
       applied_at timestamptz NOT NULL DEFAULT now(),
       checksum text,
       success boolean NOT NULL DEFAULT true
     );`,
  );
  await client.query(`ALTER TABLE "${HISTORY_TABLE}" ADD COLUMN IF NOT EXISTS checksum text;`);
  await client.query(
    `ALTER TABLE "${HISTORY_TABLE}" ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true;`,
  );

  const root = migrationsRoot(cwd);
  const { rows } = await client.query(
    `SELECT name FROM "${HISTORY_TABLE}" WHERE checksum IS NULL ORDER BY id`,
  );
  for (const row of rows as { name: string }[]) {
    const file = join(root, row.name, "migration.sql");
    if (!existsSync(file)) continue; // left NULL — existing desync rules own missing files
    const checksum = migrationChecksum(readFileSync(file, "utf-8"));
    await client.query(
      `UPDATE "${HISTORY_TABLE}" SET checksum = $1 WHERE name = $2 AND checksum IS NULL`,
      [checksum, row.name],
    );
  }
}

async function appliedMigrations(client: MigrationClient): Promise<Set<string>> {
  const result = await client.query(`SELECT name FROM "${HISTORY_TABLE}"`);
  return new Set(result.rows.map((r: { name: string }) => r.name));
}

/**
 * Ordered migration names, in the order `_indigo_migrations` actually
 * recorded them (`ORDER BY id`) — this is `buildShadowSchema`'s `recorded`
 * input, distinct from `appliedMigrations`'s unordered `Set` (which
 * `migrateDeploy`/`migrateStatus` still use for membership checks only).
 */
async function recordedMigrations(client: MigrationClient): Promise<string[]> {
  const result = await client.query(`SELECT name FROM "${HISTORY_TABLE}" ORDER BY id`);
  return result.rows.map((r: { name: string }) => r.name);
}

/**
 * Builds `buildShadowSchema`'s I/O-injection seam from the real filesystem:
 * `onDisk` from `listMigrationDirs()`, `read` from `migrations/<id>/migration.sql`.
 */
function fsMigrationSource(recorded: string[], cwd: string): MigrationSource {
  return {
    recorded,
    onDisk: listMigrationDirs(cwd),
    read: (id: string) => readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8"),
  };
}

export interface DevOptions {
  resolved: ResolvedSchema;
  name: string;
  connectionString: string;
  createClient?: () => Promise<MigrationClient>;
  cwd?: string;
}

/**
 * Applies one migration file's SQL, leaving the transaction OPEN for the
 * caller to record history and commit.
 *
 * Statements marked pre-transaction run first, each as its own `query()`
 * call: batching them would put `ALTER TYPE ... ADD VALUE` back inside a
 * transaction and defeat the split. The transactional body runs through
 * `exec()` rather than `query()` — it may itself be a multi-statement
 * string, which `MigrationClient.query`'s single-statement `$n`-param
 * contract does not promise to support (PGlite, notably, does not). A file
 * carrying no marker yields no pre-transaction statements, so migrations
 * written before this existed keep behaving exactly as they did.
 */
async function applyMigrationSql(client: MigrationClient, sql: string): Promise<void> {
  const { preTransaction, transactional } = splitMigrationSql(sql);
  for (const statement of preTransaction) await client.query(statement);
  await client.query("BEGIN");
  if (transactional.trim().length > 0) await client.exec(transactional);
}

/**
 * Resolves the schema `migrateDev` diffs against. Shadow-replay (default):
 * connects, reads `_indigo_migrations` in RECORDED order, replays every
 * migration file into an isolated shadow database, and introspects it —
 * this is what the target database actually looks like, independent of
 * `.snapshot.json`. `INDIGODB_MIGRATE_PREV=snapshot` is the escape hatch:
 * it keeps the OLD `loadSnapshot()` path reachable — a one-line revert, and
 * the only way to adopt an existing `db push`-managed database (tables
 * exist, history is empty — a case shadow replay legitimately refuses,
 * since it has no migration to replay to reach that state).
 */
async function resolvePrevSchema(client: MigrationClient, cwd: string): Promise<ResolvedSchema | null> {
  if (process.env.INDIGODB_MIGRATE_PREV === "snapshot") {
    return loadSnapshot(cwd);
  }
  const recorded = await recordedMigrations(client);
  const source = fsMigrationSource(recorded, cwd);
  return buildShadowSchema(source, {
    onWarning: (message) => console.warn(`⚠️  ${message}`),
  });
}

/** Creates a migration from schema changes and applies it. */
export async function migrateDev(options: DevOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const client = await (options.createClient ?? (() => defaultCreateClient(options.connectionString)))();
  try {
    await ensureHistory(client, cwd);

    let prev: ResolvedSchema | null;
    try {
      prev = await resolvePrevSchema(client, cwd);
    } catch (error) {
      if (error instanceof ShadowReplayError) {
        console.error(`❌ ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    // One diff, one plan: the plan carries the statements, their execution
    // phase and any blocking diagnostics, so nothing below re-derives it.
    const plan = planMigration(prev, options.resolved);

    if (plan.diagnostics.length > 0) {
      console.error("❌ Cannot generate a migration for this schema change:");
      for (const d of plan.diagnostics) console.error(`   • ${d.message}`);
      process.exitCode = 1;
      return;
    }

    if (plan.statements.length === 0) {
      console.log("✅ No schema changes — database is up to date.");
      return;
    }

    const id = `${timestamp()}_${slugify(options.name)}`;
    const dir = join(migrationsRoot(cwd), id);
    mkdirSync(dir, { recursive: true });
    const sql = renderMigrationSql(plan);
    writeFileSync(join(dir, "migration.sql"), sql);

    try {
      await applyMigrationSql(client, sql);
      const checksum = migrationChecksum(sql);
      await client.query(
        `INSERT INTO "${HISTORY_TABLE}" (name, checksum, success) VALUES ($1, $2, $3)`,
        [id, checksum, true],
      );
      await client.query("COMMIT");
      saveSnapshot(options.resolved, cwd);
      console.log(`✅ Migration created and applied: ${id}`);
      console.log(`   ${plan.statements.length} statement(s) → migrations/${id}/migration.sql`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      rmSync(dir, { recursive: true, force: true }); // discard the failed migration file
      console.error("❌ Migration failed, rolled back:", (error as Error).message);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

/** Applies all pending migration files (production/CI). */
export async function migrateDeploy(connectionString: string, seams: RunnerSeams = {}): Promise<void> {
  const cwd = seams.cwd ?? process.cwd();
  const dirs = listMigrationDirs(cwd);
  const client = await (seams.createClient ?? (() => defaultCreateClient(connectionString)))();
  try {
    await ensureHistory(client, cwd);
    const applied = await appliedMigrations(client);
    const pending = dirs.filter((d) => !applied.has(d));
    if (pending.length === 0) {
      console.log("✅ No pending migrations.");
      return;
    }
    for (const id of pending) {
      const sql = readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8");
      await applyMigrationSql(client, sql);
      const checksum = migrationChecksum(sql);
      await client.query(
        `INSERT INTO "${HISTORY_TABLE}" (name, checksum, success) VALUES ($1, $2, $3)`,
        [id, checksum, true],
      );
      await client.query("COMMIT");
      console.log(`  ✓ applied ${id}`);
    }
    console.log(`✅ Applied ${pending.length} migration(s).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Deploy failed, rolled back:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

/** Lists migrations and whether each has been applied. */
export async function migrateStatus(connectionString: string, seams: RunnerSeams = {}): Promise<void> {
  const cwd = seams.cwd ?? process.cwd();
  const dirs = listMigrationDirs(cwd);
  if (dirs.length === 0) {
    console.log("No migrations yet. Run `indigodb migrate dev --name init`.");
    return;
  }
  const client = await (seams.createClient ?? (() => defaultCreateClient(connectionString)))();
  try {
    await ensureHistory(client, cwd);
    const applied = await appliedMigrations(client);
    for (const id of dirs) {
      console.log(`  ${applied.has(id) ? "✓ applied" : "· pending"}  ${id}`);
    }
    const pending = dirs.filter((d) => !applied.has(d)).length;
    console.log(`\n${dirs.length} migration(s), ${pending} pending.`);
  } finally {
    await client.end();
  }
}
