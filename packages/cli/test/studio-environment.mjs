/**
 * @indigodb/cli — Studio environment badge suite (server/API slice).
 *
 * Plain Node, no test framework (mirrors `studio-readonly.mjs`). Drives the
 * REAL HTTP server (`startStudio`) over real `fetch()`, backed by a
 * PGlite-backed `StudioDb` adapter (`studio-harness.mjs`).
 *
 * Task 2.1: probe echoes `environment` exactly, reports `null` when unset,
 * and answers `environment` pre-auth (design rows 14–16).
 * Task 2.2: the non-enforcement suite — `environment` is never an
 * enforcement input (design rows 17–18, plus Gap A: `/api/auth/login`, an
 * authenticated route, and `POST /api/query` respond identically with and
 * without `--env`).
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

// ── Task 2.1: probe echo / null / pre-auth (design rows 14–16) ─────────────

await check("GET /api/auth/status echoes environment exactly as startStudio received it", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.environment === "staging", `expected environment:"staging", got ${JSON.stringify(body.environment)}`);
    }, { environment: "staging" });
  });
});

await check("GET /api/auth/status reports environment: null when unset", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.environment === null, `expected environment:null, got ${JSON.stringify(body.environment)}`);
    });
  });
});

await check("GET /api/auth/status answers environment pre-auth, no session cookie, route stays exempt", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(
      db,
      fixture,
      async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        assert(res.status === 200, `expected 200 (exempt route), got ${res.status}`);
        const body = await res.json();
        assert(body.authRequired === true, "expected authRequired:true (password configured)");
        assert(body.authenticated === false, "expected authenticated:false (no cookie presented)");
        assert(
          body.environment === "production",
          `expected environment:"production" even pre-auth, got ${JSON.stringify(body.environment)}`,
        );
      },
      { password: TEST_PASSWORD, environment: "production" },
    );
  });
});

// ── Task 2.2: non-enforcement suite (design rows 17–18 + Gap A) ─────────────

await check("row 17: environment:\"production\" alone leaves /api/rows/User writes succeeding", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(
      db,
      fixture,
      async ({ baseUrl }) => {
        const insertRes = await fetch(`${baseUrl}/api/rows/User`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "prod-control@example.com" }),
        });
        assert(insertRes.status === 201, `expected insert 201, got ${insertRes.status}`);

        const statusRes = await fetch(`${baseUrl}/api/auth/status`);
        const statusBody = await statusRes.json();
        assert(statusBody.readOnly === false, "expected readOnly:false — environment must not enable read-only");
        assert(
          statusBody.queryTimeoutMs === 30000,
          `expected the default queryTimeoutMs (30000), got ${statusBody.queryTimeoutMs}`,
        );
        assert(
          statusBody.queryRowCap === 1000,
          `expected the default queryRowCap (1000), got ${statusBody.queryRowCap}`,
        );
      },
      { environment: "production" },
    );
  });
});

await check(
  "row 18: {environment:\"production\", readOnly:true} -> probe reports both; write 403 for the read-only reason only",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const statusRes = await fetch(`${baseUrl}/api/auth/status`);
          const statusBody = await statusRes.json();
          assert(statusBody.environment === "production", `expected environment:"production", got ${JSON.stringify(statusBody.environment)}`);
          assert(statusBody.readOnly === true, `expected readOnly:true, got ${statusBody.readOnly}`);

          const writeRes = await fetch(`${baseUrl}/api/rows/User`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "prod-readonly@example.com" }),
          });
          assert(writeRes.status === 403, `expected 403, got ${writeRes.status}`);
          const writeBody = await writeRes.json();
          assert(
            writeBody.error === "Studio is running in read-only mode",
            `expected the read-only reason, got ${JSON.stringify(writeBody)}`,
          );
        },
        { environment: "production", readOnly: true },
      );
    });
  },
);

// Gap A: /api/auth/login, an authenticated /api/* route, and POST /api/query
// each respond IDENTICALLY with and without --env, aside from `environment`
// on the status probe. Runs the same request pair against two servers (one
// with environment set, one without) and diffs the response shape.

async function runPair(dbA, dbB, requestFn) {
  const fixture = loadFixture();
  let resultWith;
  let resultWithout;
  await withStudio(dbA, fixture, async (ctx) => {
    resultWith = await requestFn(ctx);
  }, { password: TEST_PASSWORD, environment: "production" });
  await withStudio(dbB, fixture, async (ctx) => {
    resultWithout = await requestFn(ctx);
  }, { password: TEST_PASSWORD });
  return { resultWith, resultWithout };
}

await check("Gap A: POST /api/auth/login responds identically with and without --env", async () => {
  await withDatabase(async (dbA) => {
    await seedUsers(dbA);
    await withDatabase(async (dbB) => {
      await seedUsers(dbB);
      const { resultWith, resultWithout } = await runPair(dbA, dbB, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        return { status: res.status, hasCookie: extractCookie(res) !== null, body: await res.json() };
      });
      assert(resultWith.status === resultWithout.status, "expected identical login status");
      assert(resultWith.hasCookie === resultWithout.hasCookie, "expected identical Set-Cookie presence");
      assert(
        JSON.stringify(resultWith.body) === JSON.stringify(resultWithout.body),
        "expected identical login response body",
      );
    });
  });
});

await check("Gap A: an authenticated /api/* route (GET /api/schema) responds identically with and without --env", async () => {
  await withDatabase(async (dbA) => {
    await seedUsers(dbA);
    await withDatabase(async (dbB) => {
      await seedUsers(dbB);
      const { resultWith, resultWithout } = await runPair(dbA, dbB, async ({ baseUrl }) => {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        const cookie = extractCookie(loginRes);
        const res = await fetch(`${baseUrl}/api/schema`, { headers: { cookie } });
        return { status: res.status, body: await res.json() };
      });
      assert(resultWith.status === resultWithout.status, "expected identical /api/schema status");
      assert(
        JSON.stringify(resultWith.body) === JSON.stringify(resultWithout.body),
        "expected identical /api/schema response body",
      );
    });
  });
});

await check("Gap A: POST /api/query responds identically with and without --env", async () => {
  await withDatabase(async (dbA) => {
    await seedUsers(dbA);
    await withDatabase(async (dbB) => {
      await seedUsers(dbB);
      const { resultWith, resultWithout } = await runPair(dbA, dbB, async ({ baseUrl }) => {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        const cookie = extractCookie(loginRes);
        const res = await fetch(`${baseUrl}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ sql: "SELECT 1 AS one" }),
        });
        return { status: res.status, body: await res.json() };
      });
      assert(resultWith.status === resultWithout.status, "expected identical /api/query status");
      assert(
        JSON.stringify(resultWith.body) === JSON.stringify(resultWithout.body),
        "expected identical /api/query response body",
      );
    });
  });
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll studio-environment checks passed.");
}
