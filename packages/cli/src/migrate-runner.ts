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

function migrationsRoot(): string {
  return resolve(process.cwd(), MIGRATIONS_DIR);
}

function loadSnapshot(): ResolvedSchema | null {
  const p = join(migrationsRoot(), SNAPSHOT_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as ResolvedSchema;
}

function saveSnapshot(schema: ResolvedSchema): void {
  mkdirSync(migrationsRoot(), { recursive: true });
  writeFileSync(join(migrationsRoot(), SNAPSHOT_FILE), JSON.stringify(schema, null, 2));
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "migration";
}

function listMigrationDirs(): string[] {
  const root = migrationsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

async function ensureHistory(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
       id serial PRIMARY KEY,
       name text NOT NULL UNIQUE,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );
}

async function appliedMigrations(client: pg.Client): Promise<Set<string>> {
  const result = await client.query(`SELECT name FROM "${HISTORY_TABLE}"`);
  return new Set(result.rows.map((r: { name: string }) => r.name));
}

/**
 * Ordered migration names, in the order `_indigo_migrations` actually
 * recorded them (`ORDER BY id`) — this is `buildShadowSchema`'s `recorded`
 * input, distinct from `appliedMigrations`'s unordered `Set` (which
 * `migrateDeploy`/`migrateStatus` still use for membership checks only).
 */
async function recordedMigrations(client: pg.Client): Promise<string[]> {
  const result = await client.query(`SELECT name FROM "${HISTORY_TABLE}" ORDER BY id`);
  return result.rows.map((r: { name: string }) => r.name);
}

/**
 * Builds `buildShadowSchema`'s I/O-injection seam from the real filesystem:
 * `onDisk` from `listMigrationDirs()`, `read` from `migrations/<id>/migration.sql`.
 */
function fsMigrationSource(recorded: string[]): MigrationSource {
  return {
    recorded,
    onDisk: listMigrationDirs(),
    read: (id: string) => readFileSync(join(migrationsRoot(), id, "migration.sql"), "utf-8"),
  };
}

export interface DevOptions {
  resolved: ResolvedSchema;
  name: string;
  connectionString: string;
}

/**
 * Applies one migration file's SQL, leaving the transaction OPEN for the
 * caller to record history and commit.
 *
 * Statements marked pre-transaction run first, each as its own `query()`
 * call: `pg`'s simple query protocol wraps a multi-statement string in an
 * implicit transaction, so batching them would put `ALTER TYPE ... ADD VALUE`
 * back inside a transaction and defeat the split. A file carrying no marker
 * yields no pre-transaction statements, so migrations written before this
 * existed keep behaving exactly as they did.
 */
async function applyMigrationSql(client: pg.Client, sql: string): Promise<void> {
  const { preTransaction, transactional } = splitMigrationSql(sql);
  for (const statement of preTransaction) await client.query(statement);
  await client.query("BEGIN");
  if (transactional.trim().length > 0) await client.query(transactional);
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
async function resolvePrevSchema(client: pg.Client): Promise<ResolvedSchema | null> {
  if (process.env.INDIGODB_MIGRATE_PREV === "snapshot") {
    return loadSnapshot();
  }
  const recorded = await recordedMigrations(client);
  const source = fsMigrationSource(recorded);
  return buildShadowSchema(source, {
    onWarning: (message) => console.warn(`⚠️  ${message}`),
  });
}

/** Creates a migration from schema changes and applies it. */
export async function migrateDev(options: DevOptions): Promise<void> {
  const client = new pg.Client({ connectionString: options.connectionString });
  try {
    await client.connect();
    await ensureHistory(client);

    let prev: ResolvedSchema | null;
    try {
      prev = await resolvePrevSchema(client);
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
    const dir = join(migrationsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const sql = renderMigrationSql(plan);
    writeFileSync(join(dir, "migration.sql"), sql);

    try {
      await applyMigrationSql(client, sql);
      await client.query(`INSERT INTO "${HISTORY_TABLE}" (name) VALUES ($1)`, [id]);
      await client.query("COMMIT");
      saveSnapshot(options.resolved);
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
export async function migrateDeploy(connectionString: string): Promise<void> {
  const dirs = listMigrationDirs();
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await ensureHistory(client);
    const applied = await appliedMigrations(client);
    const pending = dirs.filter((d) => !applied.has(d));
    if (pending.length === 0) {
      console.log("✅ No pending migrations.");
      return;
    }
    for (const id of pending) {
      const sql = readFileSync(join(migrationsRoot(), id, "migration.sql"), "utf-8");
      await applyMigrationSql(client, sql);
      await client.query(`INSERT INTO "${HISTORY_TABLE}" (name) VALUES ($1)`, [id]);
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
export async function migrateStatus(connectionString: string): Promise<void> {
  const dirs = listMigrationDirs();
  if (dirs.length === 0) {
    console.log("No migrations yet. Run `indigodb migrate dev --name init`.");
    return;
  }
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await ensureHistory(client);
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
