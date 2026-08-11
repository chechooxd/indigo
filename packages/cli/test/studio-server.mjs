/**
 * @indigodb/cli — Studio server suite.
 *
 * Mirrors `packages/migrator/test`'s style: plain Node, no test framework.
 * Drives a REAL `startStudio` HTTP server, backed by a REAL (in-process)
 * PostgreSQL engine via PGlite, over real `fetch()` calls — see
 * `studio-harness.mjs`. No production logic is re-implemented here.
 *
 * The load-bearing case is the CTE-DELETE regression: it proves the
 * read-only guard is enforced by Postgres itself (`SET TRANSACTION READ
 * ONLY`), not by `isReadOnlyQuery`'s string heuristic, which a
 * `WITH x AS (DELETE ...) SELECT * FROM x` payload trivially defeats.
 */

import { parse, resolve } from "@indigodb/core";
import { withDatabase, withStudio } from "./studio-harness.mjs";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
}
`;

function loadFixture() {
  const ast = parse(SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: SCHEMA_SOURCE };
}

async function seedUsers(db) {
  await db.exec(`
    CREATE TABLE "User" (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    INSERT INTO "User" (email) VALUES ('a@example.com'), ('b@example.com');
  `);
}

console.log("@indigodb/cli studio-server: PGlite-backed integration suite");
console.log(
  "Scope: drives a real startStudio HTTP server against a real (in-process) Postgres\n" +
    "engine, over real fetch() calls. Proves the read-only enforcement boundary is the\n" +
    "database transaction, not the isReadOnlyQuery string pre-filter.\n",
);

// ─── Load-bearing regression: CTE-wrapped DELETE must be rejected ──────────
//
// `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x` starts with
// `WITH`, so the old `^(select|with)` prefix heuristic waved it through. The
// only thing that can safely reject it is Postgres itself running the
// statement inside `SET TRANSACTION READ ONLY`.
await check(
  "CTE-wrapped DELETE is rejected by the database, and no row is deleted",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();

      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sql: `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x`,
          }),
        });

        assert(res.status >= 400, `expected an error status, got ${res.status}`);
        const body = await res.json();
        assert(typeof body.error === "string" && body.error.length > 0, "expected an error message");
      });

      const remaining = await db.query(`SELECT count(*)::int AS n FROM "User"`);
      assert(
        remaining.rows[0].n === 2,
        `expected both seeded rows to survive the rejected DELETE, found ${remaining.rows[0].n}`,
      );
    });
  },
);

// ─── Regression guard: /api/tables/:name column aliasing ──────────────────
await check("/api/tables/:name aliases physical columns back to schema field names", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();

    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/tables/User`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.columns.includes("createdAt"), "expected the aliased field name createdAt in columns");
      assert(!body.columns.includes("created_at"), "physical column name must not leak into columns");
      assert(body.rows.length === 2, `expected 2 rows, got ${body.rows.length}`);
      assert(
        Object.prototype.hasOwnProperty.call(body.rows[0], "createdAt"),
        "expected each row to be keyed by the schema field name",
      );
    });
  });
});

// ─── Plain SELECT still succeeds through the read-only transaction ────────
await check("plain SELECT succeeds through the dedicated read-only transaction", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();

    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: `SELECT email FROM "User" ORDER BY email` }),
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.rows.length === 2, `expected 2 rows, got ${body.rows.length}`);
    });
  });
});

// ─── isReadOnlyQuery pre-filter: advisory only, still rejects junk pre-connection ──
await check("multi-statement query body is rejected before opening a connection", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();

    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: `SELECT 1; SELECT 2` }),
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = await res.json();
      assert(
        body.error === "Only a single read-only SELECT/WITH statement is allowed.",
        `unexpected error message: ${body.error}`,
      );
    });
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-server: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-server: all green");
