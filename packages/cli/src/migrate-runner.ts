/**
 * @indigodb/cli — Migration runner
 *
 * Manages versioned migrations on disk (`migrations/<timestamp>_<name>/migration.sql`),
 * a schema snapshot used to diff the next migration (`migrations/.snapshot.json`),
 * and a `_indigo_migrations` history table in the database. The history table
 * also carries a sha256 `checksum` per row (`migrationChecksum`, `node:crypto`),
 * enforced two ways: `dev` refuses via shadow-replay's 4th desync rule
 * (`buildShadowSchema`/`ShadowReplayError`) when a recorded migration's
 * on-disk content has drifted, and `deploy` runs its own `checksumPreflight`
 * before applying any pending migration, refusing (no throw, `process.exitCode
 * = 1`) on the same drift. `status` reports drift too, but only as a
 * non-fatal diagnostic (`⚠ modified`) — it never sets `process.exitCode`.
 *
 * `dev` creates + applies a migration from the current schema; `deploy` applies
 * pending migration files (for CI/production); `status` lists applied/pending.
 * `deploy` also serializes concurrent runs against the same database via a
 * session-level `pg_try_advisory_lock`, deploy-only. `resolve` manually
 * reconciles `_indigo_migrations` (`--applied <id>` / `--rolled-back <id>`)
 * without ever executing migration SQL or touching `.snapshot.json`, and
 * takes no advisory lock (deploy-only lock, unaffected).
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
  scanRequiresForce,
} from "@indigodb/migrator";
import type { MigrationSource } from "@indigodb/migrator";
import type { ResolvedSchema } from "@indigodb/core";

const MIGRATIONS_DIR = "migrations";
const SNAPSHOT_FILE = ".snapshot.json";
const HISTORY_TABLE = "_indigo_migrations";

/**
 * The single statement every history write goes through.
 *
 * `installed_by` is `current_user`, evaluated server-side: it is the role
 * Postgres authenticated, not a value this process chose, so it cannot claim an
 * identity the database would not confirm. Nothing here accepts a caller-
 * supplied name — an override would be a self-reported claim wearing the same
 * column as a database-enforced fact.
 *
 * `ON CONFLICT (name) DO UPDATE` rather than a plain INSERT because `name` is
 * UNIQUE and a migration may legitimately be written twice: retrying one that
 * previously recorded a failure has to replace that row, not collide with it.
 * `applied_at` is refreshed so the timestamp describes the attempt that
 * actually stands, not the one that failed.
 */
const HISTORY_UPSERT = `INSERT INTO "${HISTORY_TABLE}"
     (name, checksum, success, installed_by, execution_time_ms)
   VALUES ($1, $2, $3, current_user, $4)
   ON CONFLICT (name) DO UPDATE SET
     checksum = EXCLUDED.checksum,
     success = EXCLUDED.success,
     installed_by = EXCLUDED.installed_by,
     execution_time_ms = EXCLUDED.execution_time_ms,
     applied_at = now()`;

/**
 * Session-level advisory-lock key `migrateDeploy` uses to serialize
 * concurrent deploys against the same database. `0x494E4449474F` = ASCII
 * "INDIGO" — a fixed, non-configurable, per-database key (advisory locks
 * never cross databases, and the connection string already scopes to one).
 */
export const MIGRATION_LOCK_KEY = 80_600_501_929_807;

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
 * Idempotent DDL: one `CREATE TABLE IF NOT EXISTS` carrying the full column
 * set, and nothing else.
 *
 * There is deliberately no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and no
 * checksum backfill loop. Both existed to upgrade a table created by an older
 * version in place — but nothing has ever been published (v0.0.1), so there is
 * no installed base to upgrade, and carrying that machinery would mean
 * shipping a migration path for a version that never shipped.
 *
 * The consequence is worth stating: a table created by an older local build is
 * left exactly as it is. It is not widened, and a write naming a column it does
 * not have fails loudly rather than being silently repaired. That is the
 * intended behaviour, not an oversight — drop the table and let this recreate
 * it.
 */
async function ensureHistory(client: MigrationClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
       id serial PRIMARY KEY,
       name text NOT NULL UNIQUE,
       applied_at timestamptz NOT NULL DEFAULT now(),
       checksum text,
       success boolean NOT NULL DEFAULT true,
       installed_by text,
       execution_time_ms integer
     );`,
  );
}

async function appliedMigrations(client: MigrationClient): Promise<Set<string>> {
  const result = await client.query(`SELECT name FROM "${HISTORY_TABLE}"`);
  return new Set(result.rows.map((r: { name: string }) => r.name));
}

/**
 * Recomputes + compares checksums for every already-recorded migration
 * against its current on-disk `migration.sql`, BEFORE `migrateDeploy` applies
 * any pending migration. A `null` stored checksum (legacy, unbackfilled)
 * skips comparison for that id. Returns the drifted ids, if any — empty
 * means clean. Missing on-disk files are not this function's concern (they
 * would already fail to read when the id is later replayed/read elsewhere);
 * this only compares ids whose file it can read.
 */
async function checksumPreflight(client: MigrationClient, cwd: string): Promise<string[]> {
  const { recorded, checksums } = await recordedMigrations(client);
  const drifted: string[] = [];
  for (const id of recorded) {
    const stored = checksums[id];
    if (stored == null) continue;
    const file = join(migrationsRoot(cwd), id, "migration.sql");
    if (!existsSync(file)) continue;
    const current = migrationChecksum(readFileSync(file, "utf-8"));
    if (current !== stored) drifted.push(id);
  }
  return drifted;
}

/**
 * Ordered migration names + their recorded checksums, in the order
 * `_indigo_migrations` actually recorded them (`ORDER BY id`). `recorded` is
 * `buildShadowSchema`'s `recorded` input, distinct from `appliedMigrations`'s
 * unordered `Set` (which `migrateDeploy`/`migrateStatus` still use for
 * membership checks only). `checksums` maps each recorded id to its stored
 * checksum — `null` for a legacy row not yet backfilled.
 */
async function recordedMigrations(
  client: MigrationClient,
): Promise<{ recorded: string[]; checksums: Record<string, string | null> }> {
  const result = await client.query(`SELECT name, checksum FROM "${HISTORY_TABLE}" ORDER BY id`);
  const rows = result.rows as { name: string; checksum: string | null }[];
  const checksums: Record<string, string | null> = {};
  for (const row of rows) checksums[row.name] = row.checksum;
  return { recorded: rows.map((r) => r.name), checksums };
}

/**
 * Builds `buildShadowSchema`'s I/O-injection seam from the real filesystem:
 * `onDisk` from `listMigrationDirs()`, `read`/`checksum` from
 * `migrations/<id>/migration.sql`'s current on-disk bytes, `recordedChecksums`
 * from the history table (stored, possibly stale) checksums.
 */
function fsMigrationSource(
  recorded: string[],
  recordedChecksums: Record<string, string | null>,
  cwd: string,
): MigrationSource {
  const readFile = (id: string) => readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8");
  return {
    recorded,
    onDisk: listMigrationDirs(cwd),
    read: readFile,
    checksum: (id: string) => migrationChecksum(readFile(id)),
    recordedChecksums,
  };
}

export interface DevOptions {
  resolved: ResolvedSchema;
  name: string;
  connectionString: string;
  createClient?: () => Promise<MigrationClient>;
  cwd?: string;
  /** Bypasses the requires-force refusal gate — applies destructive statements. */
  force?: boolean;
  /**
   * Plan/apply separation: runs the full pre-flight (connect, ensureHistory,
   * prev resolution, plan, every refusal gate) and writes migration.sql, then
   * skips apply, the history INSERT, COMMIT and saveSnapshot. Still requires
   * a live connection — shadow replay reads `_indigo_migrations`.
   */
  createOnly?: boolean;
}

/**
 * `migrateDeploy`'s seams plus `force`, kept separate from `RunnerSeams`
 * (shared with `migrateStatus`, which has no force concept) so existing
 * call sites and tests keep compiling untouched.
 */
export interface DeployOptions extends RunnerSeams {
  /** Bypasses the requires-force refusal gate — applies destructive statements. */
  force?: boolean;
}

/**
 * `migrateResolve`'s seams: a connection string plus exactly one of
 * `applied`/`rolledBack`, both mutually exclusive. `applied` records a
 * migration as applied (INSERT, checksum computed from on-disk bytes, no SQL
 * executed); `rolledBack` removes its recorded row (DELETE, idempotent
 * no-op if absent).
 */
export interface ResolveOptions extends RunnerSeams {
  connectionString: string;
  /** Migration id (the `migrations/<id>` directory name) to record as applied. */
  applied?: string;
  /** Migration id whose recorded row should be removed. Mutually exclusive with `applied`. */
  rolledBack?: string;
}

/**
 * Prints the shared `❌ … refused: … destructive statement(s).` + bulleted
 * `impacts` + `Re-run with --force to apply them.` shape both `migrateDev`
 * and `migrateDeploy` use — byte-identical between the two commands (Q3).
 */
function printForceRefusal(header: string, impacts: string[]): void {
  console.error(`❌ ${header}`);
  for (const impact of impacts) console.error(`   • ${impact}`);
  console.error("   Re-run with --force to apply them.");
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
  const { recorded, checksums } = await recordedMigrations(client);
  const source = fsMigrationSource(recorded, checksums, cwd);
  return buildShadowSchema(source, {
    onWarning: (message) => console.warn(`⚠️  ${message}`),
  });
}

/**
 * Creates a migration from schema changes and applies it. `options.createOnly`
 * splits this into a pre-flight phase (write migration.sql) and a commit
 * phase (apply/history/snapshot), running only the former.
 */
export async function migrateDev(options: DevOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const client = await (options.createClient ?? (() => defaultCreateClient(options.connectionString)))();
  try {
    await ensureHistory(client);

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

    const destructive = plan.statements.filter(
      (s): s is Extract<(typeof plan.statements)[number], { risk: "requires-force" }> =>
        s.risk === "requires-force",
    );
    if (destructive.length > 0 && !options.force) {
      printForceRefusal(
        `migrate dev refused: this migration contains ${destructive.length} destructive statement(s).`,
        destructive.map((s) => s.impact),
      );
      process.exitCode = 1;
      return;
    }

    const id = `${timestamp()}_${slugify(options.name)}`;
    const dir = join(migrationsRoot(cwd), id);
    mkdirSync(dir, { recursive: true });
    const sql = renderMigrationSql(plan);
    writeFileSync(join(dir, "migration.sql"), sql);

    if (options.createOnly) {
      console.log(`✅ Migration created (not applied): ${id}`);
      console.log(`   ${plan.statements.length} statement(s) → migrations/${id}/migration.sql`);
      console.log("   Apply it with `indigodb migrate dev` or `indigodb migrate deploy`.");
      return;
    }

    try {
      const startedAt = performance.now();
      await applyMigrationSql(client, sql);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const checksum = migrationChecksum(sql);
      await client.query(HISTORY_UPSERT, [id, checksum, true, elapsedMs]);
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
export async function migrateDeploy(connectionString: string, seams: DeployOptions = {}): Promise<void> {
  const cwd = seams.cwd ?? process.cwd();
  const dirs = listMigrationDirs(cwd);
  const client = await (seams.createClient ?? (() => defaultCreateClient(connectionString)))();
  let locked = false;
  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    if (!lockResult.rows[0]?.pg_try_advisory_lock) {
      console.error("❌ migrate deploy refused: another deploy already holds the migration lock");
      process.exitCode = 1;
      return;
    }
    locked = true;

    await ensureHistory(client);

    const drifted = await checksumPreflight(client, cwd);
    if (drifted.length > 0) {
      console.error(
        `❌ migrate deploy refused: ${drifted.length} already-applied migration(s) no longer match their on-disk content: ${drifted.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    const applied = await appliedMigrations(client);
    const pending = dirs.filter((d) => !applied.has(d));
    if (pending.length === 0) {
      console.log("✅ No pending migrations.");
      return;
    }

    // Pre-scan ALL pending files before applying any: a per-file gate would
    // apply file 1 then refuse file 2, leaving a half-migrated database.
    const destructiveFiles: { id: string; impacts: string[] }[] = [];
    for (const id of pending) {
      const sql = readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8");
      const impacts = scanRequiresForce(sql);
      if (impacts.length > 0) destructiveFiles.push({ id, impacts });
    }
    if (destructiveFiles.length > 0 && !seams.force) {
      const allImpacts = destructiveFiles.flatMap((f) => f.impacts);
      const subject = destructiveFiles.map((f) => f.id).join(", ");
      printForceRefusal(
        `migrate deploy refused: ${subject} contains ${allImpacts.length} destructive statement(s).`,
        allImpacts,
      );
      process.exitCode = 1;
      return;
    }

    for (const id of pending) {
      const sql = readFileSync(join(migrationsRoot(cwd), id, "migration.sql"), "utf-8");
      const startedAt = performance.now();
      await applyMigrationSql(client, sql);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const checksum = migrationChecksum(sql);
      await client.query(HISTORY_UPSERT, [id, checksum, true, elapsedMs]);
      await client.query("COMMIT");
      console.log(`  ✓ applied ${id}`);
    }
    console.log(`✅ Applied ${pending.length} migration(s).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Deploy failed, rolled back:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
    await client.end();
  }
}

/**
 * Lists migrations and whether each has been applied, is pending, or has
 * drifted (`⚠ modified` — recorded checksum no longer matches the on-disk
 * file). Drift is a non-fatal diagnostic here: unlike `migrateDeploy`'s
 * preflight, `migrateStatus` never sets `process.exitCode` — it always
 * exits 0, reporting rather than refusing.
 */
export async function migrateStatus(connectionString: string, seams: RunnerSeams = {}): Promise<void> {
  const cwd = seams.cwd ?? process.cwd();
  const dirs = listMigrationDirs(cwd);
  if (dirs.length === 0) {
    console.log("No migrations yet. Run `indigodb migrate dev --name init`.");
    return;
  }
  const client = await (seams.createClient ?? (() => defaultCreateClient(connectionString)))();
  try {
    await ensureHistory(client);
    const applied = await appliedMigrations(client);
    const drifted = new Set(await checksumPreflight(client, cwd));
    for (const id of dirs) {
      const state = drifted.has(id) ? "⚠ modified" : applied.has(id) ? "✓ applied" : "· pending";
      console.log(`  ${state}  ${id}`);
    }
    const pending = dirs.filter((d) => !applied.has(d)).length;
    console.log(`\n${dirs.length} migration(s), ${pending} pending.`);
  } finally {
    await client.end();
  }
}

/**
 * Reconciles `_indigo_migrations` manually — without executing any migration
 * SQL, without touching `.snapshot.json`, and without opening a transaction
 * or taking the deploy-only advisory lock. `--applied <id>` INSERTs a row
 * (checksum from on-disk bytes, `success = true`), is an idempotent no-op if
 * an identical row already exists, and REFUSES (row untouched) if a recorded
 * row's checksum has drifted from disk — resolve never silently re-baselines
 * a drift, it only records or removes ledger entries. `--rolled-back <id>`
 * DELETEs the row, a no-op if absent. Exactly one of the two flags is
 * required; the id is validated against `listMigrationDirs(cwd)` — an exact
 * membership check, so a path-traversal-shaped id is refused before
 * `createClient` is ever invoked.
 */
export async function migrateResolve(options: ResolveOptions): Promise<void> {
  if (options.applied && options.rolledBack) {
    console.error("❌ migrate resolve refused: --applied and --rolled-back are mutually exclusive.");
    process.exitCode = 1;
    return;
  }
  if (!options.applied && !options.rolledBack) {
    console.error(
      "❌ migrate resolve refused: one of --applied <id> or --rolled-back <id> is required.",
    );
    process.exitCode = 1;
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const id = (options.applied ?? options.rolledBack) as string;
  const file = join(migrationsRoot(cwd), id, "migration.sql");
  if (!listMigrationDirs(cwd).includes(id) || !existsSync(file)) {
    console.error(
      `❌ migrate resolve refused: unknown migration id "${id}" — no migrations/${id}/migration.sql on disk.`,
    );
    process.exitCode = 1;
    return;
  }

  const client = await (options.createClient ?? (() => defaultCreateClient(options.connectionString)))();
  try {
    await ensureHistory(client);

    if (options.applied) {
      const { rows } = await client.query(
        `SELECT checksum, success FROM "${HISTORY_TABLE}" WHERE name = $1`,
        [id],
      );
      const recorded = rows[0] as { checksum: string | null; success: boolean } | undefined;
      const computed = migrationChecksum(readFileSync(file, "utf-8"));

      // Branch order is load-bearing (design D7). The drift check sits ABOVE
      // the success/failure split, so a failure row whose file has since been
      // edited is refused rather than flipped to applied without any checksum
      // ever being compared. Moving the success test above it would make
      // `--applied` a way to launder a drifted migration into the history.
      if (recorded === undefined || recorded.checksum == null) {
        // No row at all, or a row that never carried a checksum. Either way
        // there is nothing to compare against, so record it.
        // `execution_time_ms` is null, not 0: no SQL ran, and a zero would read
        // as "applied instantly" rather than "never executed here".
        await client.query(HISTORY_UPSERT, [id, computed, true, null]);
        console.log(`✅ Migration recorded as applied: ${id}`);
        console.log("   No SQL was executed — _indigo_migrations only.");
      } else if (recorded.checksum !== computed) {
        console.error(`❌ migrate resolve refused: ${id} no longer matches its recorded checksum.`);
        console.error("   Revert the on-disk file, or reconcile with --rolled-back first.");
        process.exitCode = 1;
      } else if (recorded.success) {
        console.log(`✅ Already recorded as applied: ${id} — nothing to do.`);
      } else {
        // Matching checksum, recorded failure: this is the documented exit from
        // a failed deploy. The failed attempt's duration is deliberately NOT
        // carried onto the row that now stands.
        await client.query(HISTORY_UPSERT, [id, computed, true, null]);
        console.log(`✅ Migration recorded as applied: ${id}`);
        console.log("   Previously recorded as failed — no SQL was executed.");
      }
    } else {
      const { rows } = await client.query(
        `DELETE FROM "${HISTORY_TABLE}" WHERE name = $1 RETURNING name`,
        [id],
      );
      if (rows.length > 0) {
        console.log(`✅ Migration record removed: ${id}`);
        console.log("   No SQL was executed — _indigo_migrations only.");
      } else {
        console.log(`✅ Not recorded as applied: ${id} — nothing to do.`);
      }
    }
  } finally {
    await client.end();
  }
}
