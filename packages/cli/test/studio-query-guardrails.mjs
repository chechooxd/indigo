/**
 * @indigodb/cli — Studio query guardrails suite (row cap + statement timeout).
 *
 * Mirrors `studio-readonly.mjs`'s style: plain Node, no test framework.
 * Drives a REAL `startStudio` HTTP server, backed by a REAL (in-process)
 * PostgreSQL engine via PGlite, over real `fetch()` calls — see
 * `studio-harness.mjs`.
 *
 * Note on statement_timeout: empirically confirmed (see apply-progress) that
 * PGlite ACCEPTS `SET LOCAL statement_timeout` without error but does NOT
 * abort a long-running statement once it elapses. `studio-harness.mjs`
 * therefore always pins the preamble's timeout to `0`. The `57014` mapping
 * (statement-timeout abort → 400 with the exact guidance message) is
 * exercised here with a deterministic injected `StudioDb` double instead of
 * a live PGlite timeout — see the "57014 mapping" section below.
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

async function seedUsers(db, n) {
  const values = Array.from({ length: n }, (_, i) => `('u${i}@example.com')`).join(", ");
  await db.exec(`
    CREATE TABLE "User" (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      bio TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    INSERT INTO "User" (email) VALUES ${values};
  `);
}

async function countUsers(db) {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM "User"`);
  return result.rows[0].count;
}

async function runQuery(baseUrl, sql) {
  return fetch(`${baseUrl}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
}

// ── 3.1: Cap enforced ───────────────────────────────────────────────────────

await check("cap+5 rows -> exactly cap rows, truncated: true (queryRowCap: 5)", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 10);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" ORDER BY id`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.rows.length === 5, `expected exactly 5 rows, got ${body.rows.length}`);
      assert(body.truncated === true, `expected truncated:true, got ${body.truncated}`);
    }, { queryRowCap: 5 });
  });
});

// ── 3.2: Under-cap boundary ─────────────────────────────────────────────────

await check("exact-cap rows -> every row, truncated: false (boundary)", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 5);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" ORDER BY id`);
      const body = await res.json();
      assert(body.rows.length === 5, `expected exactly 5 rows, got ${body.rows.length}`);
      assert(body.truncated === false, `expected truncated:false, got ${body.truncated}`);
    }, { queryRowCap: 5 });
  });
});

await check("below-cap rows -> every row, truncated: false", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 3);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" ORDER BY id`);
      const body = await res.json();
      assert(body.rows.length === 3, `expected exactly 3 rows, got ${body.rows.length}`);
      assert(body.truncated === false, `expected truncated:false, got ${body.truncated}`);
    }, { queryRowCap: 5 });
  });
});

// ── 3.3: Empty result set ───────────────────────────────────────────────────

await check("empty result set: columns populated, rows: [], truncated: false", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 3);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" WHERE id > 1000`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.columns.length > 0, `expected populated columns, got ${JSON.stringify(body.columns)}`);
      assert(body.rows.length === 0, `expected zero rows, got ${body.rows.length}`);
      assert(body.truncated === false, `expected truncated:false, got ${body.truncated}`);
    }, { queryRowCap: 5 });
  });
});

// ── 3.4: User's own LIMIT respected unchanged ───────────────────────────────

await check("user-supplied LIMIT n < cap is respected unchanged: exactly n rows, truncated: false", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 10);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" ORDER BY id LIMIT 3`);
      const body = await res.json();
      assert(body.rows.length === 3, `expected exactly 3 rows, got ${body.rows.length}`);
      assert(body.truncated === false, `expected truncated:false, got ${body.truncated}`);
    }, { queryRowCap: 5 });
  });
});

// ── 3.5: queryRowCap: 0 disables the cursor path ────────────────────────────

await check("queryRowCap: 0 disables the cursor path: response identical to today plus truncated: false", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 10);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT * FROM "User" ORDER BY id`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.rows.length === 10, `expected all 10 rows uncapped, got ${body.rows.length}`);
      assert(body.truncated === false, `expected truncated:false, got ${body.truncated}`);
    }, { queryRowCap: 0 });
  });
});

// ── 3.6: queryTimeoutMs: 0 disables the timeout ─────────────────────────────

await check("queryTimeoutMs: 0 disables the timeout: query is not aborted, status reports queryTimeoutMs: 0", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 1);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `SELECT pg_sleep(0.05)`);
      assert(res.status === 200, `expected the query to complete, not be aborted; got ${res.status}`);

      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const statusBody = await statusRes.json();
      assert(statusBody.queryTimeoutMs === 0, `expected queryTimeoutMs:0, got ${statusBody.queryTimeoutMs}`);
    }, { queryTimeoutMs: 0 });
  });
});

// ── 3.7: Cursor-ineligible statements still 200 ─────────────────────────────

await check("cursor-ineligible statements (EXPLAIN/SHOW/TABLE/VALUES) still return 200", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 3);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const explainRes = await runQuery(baseUrl, `EXPLAIN SELECT 1`);
      assert(explainRes.status === 200, `expected EXPLAIN 200, got ${explainRes.status}`);

      const showRes = await runQuery(baseUrl, `SHOW server_version`);
      assert(showRes.status === 200, `expected SHOW 200, got ${showRes.status}`);

      const tableRes = await runQuery(baseUrl, `TABLE "User"`);
      assert(tableRes.status === 200, `expected TABLE 200, got ${tableRes.status}`);

      const valuesRes = await runQuery(baseUrl, `VALUES (1)`);
      assert(valuesRes.status === 200, `expected VALUES 200, got ${valuesRes.status}`);
    });
  });
});

// ── 3.8: CTE-wrapped DELETE refused, zero mutation ──────────────────────────

await check("CTE-wrapped DELETE -> 400, zero mutation (never asserts SQLSTATE or message text)", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 5);
    const before = await countUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await runQuery(baseUrl, `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === "string" && body.error.length > 0, "expected a non-empty error message");
    });
    const after = await countUsers(db);
    assert(after === before, `expected row count unchanged (${before}), got ${after}`);
  });
});

// ── 3.9: Multi-statement/empty input still rejected pre-filter (regression) ─

await check("multi-statement/empty input still rejected before any connection (regression)", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 3);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const multiRes = await runQuery(baseUrl, `SELECT 1; SELECT 2;`);
      assert(multiRes.status === 400, `expected multi-statement 400, got ${multiRes.status}`);

      const emptyRes = await runQuery(baseUrl, ``);
      assert(emptyRes.status === 400, `expected empty-input 400, got ${emptyRes.status}`);
    });
  });
});

// ── 3.10: /api/tables/:name + pagination unchanged with guardrails on ──────

await check("/api/tables/:name ignores queryRowCap: limit still governs page size", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 30);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/tables/User?limit=25`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(
        body.rows.length === 25,
        `expected limit=25 (an ALLOWED_LIMITS value) to govern page size despite queryRowCap:5, got ${body.rows.length}`,
      );
      assert(body.total === 30, `expected total:30, got ${body.total}`);
    }, { queryRowCap: 5 });
  });
});

// ── 3.11: Write routes take no timeout/cap; db.writable preamble unchanged ─

await check("write routes are unaffected by guardrail options: insert still succeeds", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 1);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "write-control@example.com" }),
      });
      assert(res.status === 201, `expected insert 201, got ${res.status}`);
    }, { queryRowCap: 1, queryTimeoutMs: 1 });
    const after = await countUsers(db);
    assert(after === 2, `expected 2 rows after control insert, got ${after}`);
  });
});

// ── 3.12: Probe echoes exact resolved values ────────────────────────────────

await check("GET /api/auth/status echoes queryTimeoutMs/queryRowCap exactly as passed to startStudio", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 1);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      const body = await res.json();
      assert(body.queryTimeoutMs === 1234, `expected queryTimeoutMs:1234, got ${body.queryTimeoutMs}`);
      assert(body.queryRowCap === 7, `expected queryRowCap:7, got ${body.queryRowCap}`);
    }, { queryTimeoutMs: 1234, queryRowCap: 7 });
  });
});

await check("GET /api/auth/status reports positive built-in defaults when neither option is passed", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db, 1);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      const body = await res.json();
      assert(body.queryTimeoutMs === 30000, `expected default queryTimeoutMs:30000, got ${body.queryTimeoutMs}`);
      assert(body.queryRowCap === 1000, `expected default queryRowCap:1000, got ${body.queryRowCap}`);
    });
  });
});

// ── 3.13: 57014 -> 400 with exact guidance message (deterministic double) ──

function timeoutRejectingDb() {
  return {
    async query() {
      throw new Error("query() should not be called by this double");
    },
    async readOnly() {
      const err = new Error("canceling statement due to statement timeout");
      err.code = "57014";
      throw err;
    },
    async writable() {
      throw new Error("writable() should not be called by this double");
    },
    async close() {},
  };
}

await check("57014 -> 400 with the exact guidance message, no SQL echoed (injected StudioDb double)", async () => {
  const fixture = loadFixture();
  const { startStudio } = await import("../dist/studio-server.js");
  const server = await startStudio({
    resolved: fixture.resolved,
    source: fixture.source,
    connectionString: "postgres://unused/unused",
    port: 0,
    open: false,
    db: timeoutRejectingDb(),
    queryTimeoutMs: 9000,
  });
  try {
    const baseUrl = `http://${server.host}:${server.port}`;
    const res = await runQuery(baseUrl, `SELECT * FROM "User"`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json();
    const expected =
      "Query exceeded the 9000ms statement timeout. Raise it with --query-timeout or INDIGODB_STUDIO_QUERY_TIMEOUT_MS.";
    assert(body.error === expected, `expected the exact guidance message, got ${JSON.stringify(body.error)}`);
    assert(!body.error.includes("SELECT"), "expected no SQL echoed in the error message");
  } finally {
    await server.close();
  }
});

// ── 3.14: slow GET /api/tables/:name bounded by same timeout (deterministic double) ──

await check("GET /api/tables/:name maps a 57014 abort to a 4xx naming the timeout (injected StudioDb double)", async () => {
  const fixture = loadFixture();
  const { startStudio } = await import("../dist/studio-server.js");
  const server = await startStudio({
    resolved: fixture.resolved,
    source: fixture.source,
    connectionString: "postgres://unused/unused",
    port: 0,
    open: false,
    db: timeoutRejectingDb(),
    queryTimeoutMs: 4500,
  });
  try {
    const baseUrl = `http://${server.host}:${server.port}`;
    const res = await fetch(`${baseUrl}/api/tables/User`);
    assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error.includes("4500ms statement timeout"),
      `expected the error to name the configured timeout, got ${JSON.stringify(body.error)}`,
    );
  } finally {
    await server.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll studio-query-guardrails checks passed.");
}
