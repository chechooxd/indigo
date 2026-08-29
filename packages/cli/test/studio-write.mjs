/**
 * @indigodb/cli — Studio write-route suite (PATCH + POST /api/rows/:table).
 *
 * Mirrors `studio-server.mjs`'s style: plain Node, no test framework. Drives
 * a REAL `startStudio` HTTP server, backed by a REAL (in-process) PostgreSQL
 * engine via PGlite, over real `fetch()` calls — see `studio-harness.mjs`.
 *
 * Scope: PR 1 (Slice A) covered UPDATE. PR 2 (Slice B) added INSERT. PR 3
 * (Slice C, this file's DELETE section) adds DELETE.
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

Table Membership {
  userId Int    @id
  orgId  Int    @id
  role   String
}

Table Widget {
  id        Int      @id @default(autoincrement())
  label     String
  verified  Boolean  @default(false)
  metadata  Json?
  status    String   @default("active")
  score     Float?
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

async function seedMemberships(db) {
  await db.exec(`
    CREATE TABLE "Membership" (
      "userId" INT NOT NULL,
      "orgId" INT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY ("userId", "orgId")
    );
    INSERT INTO "Membership" ("userId", "orgId", role) VALUES (1, 1, 'member'), (1, 2, 'admin');
  `);
}

async function seedWidgets(db) {
  await db.exec(`
    CREATE TABLE "Widget" (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB,
      status TEXT NOT NULL DEFAULT 'active',
      score DOUBLE PRECISION,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
}

function patchRow(baseUrl, table, pk, patch) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pk, patch }),
  });
}

function insertRow(baseUrl, table, values) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
}

function deleteRow(baseUrl, table, pk) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pk }),
  });
}

console.log("@indigodb/cli studio-write: PGlite-backed row-write integration suite (UPDATE only)");

// ─── UPDATE by single-column primary key ───────────────────────────────────
await check("PATCH updates a row by single-column primary key", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: "updated bio" });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.row.bio === "updated bio", `expected updated bio, got ${JSON.stringify(body.row)}`);
    });

    const row = await db.query(`SELECT bio FROM "User" WHERE id = 1`);
    assert(row.rows[0].bio === "updated bio", "expected the persisted value to be updated");
    const other = await db.query(`SELECT bio FROM "User" WHERE id = 2`);
    assert(other.rows[0].bio === "world", "expected the other row to be untouched");
  });
});

// ─── UPDATE by composite primary key ───────────────────────────────────────
await check("PATCH updates exactly one row by composite primary key", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "Membership", { userId: 1, orgId: 2 }, { role: "owner" });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.row.role === "owner", `expected role owner, got ${JSON.stringify(body.row)}`);
    });

    const changed = await db.query(`SELECT role FROM "Membership" WHERE "userId" = 1 AND "orgId" = 2`);
    assert(changed.rows[0].role === "owner", "expected the targeted row to be updated");
    const untouched = await db.query(`SELECT role FROM "Membership" WHERE "userId" = 1 AND "orgId" = 1`);
    assert(untouched.rows[0].role === "member", "expected the other composite-key row to be untouched");
  });
});

// ─── Composite PK: partial key is rejected ─────────────────────────────────
await check("PATCH with only one of two composite key values is rejected (4xx), no row changed", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "Membership", { userId: 1 }, { role: "owner" });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const rows = await db.query(`SELECT role FROM "Membership" ORDER BY "orgId"`);
    assert(
      rows.rows.every((r) => r.role === "member" || r.role === "admin"),
      "expected no membership row to have changed",
    );
  });
});

// ─── Unknown table name is rejected ────────────────────────────────────────
await check("PATCH against an unknown table is rejected (4xx) and executes no SQL", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "NoSuchTable", { id: 1 }, { bio: "x" });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === "string" && body.error.length > 0, "expected an error message");
    });
  });
});

// ─── Unknown column name is rejected ───────────────────────────────────────
await check("PATCH with an unknown column in the patch body is rejected (4xx), no row changed", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "User", { id: 1 }, { "nope; DROP TABLE \"User\"": "x" });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 2, "expected the User table to still exist with both rows");
  });
});

// ─── Generated/autoincrement column in patch is rejected ──────────────────
await check(
  "PATCH attempting to write the autoincrement primary key column is rejected (4xx), no row changed",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await patchRow(baseUrl, "User", { id: 1 }, { id: 999 });
        assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      });

      const row = await db.query(`SELECT id FROM "User" WHERE email = 'a@example.com'`);
      assert(row.rows[0].id === 1, "expected the primary key to be unchanged");
    });
  },
);

// ─── Nullable column round-trips through null ──────────────────────────────
await check("PATCH sets a nullable column to null and it persists as NULL, not an empty string", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: null });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.row.bio === null, `expected null bio in response, got ${JSON.stringify(body.row.bio)}`);
    });

    const row = await db.query(`SELECT bio FROM "User" WHERE id = 1`);
    assert(row.rows[0].bio === null, "expected the persisted bio to be NULL");
  });
});

// ─── Invalid JSON body is rejected ─────────────────────────────────────────
await check("PATCH with an invalid JSON body is rejected (4xx), no row changed", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const row = await db.query(`SELECT bio FROM "User" WHERE id = 1`);
    assert(row.rows[0].bio === "hello", "expected the row to be untouched");
  });
});

// ─── INSERT: generated primary key is omitted and returned ────────────────
await check("POST inserts a row, omitting the generated primary key, and returns it generated", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await insertRow(baseUrl, "User", { email: "c@example.com", bio: "new" });
      assert(res.status === 201, `expected 201, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.row.id === "number", `expected a generated numeric id, got ${JSON.stringify(body.row.id)}`);
      assert(body.row.email === "c@example.com", "expected the inserted email back");
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 3, "expected the new row to be persisted alongside the seeded two");
  });
});

// ─── INSERT: composite primary key requires both key values ───────────────
await check("POST inserts a row with a composite primary key", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await insertRow(baseUrl, "Membership", { userId: 2, orgId: 1, role: "member" });
      assert(res.status === 201, `expected 201, got ${res.status}`);
      const body = await res.json();
      assert(body.row.role === "member", `expected role member, got ${JSON.stringify(body.row)}`);
    });

    const inserted = await db.query(`SELECT role FROM "Membership" WHERE "userId" = 2 AND "orgId" = 1`);
    assert(inserted.rows.length === 1, "expected the new composite-key row to exist");
    const untouched = await db.query(`SELECT count(*)::int AS n FROM "Membership"`);
    assert(untouched.rows[0].n === 3, "expected the two seeded rows plus the new one");
  });
});

// ─── INSERT: explicit generated primary key value is rejected ─────────────
await check(
  "POST with an explicit value for the generated primary key column is rejected (4xx), no row inserted",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await insertRow(baseUrl, "User", { id: 999, email: "d@example.com" });
        assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      });

      const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
      assert(rows.rows[0].n === 2, "expected no new row to have been inserted");
    });
  },
);

// ─── INSERT: unknown table name is rejected ────────────────────────────────
await check("POST against an unknown table is rejected (4xx) and executes no SQL", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await insertRow(baseUrl, "NoSuchTable", { email: "x@example.com" });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === "string" && body.error.length > 0, "expected an error message");
    });
  });
});

// ─── INSERT: unknown column name is rejected ───────────────────────────────
await check("POST with an unknown column in the body is rejected (4xx), no row inserted", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await insertRow(baseUrl, "User", { "nope; DROP TABLE \"User\"": "x", email: "e@example.com" });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 2, "expected the User table to still exist with both original rows");
  });
});

// ─── INSERT: nullable/JSON/enum-like/boolean/date values round-trip ───────
await check(
  "POST round-trips nullable, JSON, boolean, and date values as the widget registry's parse() would produce them",
  async () => {
    await withDatabase(async (db) => {
      await seedWidgets(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await insertRow(baseUrl, "Widget", {
          label: "gadget",
          verified: true,
          metadata: { color: "red", count: 3 },
          status: "active",
          score: null,
          createdAt: "2026-01-15T12:00:00.000Z",
        });
        assert(res.status === 201, `expected 201, got ${res.status}`);
        const body = await res.json();
        assert(body.row.verified === true, `expected verified=true, got ${JSON.stringify(body.row.verified)}`);
        assert(
          body.row.metadata && body.row.metadata.color === "red" && body.row.metadata.count === 3,
          `expected the JSON object to round-trip, got ${JSON.stringify(body.row.metadata)}`,
        );
        assert(body.row.status === "active", `expected status=active, got ${JSON.stringify(body.row.status)}`);
        assert(body.row.score === null, `expected score=null, got ${JSON.stringify(body.row.score)}`);
      });

      const row = await db.query(`SELECT verified, metadata, status, score FROM "Widget" WHERE label = 'gadget'`);
      assert(row.rows[0].verified === true, "expected verified to persist as true");
      assert(row.rows[0].score === null, "expected score to persist as NULL");
    });
  },
);

// ─── Regression: write routes never use the read-only pool/connection ─────
await check(
  "the read-only guard is unaffected by the new writable pool: read-only regression still passes",
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
      });

      const remaining = await db.query(`SELECT count(*)::int AS n FROM "User"`);
      assert(remaining.rows[0].n === 2, "expected both seeded rows to survive the rejected DELETE");
    });
  },
);

// ─── DELETE removes exactly one row by single-column primary key ─────────
await check("DELETE removes exactly one row by single-column primary key", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "User", { id: 1 });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });

    const remaining = await db.query(`SELECT id FROM "User" ORDER BY id`);
    assert(remaining.rows.length === 1, `expected 1 remaining row, got ${remaining.rows.length}`);
    assert(remaining.rows[0].id === 2, "expected the other row to be untouched");
  });
});

// ─── DELETE removes exactly one row by composite primary key ─────────────
await check("DELETE removes exactly one row by composite primary key", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "Membership", { userId: 1, orgId: 2 });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });

    const remaining = await db.query(`SELECT "userId", "orgId" FROM "Membership"`);
    assert(remaining.rows.length === 1, `expected 1 remaining row, got ${remaining.rows.length}`);
    assert(remaining.rows[0].orgId === 1, "expected the other composite-key row to be untouched");
  });
});

// ─── DELETE with only one of two composite key values is rejected ────────
await check("DELETE with only one of two composite key values is rejected (4xx), no row removed", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "Membership", { userId: 1 });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "Membership"`);
    assert(rows.rows[0].n === 2, "expected both membership rows to still exist");
  });
});

// ─── DELETE against an unknown table is rejected ──────────────────────────
await check("DELETE against an unknown table is rejected (4xx) and executes no SQL", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "NoSuchTable", { id: 1 });
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === "string" && body.error.length > 0, "expected an error message");
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 2, "expected the User table to still exist with both rows");
  });
});

// ─── DELETE with a missing/empty pk is rejected ───────────────────────────
await check("DELETE with a missing primary key value is rejected (4xx), no row removed", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "User", {});
      assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 2, "expected both users to still exist");
  });
});

// ─── DELETE for a non-existent pk value is a 404, not a silent success ────
await check("DELETE for a primary key value that matches no row responds 404, no row removed", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await deleteRow(baseUrl, "User", { id: 999 });
      assert(res.status === 404, `expected 404, got ${res.status}`);
    });

    const rows = await db.query(`SELECT count(*)::int AS n FROM "User"`);
    assert(rows.rows[0].n === 2, "expected both users to still exist");
  });
});

await check(
  "GET /api/tables/:name immediately after a successful PATCH is unaffected by the write routes' existence",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const patchRes = await patchRow(baseUrl, "User", { id: 1 }, { bio: "post-write read check" });
        assert(patchRes.status === 200, `expected 200, got ${patchRes.status}`);

        const res = await fetch(`${baseUrl}/api/tables/User`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        assert(body.columns.includes("createdAt"), "expected the aliased field name createdAt in columns");
        assert(body.rows.length === 2, `expected 2 rows, got ${body.rows.length}`);
      });
    });
  },
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("\nAll studio-write checks passed.");
}
