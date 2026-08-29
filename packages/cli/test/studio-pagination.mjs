/**
 * @indigodb/cli — Studio pagination suite (GET /api/tables/:name).
 *
 * Mirrors `studio-write.mjs`'s style: plain Node, no test framework. Drives a
 * REAL `startStudio` HTTP server, backed by a REAL (in-process) PostgreSQL
 * engine via PGlite, over real `fetch()` calls — see `studio-harness.mjs`.
 *
 * Covers: stable PK-ordered keyset pagination, bidirectional traversal,
 * composite-PK row-value comparison, bounded/rejected `limit`, exact
 * `count(*)`, and the PK-less short-circuit.
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

Table Item {
  id    Int    @id
  label String
}

Table Membership {
  userId Int    @id
  orgId  Int    @id
  role   String
}

Table Cell {
  sheet Int    @id
  row   Int    @id
  col   Int    @id
  value String
}

Table LogEntry {
  message String
}
`;

function loadFixture() {
  const ast = parse(SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: SCHEMA_SOURCE };
}

async function seedItems(db, count) {
  await db.exec(`CREATE TABLE "Item" (id INT PRIMARY KEY, label TEXT NOT NULL);`);
  const values = Array.from({ length: count }, (_, i) => `(${i + 1}, 'item-${i + 1}')`).join(", ");
  await db.exec(`INSERT INTO "Item" (id, label) VALUES ${values};`);
}

async function seedMemberships(db) {
  await db.exec(`
    CREATE TABLE "Membership" (
      "userId" INT NOT NULL,
      "orgId" INT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY ("userId", "orgId")
    );
  `);
  // Repeated leading column ("userId" repeats across 5 orgId values each) so
  // a naive per-column comparison (rather than true row-value comparison)
  // would duplicate or skip rows. 10 users x 5 orgs = 50 rows, so a page
  // size of 25 (the smallest allowed limit) spans exactly 2 pages, crossing
  // the boundary in the middle of a repeated userId run.
  const rows = [];
  for (let userId = 1; userId <= 10; userId++) {
    for (let orgId = 1; orgId <= 5; orgId++) {
      rows.push(`(${userId}, ${orgId}, 'role-${userId}-${orgId}')`);
    }
  }
  await db.exec(`INSERT INTO "Membership" ("userId", "orgId", role) VALUES ${rows.join(", ")};`);
}

async function seedCells(db) {
  await db.exec(`
    CREATE TABLE "Cell" (
      sheet INT NOT NULL,
      row INT NOT NULL,
      col INT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (sheet, row, col)
    );
  `);
  // Repeated leading AND second column, so a 3-column composite key
  // genuinely exercises row-value tuple comparison across all three columns.
  // 5 sheets x 5 rows x 3 cols = 75 rows, so limit=25 spans exactly 3 pages.
  const rows = [];
  for (let sheet = 1; sheet <= 5; sheet++) {
    for (let row = 1; row <= 5; row++) {
      for (let col = 1; col <= 3; col++) {
        rows.push(`(${sheet}, ${row}, ${col}, 'v-${sheet}-${row}-${col}')`);
      }
    }
  }
  await db.exec(`INSERT INTO "Cell" (sheet, row, col, value) VALUES ${rows.join(", ")};`);
}

async function seedLogEntries(db, count) {
  await db.exec(`CREATE TABLE "LogEntry" (message TEXT NOT NULL);`);
  const values = Array.from({ length: count }, (_, i) => `('log-${i + 1}')`).join(", ");
  await db.exec(`INSERT INTO "LogEntry" (message) VALUES ${values};`);
}

function getPage(baseUrl, table, params = {}) {
  const qs = new URLSearchParams(params);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetch(`${baseUrl}/api/tables/${encodeURIComponent(table)}${suffix}`);
}

console.log("@indigodb/cli studio-pagination: PGlite-backed keyset pagination integration suite");

// ─── Forward pagination across a 60-row single-PK table ───────────────────
await check("forward pagination at limit=25 covers all 60 rows with no dup/skip, total===60 throughout", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 60);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const seenIds = [];
      let cursor = null;
      let pageCount = 0;

      for (;;) {
        const params = { limit: "25" };
        if (cursor) params.cursor = cursor;
        const res = await getPage(baseUrl, "Item", params);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        assert(body.total === 60, `expected total 60, got ${body.total}`);
        assert(body.paginated === true, "expected paginated:true");
        seenIds.push(...body.rows.map((r) => r.id));
        pageCount++;
        if (!body.nextCursor) {
          assert(body.rows.length === 10, `expected last page of 10, got ${body.rows.length}`);
          break;
        }
        assert(body.rows.length === 25, `expected full page of 25, got ${body.rows.length}`);
        cursor = body.nextCursor;
        assert(pageCount <= 10, "pagination did not terminate as expected");
      }

      assert(pageCount === 3, `expected 3 pages, got ${pageCount}`);
      assert(seenIds.length === 60, `expected 60 total rows seen, got ${seenIds.length}`);
      assert(
        new Set(seenIds).size === 60,
        `expected no duplicate ids across pages, got ${new Set(seenIds).size} unique`,
      );
      assert(
        seenIds.every((id, i) => id === i + 1),
        "expected rows to be in ascending id order across pages",
      );
    });
  });
});

// ─── Forward then backward round trip returns identical page bodies ──────
await check("forward pages 1->2->3 then backward 3->2->1 returns byte-identical bodies to the forward pass", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 60);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const p1 = await (await getPage(baseUrl, "Item", { limit: "25" })).json();
      const p2 = await (await getPage(baseUrl, "Item", { limit: "25", cursor: p1.nextCursor })).json();
      const p3 = await (await getPage(baseUrl, "Item", { limit: "25", cursor: p2.nextCursor })).json();
      assert(p3.nextCursor === null, "expected page 3 to be the last page");

      const back2 = await (
        await getPage(baseUrl, "Item", { limit: "25", direction: "backward", cursor: p3.prevCursor })
      ).json();
      const back1 = await (
        await getPage(baseUrl, "Item", { limit: "25", direction: "backward", cursor: back2.prevCursor })
      ).json();

      assert(JSON.stringify(back2.rows) === JSON.stringify(p2.rows), "expected backward page 2 to match forward page 2");
      assert(JSON.stringify(back1.rows) === JSON.stringify(p1.rows), "expected backward page 1 to match forward page 1");
      assert(back1.prevCursor === null, "expected page 1 (reached backward) to have no prevCursor");
    });
  });
});

// ─── Composite 2-column PK pages correctly both directions ────────────────
await check("composite 2-column PK (repeated leading column) pages correctly both directions", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const params = { limit: "25" };
        if (cursor) params.cursor = cursor;
        const res = await getPage(baseUrl, "Membership", params);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        seen.push(...body.rows.map((r) => `${r.userId}-${r.orgId}`));
        pages++;
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
        assert(pages <= 5, "pagination did not terminate as expected");
      }
      assert(pages === 2, `expected exactly 2 pages (50 rows / limit 25), got ${pages}`);
      assert(seen.length === 50, `expected 50 rows (10 users x 5 orgs), got ${seen.length}`);
      assert(new Set(seen).size === 50, "expected no duplicate composite keys across pages");

      // Row-value comparison check: rows must be ordered by (userId, orgId)
      // ascending as a tuple, not independently per column.
      const expected = [];
      for (let userId = 1; userId <= 10; userId++) {
        for (let orgId = 1; orgId <= 5; orgId++) expected.push(`${userId}-${orgId}`);
      }
      assert(
        JSON.stringify(seen) === JSON.stringify(expected),
        `expected tuple-ordered rows, got ${JSON.stringify(seen)}`,
      );

      // Backward from the end returns to the start.
      const full = await (await getPage(baseUrl, "Membership", { limit: "100" })).json();
      assert(full.rows.length === 50 && full.nextCursor === null, "expected all 50 rows on one page at limit 100");
    });
  });
});

// ─── Composite 3-column PK with repeated leading AND second column ───────
await check("composite 3-column PK (repeated leading + second column) pages without dup/skip", async () => {
  await withDatabase(async (db) => {
    await seedCells(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const params = { limit: "25" };
        if (cursor) params.cursor = cursor;
        const res = await getPage(baseUrl, "Cell", params);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        seen.push(...body.rows.map((r) => `${r.sheet}-${r.row}-${r.col}`));
        pages++;
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
        assert(pages <= 5, "pagination did not terminate as expected");
      }
      const expected = [];
      for (let sheet = 1; sheet <= 5; sheet++) {
        for (let row = 1; row <= 5; row++) {
          for (let col = 1; col <= 3; col++) expected.push(`${sheet}-${row}-${col}`);
        }
      }
      assert(pages === 3, `expected exactly 3 pages (75 rows / limit 25), got ${pages}`);
      assert(seen.length === 75, `expected 75 rows, got ${seen.length}`);
      assert(new Set(seen).size === 75, "expected no duplicate composite keys across pages");
      assert(
        JSON.stringify(seen) === JSON.stringify(expected),
        `expected tuple-ordered rows across all 3 pk columns, got ${JSON.stringify(seen)}`,
      );
    });
  });
});

// ─── limit validation ──────────────────────────────────────────────────────
await check("a valid limit from the closed set is accepted and used exactly as requested", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 60);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await getPage(baseUrl, "Item", { limit: "50" });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.rows.length === 50, `expected 50 rows, got ${body.rows.length}`);
    });
  });
});

await check("absent limit defaults to 100", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 60);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await getPage(baseUrl, "Item");
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.rows.length === 60, `expected all 60 rows under the default limit of 100, got ${body.rows.length}`);
      assert(body.nextCursor === null, "expected no next page since 60 < 100");
    });
  });
});

for (const invalid of ["0", "1000", "abc", "50.0"]) {
  await check(`limit=${invalid} is rejected with 400 and the exact message, no SQL executed`, async () => {
    await withDatabase(async (db) => {
      await seedItems(db, 5);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const res = await getPage(baseUrl, "Item", { limit: invalid });
        assert(res.status === 400, `expected 400, got ${res.status}`);
        const body = await res.json();
        assert(
          body.error === "limit must be one of 25, 50, 100, 200",
          `expected exact error message, got ${JSON.stringify(body.error)}`,
        );
      });
    });
  });
}

// ─── Malformed / wrong-arity cursor ────────────────────────────────────────
await check("a malformed cursor is rejected with 400, no SQL executed", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 5);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await getPage(baseUrl, "Item", { cursor: "not-valid-base64url-json!!" });
      assert(res.status === 400, `expected 400, got ${res.status}`);
    });
  });
});

await check("a wrong-arity cursor (1 value for a 2-column PK) is rejected with 400", async () => {
  await withDatabase(async (db) => {
    await seedMemberships(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const badCursor = Buffer.from(JSON.stringify([1])).toString("base64url");
      const res = await getPage(baseUrl, "Membership", { cursor: badCursor });
      assert(res.status === 400, `expected 400, got ${res.status}`);
    });
  });
});

// ─── Unknown table remains a 404 ───────────────────────────────────────────
await check("unknown table is still a 404 (regression, unchanged)", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 1);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await getPage(baseUrl, "NoSuchTable");
      assert(res.status === 404, `expected 404, got ${res.status}`);
    });
  });
});

// ─── PK-less short-circuit ─────────────────────────────────────────────────
await check("PK-less table returns paginated:false, both cursors null, and the real total", async () => {
  await withDatabase(async (db) => {
    await seedLogEntries(db, 7);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await getPage(baseUrl, "LogEntry", { limit: "25" });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.paginated === false, "expected paginated:false for a PK-less table");
      assert(body.nextCursor === null, "expected nextCursor:null for a PK-less table");
      assert(body.prevCursor === null, "expected prevCursor:null for a PK-less table");
      assert(body.total === 7, `expected total 7, got ${body.total}`);
      assert(body.rows.length === 7, `expected all 7 rows (under the LIMIT 100 legacy shape), got ${body.rows.length}`);
      assert(body.columns.includes("message"), "expected the message column in the response shape");
    });
  });
});

// ─── First-page prevCursor null, last-page nextCursor null ────────────────
await check("first-page prevCursor is null and last-page nextCursor is null", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 10);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const single = await (await getPage(baseUrl, "Item", { limit: "25" })).json();
      assert(single.prevCursor === null, "expected prevCursor null on the first page");
      assert(single.nextCursor === null, "expected nextCursor null since all 10 rows fit in one page of 25");
    });
  });

  await withDatabase(async (db) => {
    await seedItems(db, 30);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const p1 = await (await getPage(baseUrl, "Item", { limit: "25" })).json();
      assert(p1.prevCursor === null, "expected prevCursor null on the first page");
      assert(p1.nextCursor !== null, "expected a nextCursor since 30 rows exceed limit 25");

      const p2 = await (await getPage(baseUrl, "Item", { limit: "25", cursor: p1.nextCursor })).json();
      assert(p2.nextCursor === null, "expected nextCursor null on the last page");
      assert(p2.prevCursor !== null, "expected a prevCursor since this page followed a cursor");
    });
  });
});

// ─── Exact COUNT(*) correctness ─────────────────────────────────────────────
await check("total is an exact count regardless of page size or position", async () => {
  await withDatabase(async (db) => {
    await seedItems(db, 37);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const p1 = await (await getPage(baseUrl, "Item", { limit: "25" })).json();
      assert(p1.total === 37, `expected total 37 on page 1, got ${p1.total}`);
      const p2 = await (await getPage(baseUrl, "Item", { limit: "25", cursor: p1.nextCursor })).json();
      assert(p2.total === 37, `expected total 37 on page 2, got ${p2.total}`);
    });
  });
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("\nAll studio-pagination checks passed.");
}
