/**
 * @indigodb/cli — data-migrations attach point suite (`migrations/<id>/data.sql`
 * and `migrate dev --create-only --empty`).
 *
 * Drives the REAL runner functions against real in-process PostgreSQL (PGlite)
 * via `migrate-harness.mjs` — zero mocks.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { strictEqual, notStrictEqual, ok } from "node:assert";
import { parse, resolve as resolveSchema } from "@indigodb/core";
import { planMigration, renderMigrationSql } from "@indigodb/migrator";
import {
  migrateDev,
  migrateDeploy,
  migrateStatus,
  migrateResolve,
  migrationChecksum,
} from "../dist/migrate-runner.js";
import {
  withDatabase,
  createMigrationClient,
  createMigrationsRoot,
} from "./migrate-harness.mjs";

let failures = 0;

async function check(name, fn) {
  process.exitCode = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 25).join("\n"));
  }
}

console.log("cli migrate-data: data.sql attach point + --empty suite");

const V1 = resolveSchema(
  parse(`Table User {\n  id Int @id @default(autoincrement())\n  name String\n}\n`),
);
const V2 = resolveSchema(
  parse(`Table User {\n  id Int @id @default(autoincrement())\n  name String\n  slug String?\n}\n`),
);
const V3 = resolveSchema(
  parse(`Table User {\n  id Int @id @default(autoincrement())\n  name String\n  slug String?\n  bio String?\n}\n`),
);

async function historyRows(db) {
  const res = await db.query(
    `SELECT name, checksum, success FROM "_indigo_migrations" ORDER BY id`,
  );
  return res.rows;
}

function writeMig(cwd, id, sql, dataSql) {
  const dir = join(cwd, "migrations", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql);
  if (dataSql !== undefined) {
    writeFileSync(join(dir, "data.sql"), dataSql);
  }
}

function captureLogs(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    })
    .then(() => lines);
}

// 1. Checksum contract: backward-compatible without dataSql, distinct with dataSql
await check("migrationChecksum is byte-identical when dataSql omitted, distinct when present", () => {
  const sql = "CREATE TABLE x (id int);";
  strictEqual(migrationChecksum(sql), migrationChecksum(sql, undefined));
  notStrictEqual(migrationChecksum(sql), migrationChecksum(sql, ""));
  notStrictEqual(migrationChecksum(sql, "UPDATE x SET id=1;"), migrationChecksum(sql, "UPDATE x SET id=2;"));
});

// 2. DDL + data.sql backfill applies atomically
await check("DDL + data.sql backfill applies atomically in one transaction", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(cwd, "20260101000001_init", renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);
      await db.query(`INSERT INTO "User" ("name") VALUES ('Alice'), ('Bob')`);

      writeMig(
        cwd,
        "20260101000002_add_slug",
        renderMigrationSql(planMigration(V1, V2)),
        `UPDATE "User" SET "slug" = lower("name");\n`,
      );
      await migrateDeploy("", seam);
      strictEqual(process.exitCode, 0);

      const { rows } = await db.query(`SELECT "name", "slug" FROM "User" ORDER BY "id"`);
      strictEqual(rows.length, 2);
      strictEqual(rows[0].slug, "alice");
      strictEqual(rows[1].slug, "bob");

      const hist = await historyRows(db);
      strictEqual(hist.length, 2);
      strictEqual(hist[1].success, true);
    });
  } finally {
    cleanup();
  }
});

// 3. Failing data.sql rolls back both DDL and DML and records success = false
await check("failing data.sql rolls back DDL + DML atomically and records success = false", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(
        cwd,
        "20260101000001_broken_data",
        renderMigrationSql(planMigration(null, V1)),
        `INSERT INTO "User" ("name") VALUES ('Alice');\nSELECT 1 / 0;\n`,
      );
      await captureLogs(() => migrateDeploy("", seam));
      strictEqual(process.exitCode, 1);

      const { rows: tables } = await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User'`,
      );
      strictEqual(tables.length, 0, "DDL from migration.sql must roll back when data.sql fails");

      const hist = await historyRows(db);
      strictEqual(hist.length, 1);
      strictEqual(hist[0].success, false);
    });
  } finally {
    cleanup();
  }
});

// 4. Data-only migration (comment-only migration.sql + data.sql) applies cleanly
await check("data-only migration (comment-only migration.sql + data.sql) applies cleanly", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(cwd, "20260101000001_init", renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);
      await db.query(`INSERT INTO "User" ("name") VALUES ('alice')`);

      writeMig(
        cwd,
        "20260101000002_upper_names",
        "-- Data-only migration (no schema changes)\n",
        `UPDATE "User" SET "name" = upper("name");\n`,
      );
      await migrateDeploy("", seam);
      strictEqual(process.exitCode, 0);

      const { rows } = await db.query(`SELECT "name" FROM "User"`);
      strictEqual(rows[0].name, "ALICE");
    });
  } finally {
    cleanup();
  }
});

// 5. Destructive marker in data.sql obeys --force gate
await check("data.sql with -- indigo:requires-force refuses without --force and applies with --force", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(cwd, "20260101000001_init", renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);
      await db.query(`INSERT INTO "User" ("name") VALUES ('Legacy')`);

      writeMig(
        cwd,
        "20260101000002_purge",
        "-- Data-only migration\n",
        `-- indigo:requires-force deletes legacy User rows\nDELETE FROM "User" WHERE "name" = 'Legacy';\n`,
      );

      const refusedLines = await captureLogs(() => migrateDeploy("", seam));
      strictEqual(process.exitCode, 1);
      ok(refusedLines.some((l) => l.includes("deletes legacy User rows")));
      strictEqual((await db.query(`SELECT * FROM "User"`)).rows.length, 1);

      process.exitCode = 0;
      await migrateDeploy("", { ...seam, force: true });
      strictEqual(process.exitCode, 0);
      strictEqual((await db.query(`SELECT * FROM "User"`)).rows.length, 0);
    });
  } finally {
    cleanup();
  }
});

// 6. Post-apply edit to data.sql detected across deploy, dev, status, resolve
await check("editing data.sql after apply is detected as drift by status, deploy, dev, and resolve", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      const id = "20260101000001_init_seed";
      writeMig(
        cwd,
        id,
        renderMigrationSql(planMigration(null, V1)),
        `INSERT INTO "User" ("name") VALUES ('Admin');\n`,
      );
      await migrateDeploy("", seam);
      strictEqual(process.exitCode, 0);

      // Tamper with data.sql after apply
      writeFileSync(join(cwd, "migrations", id, "data.sql"), `INSERT INTO "User" ("name") VALUES ('Tampered');\n`);

      // status -> ⚠ modified
      const statusLines = await captureLogs(() => migrateStatus("", seam));
      ok(statusLines.some((l) => l.includes("modified") && l.includes(id)), `expected modified in: ${statusLines.join("\n")}`);

      // deploy -> refuses
      process.exitCode = 0;
      const deployLines = await captureLogs(() => migrateDeploy("", seam));
      strictEqual(process.exitCode, 1);
      ok(deployLines.some((l) => l.includes(id)));

      // dev (shadow replay) -> refuses
      process.exitCode = 0;
      const devLines = await captureLogs(() =>
        migrateDev({ resolved: V2, name: "next", connectionString: "", ...seam }),
      );
      strictEqual(process.exitCode, 1);
      ok(devLines.some((l) => l.includes(id)));

      // resolve --applied -> refuses
      process.exitCode = 0;
      const resLines = await captureLogs(() =>
        migrateResolve({ connectionString: "", applied: id, ...seam }),
      );
      strictEqual(process.exitCode, 1);
      ok(resLines.some((l) => l.includes("checksum")));
    });
  } finally {
    cleanup();
  }
});

// 7. Adding data.sql to an already-applied DDL-only migration is detected as drift
await check("adding data.sql after apply to a DDL-only migration is detected as drift", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      const id = "20260101000001_ddl_only";
      writeMig(cwd, id, renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);
      strictEqual(process.exitCode, 0);

      // Now drop a data.sql into the already-applied directory
      writeFileSync(join(cwd, "migrations", id, "data.sql"), `INSERT INTO "User" ("name") VALUES ('Late');\n`);

      process.exitCode = 0;
      await captureLogs(() => migrateDeploy("", seam));
      strictEqual(process.exitCode, 1, "adding data.sql post-apply must trigger checksum drift");
    });
  } finally {
    cleanup();
  }
});

// 8. Shadow replay skips data.sql even when data.sql asserts live rows exist
await check("shadow replay skips data.sql so live-data-dependent backfills do not break future migrateDev", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(cwd, "20260101000001_init", renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);
      await db.query(`INSERT INTO "User" ("name") VALUES ('Alice')`);

      // A data.sql that RAISES EXCEPTION on an empty table (like shadow DB!)
      const strictDataSql = `DO $$
BEGIN
  IF (SELECT count(*) FROM "User") = 0 THEN
    RAISE EXCEPTION 'expected populated User table';
  END IF;
  UPDATE "User" SET "slug" = lower("name");
END $$;
`;
      writeMig(cwd, "20260101000002_backfill", renderMigrationSql(planMigration(V1, V2)), strictDataSql);
      await migrateDeploy("", seam);
      strictEqual(process.exitCode, 0);

      // Now run migrateDev for V3 — shadow replay runs against empty PGlite and MUST skip data.sql
      await migrateDev({ resolved: V3, name: "add_bio", connectionString: "", ...seam });
      strictEqual(process.exitCode, 0);
      const { rows } = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'bio'`,
      );
      strictEqual(rows.length, 1);
    });
  } finally {
    cleanup();
  }
});

// 9. --empty without --create-only refuses before connecting; --create-only --empty scaffolds both files
await check("--empty without --create-only refuses before connecting; --create-only --empty scaffolds migration.sql + data.sql", async () => {
  const { cwd, cleanup } = createMigrationsRoot();
  try {
    let connected = false;
    const lines = await captureLogs(() =>
      migrateDev({
        resolved: V1,
        name: "bad",
        connectionString: "",
        cwd,
        empty: true,
        createClient: async () => {
          connected = true;
          throw new Error("should not connect");
        },
      }),
    );
    strictEqual(process.exitCode, 1);
    strictEqual(connected, false);
    ok(lines.some((l) => l.includes("--create-only")));

    // Now test --create-only --empty against an already up-to-date DB
    process.exitCode = 0;
    await withDatabase(async (db) => {
      const seam = { cwd, createClient: async () => createMigrationClient(db) };
      writeMig(cwd, "20260101000001_init", renderMigrationSql(planMigration(null, V1)));
      await migrateDeploy("", seam);

      await migrateDev({
        resolved: V1,
        name: "backfill_users",
        connectionString: "",
        createOnly: true,
        empty: true,
        ...seam,
      });
      strictEqual(process.exitCode, 0);

      const dirs = readdirSync(join(cwd, "migrations")).filter((d) => !d.startsWith(".")).sort();
      strictEqual(dirs.length, 2);
      const created = dirs[1];
      ok(created.endsWith("_backfill_users"), `unexpected dir name: ${created}`);
      ok(existsSync(join(cwd, "migrations", created, "migration.sql")));
      ok(existsSync(join(cwd, "migrations", created, "data.sql")));
      ok(readFileSync(join(cwd, "migrations", created, "data.sql"), "utf-8").includes("data.sql") ||
         readFileSync(join(cwd, "migrations", created, "data.sql"), "utf-8").includes("Data migration"));
      // Not applied in _indigo_migrations
      strictEqual((await historyRows(db)).length, 1);
    });
  } finally {
    cleanup();
  }
});

if (failures > 0) {
  console.error(`\nmigrate-data: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrate-data: all passed");
