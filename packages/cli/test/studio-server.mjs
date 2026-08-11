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
import { redactSource } from "../dist/studio-server.js";

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

// ─── Bind address: loopback by default, explicit opt-in honored ───────────
await check("default bind (no host option) resolves to a loopback address", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ host }) => {
      assert(
        host === "127.0.0.1" || host === "::1",
        `expected a loopback bind address, got ${host}`,
      );
    });
  });
});

await check("explicit host option is threaded through to listen()", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(
      db,
      fixture,
      async ({ host }) => {
        assert(host === "0.0.0.0", `expected the explicit host to be honored, got ${host}`);
      },
      { host: "0.0.0.0" },
    );
  });
});

// ─── Datasource redaction ───────────────────────────────────────────────────
const CREDENTIAL_URL = "postgres://user:pass@host/db";
const SCHEMA_WITH_CREDENTIAL = `
datasource db {
  provider = "postgresql"
  url = "${CREDENTIAL_URL}"
}

Table User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

await check("/api/schema omits the datasource key from the JSON response", async () => {
  await withDatabase(async (db) => {
    const ast = parse(SCHEMA_WITH_CREDENTIAL);
    const resolved = resolve(ast);
    await withStudio(db, { resolved, source: SCHEMA_WITH_CREDENTIAL }, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/schema`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(!("datasource" in body), "expected no datasource key in /api/schema response");
      assert(
        !JSON.stringify(body).includes(CREDENTIAL_URL),
        "credential string must not appear anywhere in the /api/schema response",
      );
    });
  });
});

await check(
  "/api/schema/source omits the datasource block and its credential from raw source",
  async () => {
    await withDatabase(async (db) => {
      const ast = parse(SCHEMA_WITH_CREDENTIAL);
      const resolved = resolve(ast);
      await withStudio(db, { resolved, source: SCHEMA_WITH_CREDENTIAL }, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/schema/source`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const text = await res.text();
        assert(!text.includes(CREDENTIAL_URL), "credential string must not appear in raw source");
        assert(!text.includes('provider = "postgresql"'), "the datasource block body must be stripped");
        assert(text.includes("// datasource redacted"), "expected the redaction placeholder comment");
        assert(text.includes("Table User"), "the rest of the schema must survive redaction");
      });
    });
  },
);

await check(
  "redactSource strips a multi-line, nested datasource block (unit test, brace-depth scan)",
  () => {
    const source = [
      "datasource db {",
      '  provider = "postgresql"',
      "  url = env(\"DATABASE_URL\")",
      "}",
      "",
      "Table User {",
      "  id Int @id",
      "}",
    ].join("\n");
    const redacted = redactSource(source);
    assert(!redacted.includes("DATABASE_URL"), "env() reference must be stripped");
    assert(!redacted.includes('provider = "postgresql"'), "the datasource block body must be stripped");
    assert(redacted.includes("// datasource redacted"), "expected the redaction placeholder comment");
    assert(redacted.includes("Table User"), "content after the block must survive");
  },
);

// ─── Origin/Host allowlist ──────────────────────────────────────────────────
await check("mismatched Origin header is rejected with 403", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/schema`, {
        headers: { origin: "http://evil.example.com" },
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === "string" && body.error.length > 0, "expected an error message");
    });
  });
});

await check("request with no Origin header at all still succeeds", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/schema`);
      assert(res.status === 200, `expected 200 for a request without an Origin header, got ${res.status}`);
    });
  });
});

await check("matching Origin header succeeds", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl, host, port }) => {
      const res = await fetch(`${baseUrl}/api/schema`, {
        headers: { origin: `http://${host}:${port}` },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-server: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-server: all green");
