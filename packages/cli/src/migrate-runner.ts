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
import { diffResolved, renderMigrationSql } from "@indigodb/migrator";
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

export interface DevOptions {
  resolved: ResolvedSchema;
  name: string;
  connectionString: string;
}

/** Creates a migration from schema changes and applies it. */
export async function migrateDev(options: DevOptions): Promise<void> {
  const prev = loadSnapshot();
  const stmts = diffResolved(prev, options.resolved);
  if (stmts.length === 0) {
    console.log("✅ No schema changes — database is up to date.");
    return;
  }

  const id = `${timestamp()}_${slugify(options.name)}`;
  const dir = join(migrationsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const sql = renderMigrationSql(prev, options.resolved);
  writeFileSync(join(dir, "migration.sql"), sql);

  const client = new pg.Client({ connectionString: options.connectionString });
  try {
    await client.connect();
    await ensureHistory(client);
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(`INSERT INTO "${HISTORY_TABLE}" (name) VALUES ($1)`, [id]);
    await client.query("COMMIT");
    saveSnapshot(options.resolved);
    console.log(`✅ Migration created and applied: ${id}`);
    console.log(`   ${stmts.length} statement(s) → migrations/${id}/migration.sql`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    rmSync(dir, { recursive: true, force: true }); // discard the failed migration file
    console.error("❌ Migration failed, rolled back:", (error as Error).message);
    process.exitCode = 1;
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
      await client.query("BEGIN");
      await client.query(sql);
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
