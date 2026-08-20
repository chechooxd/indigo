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

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strictEqual, ok } from "node:assert";
import { parse, resolve as resolveSchema } from "@indigodb/core";
import { migrateDev, migrateDeploy, migrationChecksum } from "../dist/migrate-runner.js";
import { withDatabase, createMigrationClient, createMigrationsRoot } from "./migrate-harness.mjs";

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

if (failures > 0) {
  console.error(`\ncli migrate-runner: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli migrate-runner: all green");
