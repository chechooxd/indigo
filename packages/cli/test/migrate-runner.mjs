/**
 * @indigodb/cli — migration runner suite (first-ever direct coverage of
 * `migrate-runner.ts`). Mirrors `pull.mjs`'s style: plain Node, no test
 * framework, real PGlite via `migrate-harness.mjs` (never a mocked `pg`).
 *
 * Slice 1 (this file, initial cases): `MigrationClient`/`cwd` seams, the
 * new DDL + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` upgrade shape,
 * silent backfill of legacy NULL checksums, and checksum/success recorded
 * on every `migrateDev`/`migrateDeploy` INSERT. NO enforcement yet — that
 * is Slice 2, added to this same file.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { strictEqual, ok } from "node:assert";
import { parse, resolve as resolveSchema } from "@indigodb/core";
import { planMigration, renderMigrationSql } from "@indigodb/migrator";
import {
  migrateDev,
  migrateDeploy,
  migrateStatus,
  migrationChecksum,
  MIGRATION_LOCK_KEY,
} from "../dist/migrate-runner.js";
import {
  withDatabase,
  createMigrationClient,
  createMigrationsRoot,
  spyMigrationClient,
} from "./migrate-harness.mjs";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli migrate-runner: checksum + schema-upgrade suite");

function minimalResolved() {
  const source = `Table User {\n  id Int @id @default(autoincrement())\n  name String\n}\n`;
  return resolveSchema(parse(source));
}

/** Wider shape than `minimalResolved()` — diffing down to it drops 2 columns. */
function wideResolved() {
  const source = `Table User {\n  id Int @id @default(autoincrement())\n  name String\n  email String\n  age Int\n}\n`;
  return resolveSchema(parse(source));
}

/** A pure-DROP-COLUMN migration.sql (2 requires-force statements), rendered with markers. */
function destructiveMigrationSql() {
  const plan = planMigration(wideResolved(), minimalResolved());
  return renderMigrationSql(plan);
}

/** A purely additive migration.sql — no requires-force statements at all. */
function safeMigrationSql() {
  const plan = planMigration(null, minimalResolved());
  return renderMigrationSql(plan);
}

async function historyColumns(db) {
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '_indigo_migrations'`,
  );
  return new Set(result.rows.map((r) => r.column_name));
}

async function historyRows(db) {
  const result = await db.query(
    `SELECT name, checksum, success FROM "_indigo_migrations" ORDER BY id`,
  );
  return result.rows;
}

/** Captures stdout `console.log` calls for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Captures stderr `console.error` calls for the duration of `fn`. */
async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ─── fresh install: full 5-column shape ──────────────────────────────────────

await check("fresh install: ensureHistory creates checksum + success columns", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });
      const columns = await historyColumns(db);
      ok(columns.has("checksum"), `expected a checksum column, got: ${[...columns].join(", ")}`);
      ok(columns.has("success"), `expected a success column, got: ${[...columns].join(", ")}`);
    } finally {
      cleanup();
    }
  });
});

// ─── legacy upgrade: ALTER TABLE ADD COLUMN IF NOT EXISTS ────────────────────

await check("legacy 3-column table: ensureHistory adds checksum + success via ALTER", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      await db.exec(`
        CREATE TABLE "_indigo_migrations" (
          id serial PRIMARY KEY,
          name text NOT NULL UNIQUE,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });
      const columns = await historyColumns(db);
      ok(columns.has("checksum"), `expected checksum added, got: ${[...columns].join(", ")}`);
      ok(columns.has("success"), `expected success added, got: ${[...columns].join(", ")}`);
    } finally {
      cleanup();
    }
  });
});

// ─── silent backfill ──────────────────────────────────────────────────────────

await check("legacy row with NULL checksum is silently backfilled from on-disk SQL", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20240101000000_init";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      const sql = `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`;
      writeFileSync(join(dir, "migration.sql"), sql);

      await db.exec(`
        CREATE TABLE "_indigo_migrations" (
          id serial PRIMARY KEY,
          name text NOT NULL UNIQUE,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO "_indigo_migrations" (name) VALUES ('${id}');
      `);

      await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });

      const rows = await historyRows(db);
      strictEqual(rows.length, 1);
      strictEqual(rows[0].name, id);
      strictEqual(rows[0].checksum, migrationChecksum(sql));
      strictEqual(rows[0].success, true);
    } finally {
      cleanup();
    }
  });
});

await check("backfill is idempotent: a second ensureHistory call touches zero rows", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20240101000000_init";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      const sql = `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`;
      writeFileSync(join(dir, "migration.sql"), sql);

      await db.exec(`
        CREATE TABLE "_indigo_migrations" (
          id serial PRIMARY KEY,
          name text NOT NULL UNIQUE,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO "_indigo_migrations" (name) VALUES ('${id}');
      `);

      const client = () => createMigrationClient(db);
      await migrateDeploy("unused", { createClient: client, cwd });
      const first = await historyRows(db);

      await migrateDeploy("unused", { createClient: client, cwd });
      const second = await historyRows(db);

      strictEqual(first.length, second.length);
      strictEqual(first[0].checksum, second[0].checksum);
    } finally {
      cleanup();
    }
  });
});

await check("legacy row with a missing on-disk file is left NULL, not guessed at", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      await db.exec(`
        CREATE TABLE "_indigo_migrations" (
          id serial PRIMARY KEY,
          name text NOT NULL UNIQUE,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO "_indigo_migrations" (name) VALUES ('20240101000000_gone');
      `);

      await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });

      const rows = await historyRows(db);
      strictEqual(rows.length, 1);
      strictEqual(rows[0].checksum, null);
    } finally {
      cleanup();
    }
  });
});

// ─── migrateDev records checksum + success on INSERT ─────────────────────────

await check("migrateDev records checksum (sha256 of the written file) + success = true", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      await migrateDev({
        resolved: minimalResolved(),
        name: "init",
        connectionString: "unused",
        createClient: async () => createMigrationClient(db),
        cwd,
      });

      const rows = await historyRows(db);
      strictEqual(rows.length, 1);
      ok(rows[0].success === true);

      const sql = readFileSync(join(cwd, "migrations", rows[0].name, "migration.sql"), "utf-8");
      strictEqual(rows[0].checksum, migrationChecksum(sql));
    } finally {
      cleanup();
    }
  });
});

// ─── migrateDeploy records checksum + success per pending migration ──────────

await check("migrateDeploy records checksum + success = true for each pending migration", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20240101000000_init";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      const sql = `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`;
      writeFileSync(join(dir, "migration.sql"), sql);

      await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });

      const rows = await historyRows(db);
      strictEqual(rows.length, 1);
      strictEqual(rows[0].name, id);
      strictEqual(rows[0].checksum, migrationChecksum(sql));
      strictEqual(rows[0].success, true);
    } finally {
      cleanup();
    }
  });
});

// ─── enforcement: migrateDev refuses on checksum drift (Slice 2) ─────────────

await check("migrateDev refuses when an applied migration's on-disk file has drifted", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      await migrateDev({
        resolved: minimalResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });
      const before = await historyRows(db);
      strictEqual(before.length, 1);

      const file = join(cwd, "migrations", before[0].name, "migration.sql");
      writeFileSync(file, readFileSync(file, "utf-8") + "-- drifted edit\n");

      const source = `Table User {\n  id Int @id @default(autoincrement())\n  name String\n  age Int\n}\n`;
      const nextResolved = resolveSchema(parse(source));

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const errors = await captureErrors(() =>
        migrateDev({
          resolved: nextResolved,
          name: "add-age",
          connectionString: "unused",
          createClient: client,
          cwd,
        }),
      );
      const refused = process.exitCode === 1;
      process.exitCode = savedExitCode;

      ok(refused, "expected process.exitCode = 1 on drift refusal");
      ok(
        errors.some((l) => l.includes(before[0].name)),
        `expected the drifted id ${before[0].name} named in the refusal, got: ${errors.join("\n")}`,
      );

      const after = await historyRows(db);
      strictEqual(after.length, 1, "no new migration should be recorded");
    } finally {
      cleanup();
    }
  });
});

// ─── enforcement: migrateDeploy preflight refuses on drift (Slice 2) ─────────

await check(
  "migrateDeploy preflight refuses on a drifted already-recorded migration before applying any pending migration",
  async () => {
    await withDatabase(async (db) => {
      const { cwd, cleanup } = createMigrationsRoot();
      try {
        const client = () => createMigrationClient(db);

        const appliedId = "20240101000000_init";
        const appliedDir = join(cwd, "migrations", appliedId);
        mkdirSync(appliedDir, { recursive: true });
        const appliedSql = `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`;
        writeFileSync(join(appliedDir, "migration.sql"), appliedSql);
        await migrateDeploy("unused", { createClient: client, cwd });

        // Drift the already-applied file.
        writeFileSync(join(appliedDir, "migration.sql"), appliedSql + "-- drifted edit\n");

        // A genuinely pending migration that must NOT get applied.
        const pendingId = "20240102000000_pending";
        const pendingDir = join(cwd, "migrations", pendingId);
        mkdirSync(pendingDir, { recursive: true });
        writeFileSync(join(pendingDir, "migration.sql"), `CREATE TABLE "bar" (id serial PRIMARY KEY);\n`);

        const savedExitCode = process.exitCode;
        process.exitCode = undefined;
        const errors = await captureErrors(() => migrateDeploy("unused", { createClient: client, cwd }));
        const refused = process.exitCode === 1;
        process.exitCode = savedExitCode;

        ok(refused, "expected process.exitCode = 1 on preflight refusal");
        ok(
          errors.some((l) => l.includes(appliedId)),
          `expected the drifted id ${appliedId} named in the refusal, got: ${errors.join("\n")}`,
        );
        ok(
          !errors.some((l) => /rolled back/i.test(l)),
          `expected a preflight refusal message, not a "rolled back" throw-catch message, got: ${errors.join("\n")}`,
        );

        const rows = await historyRows(db);
        strictEqual(rows.length, 1, "the pending migration must not have been applied");
        strictEqual(rows[0].name, appliedId);
      } finally {
        cleanup();
      }
    });
  },
);

await check("migrateDeploy with no drift applies pending migrations normally (regression guard)", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      const appliedId = "20240101000000_init";
      const appliedDir = join(cwd, "migrations", appliedId);
      mkdirSync(appliedDir, { recursive: true });
      writeFileSync(join(appliedDir, "migration.sql"), `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`);
      await migrateDeploy("unused", { createClient: client, cwd });

      const pendingId = "20240102000000_pending";
      const pendingDir = join(cwd, "migrations", pendingId);
      mkdirSync(pendingDir, { recursive: true });
      writeFileSync(join(pendingDir, "migration.sql"), `CREATE TABLE "bar" (id serial PRIMARY KEY);\n`);

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      await migrateDeploy("unused", { createClient: client, cwd });
      const clean = process.exitCode === undefined;
      process.exitCode = savedExitCode;

      ok(clean, "expected process.exitCode to stay untouched when there is no drift");
      const rows = await historyRows(db);
      strictEqual(rows.length, 2, "both migrations should be applied");
    } finally {
      cleanup();
    }
  });
});

// ─── enforcement: migrateStatus reports drift non-fatally (Slice 2) ──────────

await check("migrateStatus prints ⚠ modified for a drifted row and ✓ applied for clean rows, exit 0", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      const cleanId = "20240101000000_clean";
      const cleanDir = join(cwd, "migrations", cleanId);
      mkdirSync(cleanDir, { recursive: true });
      writeFileSync(join(cleanDir, "migration.sql"), `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`);

      const driftedId = "20240102000000_drifted";
      const drifted = join(cwd, "migrations", driftedId);
      mkdirSync(drifted, { recursive: true });
      const drifedSql = `CREATE TABLE "bar" (id serial PRIMARY KEY);\n`;
      writeFileSync(join(drifted, "migration.sql"), drifedSql);

      await migrateDeploy("unused", { createClient: client, cwd });
      writeFileSync(join(drifted, "migration.sql"), drifedSql + "-- drifted edit\n");

      const pendingId = "20240103000000_pending";
      const pendingDir = join(cwd, "migrations", pendingId);
      mkdirSync(pendingDir, { recursive: true });
      writeFileSync(join(pendingDir, "migration.sql"), `CREATE TABLE "baz" (id serial PRIMARY KEY);\n`);

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const lines = await captureLogs(() => migrateStatus("unused", { createClient: client, cwd }));
      const untouched = process.exitCode === undefined;
      process.exitCode = savedExitCode;

      ok(untouched, "migrateStatus must never set process.exitCode, even on drift");
      ok(
        lines.some((l) => l.includes(cleanId) && /✓ applied/.test(l)),
        `expected "✓ applied" for the clean row, got:\n${lines.join("\n")}`,
      );
      ok(
        lines.some((l) => l.includes(driftedId) && /⚠ modified/.test(l)),
        `expected "⚠ modified" for the drifted row, got:\n${lines.join("\n")}`,
      );
      ok(
        lines.some((l) => l.includes(pendingId) && /· pending/.test(l)),
        `expected "· pending" for the not-yet-applied row, got:\n${lines.join("\n")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── advisory lock around `migrate deploy` ────────────────────────────────────
//
// PGlite test-coverage gap (upstream issue #704): `pg_advisory_lock` does not
// actually block on re-acquisition in PGlite, and PGlite is a single
// in-process instance anyway — true racing-connection contention cannot be
// simulated here. These cases assert SQL call sequence, key and ordering via
// `spyMigrationClient` instead of real blocking; real-Postgres contention
// verification stays manual/out of this harness.

await check(
  "migrateDeploy acquires pg_try_advisory_lock first and releases pg_advisory_unlock last",
  async () => {
    await withDatabase(async (db) => {
      const { cwd, cleanup } = createMigrationsRoot();
      try {
        const id = "20240101000000_init";
        const dir = join(cwd, "migrations", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "migration.sql"), `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`);

        const { client: spyClient, queries } = spyMigrationClient(createMigrationClient(db));
        await migrateDeploy("unused", { createClient: async () => spyClient, cwd });

        ok(queries.length > 0, "expected at least one recorded query");
        const first = queries[0];
        ok(
          /pg_try_advisory_lock/.test(first.sql),
          `expected the first query to be pg_try_advisory_lock, got: ${first.sql}`,
        );
        strictEqual(first.params?.[0], MIGRATION_LOCK_KEY);

        const firstHistoryIndex = queries.findIndex((q) => q.sql.includes("_indigo_migrations"));
        ok(firstHistoryIndex > 0, "expected a _indigo_migrations query to follow the lock query");

        const last = queries[queries.length - 1];
        ok(
          /pg_advisory_unlock/.test(last.sql),
          `expected the last query to be pg_advisory_unlock, got: ${last.sql}`,
        );
        strictEqual(last.params?.[0], MIGRATION_LOCK_KEY);
      } finally {
        cleanup();
      }
    });
  },
);

await check("migrateDeploy refuses when the advisory lock is already held (contention)", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20240101000000_init";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), `CREATE TABLE "foo" (id serial PRIMARY KEY);\n`);

      const { client: spyClient, queries } = spyMigrationClient(createMigrationClient(db), {
        onQuery: (sql) => {
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ pg_try_advisory_lock: false }] };
          return undefined;
        },
      });

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const errors = await captureErrors(() =>
        migrateDeploy("unused", { createClient: async () => spyClient, cwd }),
      );
      const refused = process.exitCode === 1;
      process.exitCode = savedExitCode;

      ok(refused, "expected process.exitCode = 1 on lock contention");
      ok(
        errors.some((l) => /lock/i.test(l)),
        `expected the refusal message to name the lock conflict, got: ${errors.join("\n")}`,
      );
      ok(
        !errors.some((l) => /rolled back/i.test(l)),
        "expected a refusal message, not a caught-throw rollback message",
      );

      let historyTableExists = true;
      try {
        await historyRows(db);
      } catch {
        historyTableExists = false;
      }
      ok(
        !historyTableExists,
        "expected ensureHistory to never have run (and thus no migration applied) since the lock refusal happens first",
      );
      ok(
        !queries.some((q) => /pg_advisory_unlock/.test(q.sql)),
        "expected no unlock call since the lock was never acquired",
      );
    } finally {
      cleanup();
    }
  });
});

await check(
  "migrateDeploy still releases the advisory lock when a pending migration fails mid-loop",
  async () => {
    await withDatabase(async (db) => {
      const { cwd, cleanup } = createMigrationsRoot();
      try {
        const id = "20240101000000_bad";
        const dir = join(cwd, "migrations", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "migration.sql"), `THIS IS NOT VALID SQL AT ALL;\n`);

        const { client: spyClient, queries } = spyMigrationClient(createMigrationClient(db));

        const savedExitCode = process.exitCode;
        process.exitCode = undefined;
        const errors = await captureErrors(() =>
          migrateDeploy("unused", { createClient: async () => spyClient, cwd }),
        );
        const failed = process.exitCode === 1;
        process.exitCode = savedExitCode;

        ok(failed, "expected process.exitCode = 1 on the invalid-SQL failure");
        ok(
          errors.some((l) => /rolled back/i.test(l)),
          `expected the existing catch/rollback path message, got: ${errors.join("\n")}`,
        );

        const unlockCalls = queries.filter((q) => /pg_advisory_unlock/.test(q.sql));
        strictEqual(unlockCalls.length, 1, "expected the lock to be released exactly once despite the failure");
        strictEqual(unlockCalls[0].params?.[0], MIGRATION_LOCK_KEY);
      } finally {
        cleanup();
      }
    });
  },
);

await check("migrateDev and migrateStatus never touch the advisory lock (deploy-only scope)", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const { client: devClient, queries: devQueries } = spyMigrationClient(createMigrationClient(db));
      await migrateDev({
        resolved: minimalResolved(),
        name: "init",
        connectionString: "unused",
        createClient: async () => devClient,
        cwd,
      });
      ok(
        !devQueries.some((q) => /advisory/.test(q.sql)),
        "expected migrateDev to never issue an advisory-lock query",
      );

      const { client: statusClient, queries: statusQueries } = spyMigrationClient(createMigrationClient(db));
      await migrateStatus("unused", { createClient: async () => statusClient, cwd });
      ok(
        !statusQueries.some((q) => /advisory/.test(q.sql)),
        "expected migrateStatus to never issue an advisory-lock query",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── --force gating: migrateDev refuses destructive plans (Slice B) ──────────

await check("migrateDev refuses a destructive plan without --force", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      await migrateDev({
        resolved: wideResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });
      const before = await historyRows(db);
      strictEqual(before.length, 1);

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      await migrateDev({
        resolved: minimalResolved(),
        name: "drop-cols",
        connectionString: "unused",
        createClient: client,
        cwd,
      });
      const refused = process.exitCode === 1;
      process.exitCode = savedExitCode;

      ok(refused, "expected process.exitCode = 1 refusing a destructive plan without --force");

      const after = await historyRows(db);
      strictEqual(after.length, 1, "no new migration should be recorded");

      const dirs = readdirSync(join(cwd, "migrations"), { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      strictEqual(dirs.length, 1, "no new migrations/<id>/ directory should be created");
    } finally {
      cleanup();
    }
  });
});

await check("migrateDev --force applies a destructive plan", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      await migrateDev({
        resolved: wideResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });

      await migrateDev({
        resolved: minimalResolved(),
        name: "drop-cols",
        connectionString: "unused",
        createClient: client,
        cwd,
        force: true,
      });

      const rows = await historyRows(db);
      strictEqual(rows.length, 2, "the forced migration should be recorded");
    } finally {
      cleanup();
    }
  });
});

await check("migrateDev refusal message lists every offending statement, bulleted", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      await migrateDev({
        resolved: wideResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const errors = await captureErrors(() =>
        migrateDev({
          resolved: minimalResolved(),
          name: "drop-cols",
          connectionString: "unused",
          createClient: client,
          cwd,
        }),
      );
      process.exitCode = savedExitCode;

      ok(
        errors.some((l) => /^❌ migrate dev refused:/.test(l)),
        `expected a "❌ migrate dev refused:" header, got:\n${errors.join("\n")}`,
      );
      const bullets = errors.filter((l) => l.trim().startsWith("•"));
      strictEqual(bullets.length, 2, `expected 2 bulleted impacts, got:\n${errors.join("\n")}`);
      ok(
        bullets.some((l) => /DROP COLUMN/.test(l) && /email/i.test(l)),
        `expected an email DROP COLUMN impact, got:\n${errors.join("\n")}`,
      );
      ok(
        bullets.some((l) => /DROP COLUMN/.test(l) && /age/i.test(l)),
        `expected an age DROP COLUMN impact, got:\n${errors.join("\n")}`,
      );
      ok(
        errors.some((l) => /--force/.test(l)),
        `expected a "Re-run with --force" hint, got:\n${errors.join("\n")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── --force gating: migrateDeploy refuses destructive files (Slice B) ───────

await check("migrateDeploy refuses a pending file carrying the marker without --force", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20250101000000_drop_cols";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), destructiveMigrationSql());

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const errors = await captureErrors(() =>
        migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd }),
      );
      const refused = process.exitCode === 1;
      process.exitCode = savedExitCode;

      ok(refused, "expected process.exitCode = 1 refusing a marker-carrying file without --force");
      ok(
        errors.some((l) => l.includes(id)),
        `expected the file id ${id} named in the refusal, got:\n${errors.join("\n")}`,
      );

      const rows = await historyRows(db);
      strictEqual(rows.length, 0, "nothing should have been applied");
    } finally {
      cleanup();
    }
  });
});

await check(
  "migrateDeploy refuses the whole run when a LATER pending file is destructive — the earlier safe file is NOT applied",
  async () => {
    await withDatabase(async (db) => {
      const { cwd, cleanup } = createMigrationsRoot();
      try {
        const safeId = "20250101000000_safe";
        const safeDir = join(cwd, "migrations", safeId);
        mkdirSync(safeDir, { recursive: true });
        writeFileSync(join(safeDir, "migration.sql"), safeMigrationSql());

        const destructiveId = "20250102000000_drop_cols";
        const destructiveDir = join(cwd, "migrations", destructiveId);
        mkdirSync(destructiveDir, { recursive: true });
        writeFileSync(join(destructiveDir, "migration.sql"), destructiveMigrationSql());

        const savedExitCode = process.exitCode;
        process.exitCode = undefined;
        await migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd });
        const refused = process.exitCode === 1;
        process.exitCode = savedExitCode;

        ok(refused, "expected process.exitCode = 1");
        const rows = await historyRows(db);
        strictEqual(rows.length, 0, "the earlier safe file must NOT have been applied either");
      } finally {
        cleanup();
      }
    });
  },
);

await check("migrateDeploy --force applies marker-carrying files", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      // Real "User" table (with email/age) must already exist for the
      // DROP COLUMN statements below to apply against real columns.
      await migrateDev({
        resolved: wideResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });

      const id = "20250102000000_drop_cols";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), destructiveMigrationSql());

      await migrateDeploy("unused", { createClient: client, cwd, force: true });

      const rows = await historyRows(db);
      strictEqual(rows.length, 2);
      ok(rows.some((r) => r.name === id));
    } finally {
      cleanup();
    }
  });
});

await check("migrateDeploy applies a legacy (unmarked) file without --force — backward compat", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const client = () => createMigrationClient(db);

      await migrateDev({
        resolved: wideResolved(),
        name: "init",
        connectionString: "unused",
        createClient: client,
        cwd,
      });

      const id = "20250102000000_legacy_drop";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), `ALTER TABLE "User" DROP COLUMN "email";\n`);

      await migrateDeploy("unused", { createClient: client, cwd });

      const rows = await historyRows(db);
      strictEqual(rows.length, 2, "an unmarked legacy file must apply without --force");
      ok(rows.some((r) => r.name === id));
    } finally {
      cleanup();
    }
  });
});

await check("a safe-only plan applies under both commands without --force, no gating output", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const devErrors = await captureErrors(() =>
        migrateDev({
          resolved: minimalResolved(),
          name: "init",
          connectionString: "unused",
          createClient: async () => createMigrationClient(db),
          cwd,
        }),
      );
      strictEqual(devErrors.length, 0, `expected no error output, got:\n${devErrors.join("\n")}`);
    } finally {
      cleanup();
    }
  });

  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20250101000000_safe";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), safeMigrationSql());

      const deployErrors = await captureErrors(() =>
        migrateDeploy("unused", { createClient: async () => createMigrationClient(db), cwd }),
      );
      strictEqual(deployErrors.length, 0, `expected no error output, got:\n${deployErrors.join("\n")}`);
    } finally {
      cleanup();
    }
  });
});

// ─── migrateStatus never gates on a destructive pending file (Slice B) ───────

await check("migrateStatus never gates and never sets exitCode on a destructive pending file", async () => {
  await withDatabase(async (db) => {
    const { cwd, cleanup } = createMigrationsRoot();
    try {
      const id = "20250101000000_drop_cols";
      const dir = join(cwd, "migrations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "migration.sql"), destructiveMigrationSql());

      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      const lines = await captureLogs(() =>
        migrateStatus("unused", { createClient: async () => createMigrationClient(db), cwd }),
      );
      // Not a strict `=== undefined` check: by this point in the suite,
      // enough PGlite instances have been opened/closed that Node's
      // WASM-instance GC can asynchronously normalize `undefined` to `0`
      // (reproducible standalone with plain `new PGlite()`/`close()` loops,
      // unrelated to `migrateStatus`) — what actually matters here is that
      // migrateStatus never *gates* (never sets the `1` this suite's gates use).
      const neverGated = process.exitCode !== 1;
      process.exitCode = savedExitCode;

      ok(neverGated, "migrateStatus must never set process.exitCode = 1 on a destructive pending file");
      ok(
        lines.some((l) => l.includes(id) && /· pending/.test(l)),
        `expected "· pending" for the destructive-but-unapplied row, got:\n${lines.join("\n")}`,
      );
    } finally {
      cleanup();
    }
  });
});

if (failures > 0) {
  console.error(`\ncli migrate-runner: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli migrate-runner: all green");
