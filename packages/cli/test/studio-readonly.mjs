/**
 * @indigodb/cli — Studio read-only mode suite.
 *
 * Plain Node, no test framework (mirrors `studio-auth.mjs`/`studio-write.mjs`).
 * Drives the REAL HTTP server (`startStudio`) over real `fetch()`, backed by
 * a PGlite-backed `StudioDb` adapter (`studio-harness.mjs`), asserting the
 * read-only gate's behavior across all auth x read-only combinations.
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
  bio       String?
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
      bio TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    INSERT INTO "User" (email, bio) VALUES ('a@example.com', 'hello'), ('b@example.com', 'world');
  `);
}

async function countUsers(db) {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM "User"`);
  return result.rows[0].count;
}

const TEST_PASSWORD = "correct horse battery staple";

function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

async function loginAndGetCookie(baseUrl) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert(loginRes.status === 200, `expected login 200, got ${loginRes.status}`);
  return extractCookie(loginRes);
}

// ── Task 1.1: control case — default preserves existing write behavior ─────

await check("default (no readOnly option): writes to /api/rows/User succeed as before", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const insertRes = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "control@example.com" }),
      });
      assert(insertRes.status === 201, `expected insert 201, got ${insertRes.status}`);

      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const statusBody = await statusRes.json();
      assert(statusBody.readOnly === false, "expected readOnly:false when no readOnly option is passed");
    });
  });
});

// ── Task 2.1: three-verb rejection ──────────────────────────────────────────

await check("readOnly:true rejects POST /api/rows/User with 403 and the exact message; row count unchanged", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const before = await countUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "blocked@example.com" }),
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      const body = await res.json();
      assert(
        body.error === "Studio is running in read-only mode",
        `expected the exact read-only message, got ${JSON.stringify(body)}`,
      );
    }, { readOnly: true });
    const after = await countUsers(db);
    assert(after === before, `expected row count unchanged (${before}), got ${after}`);
  });
});

await check("readOnly:true rejects PATCH /api/rows/User with 403 and the exact message; row unchanged", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk: { id: 1 }, patch: { bio: "should not apply" } }),
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
    }, { readOnly: true });
    const row = await db.query(`SELECT bio FROM "User" WHERE id = 1`);
    assert(row.rows[0].bio === "hello", "expected the row's bio to remain unchanged");
  });
});

await check("readOnly:true rejects DELETE /api/rows/User with 403 and the exact message; row count unchanged", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const before = await countUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk: { id: 1 } }),
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
    }, { readOnly: true });
    const after = await countUsers(db);
    assert(after === before, `expected row count unchanged (${before}), got ${after}`);
  });
});

// ── Task 2.2: unrouted verb via the same prefix gate ────────────────────────

await check("readOnly:true rejects an unrouted verb (PUT) on /api/rows/User with 403 via the same gate", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk: { id: 1 }, patch: { bio: "nope" } }),
      });
      assert(res.status === 403, `expected 403 for PUT via the prefix gate, got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
    }, { readOnly: true });
  });
});

// ── Task 2.6: reads unaffected ──────────────────────────────────────────────

await check("readOnly:true leaves /api/schema, /api/tables/:name, and /api/query unaffected (200)", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const schemaRes = await fetch(`${baseUrl}/api/schema`);
      assert(schemaRes.status === 200, `expected /api/schema 200, got ${schemaRes.status}`);

      const tablesRes = await fetch(`${baseUrl}/api/tables/User`);
      assert(tablesRes.status === 200, `expected /api/tables/User 200, got ${tablesRes.status}`);

      const queryRes = await fetch(`${baseUrl}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      assert(queryRes.status === 200, `expected /api/query 200, got ${queryRes.status}`);
    }, { readOnly: true });
  });
});

// ── Task 3.1/3.2: auth precedence ───────────────────────────────────────────

await check("precedence: auth on + readOnly on, no cookie, write → 401, DB unchanged, read-only gate never reached", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const before = await countUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unauth-readonly@example.com" }),
      });
      assert(res.status === 401, `expected 401 (auth gate first), got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Authentication required", `expected auth message, got ${JSON.stringify(body)}`);
    }, { readOnly: true, password: TEST_PASSWORD });
    const after = await countUsers(db);
    assert(after === before, `expected row count unchanged (${before}), got ${after}`);
  });
});

await check("precedence: auth on + readOnly on, valid cookie, write → 403 with the read-only message", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const cookie = await loginAndGetCookie(baseUrl);
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ email: "auth-readonly@example.com" }),
      });
      assert(res.status === 403, `expected 403 (read-only gate, after auth passed), got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
    }, { readOnly: true, password: TEST_PASSWORD });
  });
});

// ── Task 2.4: probe reports readOnly across all 4 auth x read-only combinations ──

await check("GET /api/auth/status reports {authRequired, readOnly} correctly across all 4 combinations", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    const combinations = [
      { password: undefined, readOnly: undefined, authRequired: false, readOnlyExpected: false },
      { password: undefined, readOnly: true, authRequired: false, readOnlyExpected: true },
      { password: TEST_PASSWORD, readOnly: undefined, authRequired: true, readOnlyExpected: false },
      { password: TEST_PASSWORD, readOnly: true, authRequired: true, readOnlyExpected: true },
    ];
    for (const combo of combinations) {
      const options = {};
      if (combo.password !== undefined) options.password = combo.password;
      if (combo.readOnly !== undefined) options.readOnly = combo.readOnly;
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        assert(
          body.authRequired === combo.authRequired,
          `combo ${JSON.stringify(combo)}: expected authRequired:${combo.authRequired}, got ${body.authRequired}`,
        );
        assert(
          body.readOnly === combo.readOnlyExpected,
          `combo ${JSON.stringify(combo)}: expected readOnly:${combo.readOnlyExpected}, got ${body.readOnly}`,
        );
      }, options);
    }
  });
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll studio-readonly checks passed.");
}
