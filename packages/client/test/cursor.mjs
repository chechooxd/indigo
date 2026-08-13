/**
 * @indigodb/client — cursor pagination (PR B, client-batch-aggregate).
 *
 * `ModelDelegate.findMany({ cursor, take })` (design.md "SQL shapes",
 * client-cursor-pagination spec). Single-column primary key only —
 * composite (or absent) primary keys throw a typed error before any SQL is
 * issued (runtime pk-count guard, design.md Decision #7).
 *
 * Layout:
 *  - B.1: composite-PK model + `cursor` throws `IndigoArgumentError` code
 *    `CURSOR_COMPOSITE_PK` before `exec`.
 *  - B.2: no-PK model + `cursor` throws code `CURSOR_NO_PK` before `exec`.
 *  - B.3: single-PK model: `cursor` + `skip: 1` (implicit or explicit) emits
 *    `WHERE ... AND "pk" >= $c` and appends `"pk" <dir>` as the final
 *    `ORDER BY` term only when absent from a user `orderBy`.
 *  - B.4: cursor combines correctly with existing `where`/`orderBy`/`take`.
 *  - B.8: PGlite integration — stable pagination across pages.
 */

import { IndigoArgumentError, ModelDelegate } from "../dist/delegate.js";
import { withDatabase, createPgliteExecutor } from "./pglite-harness.mjs";

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

const postMeta = {
  name: "Post",
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    createdAt: { db: "createdAt" },
  },
};

const noPkMeta = {
  name: "Log",
  table: "Log",
  fields: {
    message: { db: "message" },
  },
};

const enrollmentMeta = {
  name: "Enrollment",
  table: "Enrollment",
  fields: {
    studentId: { db: "studentId", pk: true },
    courseId: { db: "courseId", pk: true },
    grade: { db: "grade" },
  },
};

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

async function seedPosts(db, count) {
  await db.exec(`
    CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now());
  `);
  for (let i = 1; i <= count; i++) {
    await db.exec(`INSERT INTO "Post" (id, title) OVERRIDING SYSTEM VALUE VALUES (${i}, 'p${i}');`);
  }
  await db.exec(`SELECT setval('"Post_id_seq"', ${count});`);
}

console.log("@indigodb/client: cursor pagination");

// ─── B.1: composite-PK model + cursor throws CURSOR_COMPOSITE_PK ──────────

await check(
  "B.1: composite-PK model with cursor throws IndigoArgumentError code CURSOR_COMPOSITE_PK before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const Enrollment = new ModelDelegate(enrollmentMeta, exec);
    let threw = false;
    try {
      await Enrollment.findMany({ cursor: { studentId: 1, courseId: 2 }, take: 5 });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "CURSOR_COMPOSITE_PK", `expected code CURSOR_COMPOSITE_PK, got ${err.code}`);
    }
    assert(threw, "expected findMany({ cursor }) to reject on a composite-PK model");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

await check("B.1b: composite-PK model still supports offset pagination unaffected", async () => {
  const { exec, calls } = stubExecutor();
  const Enrollment = new ModelDelegate(enrollmentMeta, exec);
  await Enrollment.findMany({ skip: 10, take: 5 });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(!calls[0].sql.includes(">="), `expected no cursor clause in SQL: ${calls[0].sql}`);
});

// ─── B.2: no-PK model + cursor throws CURSOR_NO_PK ─────────────────────────

await check(
  "B.2: no-PK model with cursor throws IndigoArgumentError code CURSOR_NO_PK before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const Log = new ModelDelegate(noPkMeta, exec);
    let threw = false;
    try {
      await Log.findMany({ cursor: { message: "x" }, take: 5 });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "CURSOR_NO_PK", `expected code CURSOR_NO_PK, got ${err.code}`);
    }
    assert(threw, "expected findMany({ cursor }) to reject on a no-PK model");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── B.3: single-PK model emits WHERE ... AND "pk" >= $c, ORDER BY appended ─

await check(
  "B.3a: cursor with implicit skip emits WHERE pk >= $c, ORDER BY pk ASC appended, OFFSET 1",
  async () => {
    const { exec, calls } = stubExecutor();
    const Post = new ModelDelegate(postMeta, exec);
    await Post.findMany({ cursor: { id: 5 }, take: 3 });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    const { sql, params } = calls[0];
    assert(
      sql === 'SELECT "id" AS "id", "title" AS "title", "createdAt" AS "createdAt" FROM "Post" ' +
        'WHERE "id" >= $1 ORDER BY "id" ASC LIMIT $2 OFFSET $3',
      `unexpected SQL: ${sql}`,
    );
    assert(
      params.length === 3 && params[0] === 5 && params[1] === 3 && params[2] === 1,
      `unexpected params: ${JSON.stringify(params)}`,
    );
  },
);

await check("B.3b: explicit skip: 0 with cursor is respected (not overridden to 1)", async () => {
  const { exec, calls } = stubExecutor();
  const Post = new ModelDelegate(postMeta, exec);
  await Post.findMany({ cursor: { id: 5 }, take: 3, skip: 0 });
  const { sql, params } = calls[0];
  assert(sql.endsWith("OFFSET $3"), `expected an explicit OFFSET clause: ${sql}`);
  assert(params[2] === 0, `expected OFFSET param 0, got ${params[2]}`);
});

await check(
  "B.3c: cursor pk already present in user orderBy is not duplicated, its direction sets the comparison operator",
  async () => {
    const { exec, calls } = stubExecutor();
    const Post = new ModelDelegate(postMeta, exec);
    await Post.findMany({ cursor: { id: 5 }, take: 3, orderBy: { id: "desc" } });
    const { sql } = calls[0];
    assert(sql.includes('"id" <= $1'), `expected a descending cursor comparison: ${sql}`);
    assert(sql.includes('ORDER BY "id" DESC'), `expected ORDER BY id DESC (not duplicated): ${sql}`);
    assert((sql.match(/"id" DESC/g) ?? []).length === 1, `expected "id" DESC exactly once: ${sql}`);
  },
);

// ─── B.4: cursor combines with where/orderBy/take (all reused unmodified) ──

await check(
  "B.4: cursor combines correctly with an explicit orderBy, where, and take",
  async () => {
    const { exec, calls } = stubExecutor();
    const Post = new ModelDelegate(postMeta, exec);
    await Post.findMany({
      where: { title: "hello" },
      orderBy: { createdAt: "asc" },
      cursor: { id: 5 },
      take: 3,
    });
    const { sql, params } = calls[0];
    assert(
      sql === 'SELECT "id" AS "id", "title" AS "title", "createdAt" AS "createdAt" FROM "Post" ' +
        'WHERE "title" = $1 AND "id" >= $2 ORDER BY "createdAt" ASC, "id" ASC LIMIT $3 OFFSET $4',
      `unexpected SQL: ${sql}`,
    );
    assert(
      params.length === 4 && params[0] === "hello" && params[1] === 5 && params[2] === 3 && params[3] === 1,
      `unexpected params: ${JSON.stringify(params)}`,
    );
  },
);

await check("B.4b: no cursor means no behavior change for single-PK models", async () => {
  const { exec, calls } = stubExecutor();
  const Post = new ModelDelegate(postMeta, exec);
  await Post.findMany({ take: 10 });
  const { sql, params } = calls[0];
  assert(
    sql === 'SELECT "id" AS "id", "title" AS "title", "createdAt" AS "createdAt" FROM "Post" LIMIT $1',
    `unexpected SQL: ${sql}`,
  );
  assert(params.length === 1 && params[0] === 10, `unexpected params: ${JSON.stringify(params)}`);
});

// ─── B.8: PGlite integration — stable pagination across pages ─────────────

await check("B.8a: cursor pages forward from the given row (ids 6,7,8)", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedPosts(db, 10);
    const Post = new ModelDelegate(postMeta, exec);
    const page = await Post.findMany({ cursor: { id: 5 }, take: 3 });
    assert(
      page.length === 3 && page[0].id === 6 && page[1].id === 7 && page[2].id === 8,
      `unexpected page: ${JSON.stringify(page)}`,
    );
  });
});

await check("B.8b: cursor pointing at a nonexistent row yields an empty page, does not throw", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedPosts(db, 10);
    const Post = new ModelDelegate(postMeta, exec);
    const page = await Post.findMany({ cursor: { id: 999 }, take: 5 });
    assert(Array.isArray(page) && page.length === 0, `expected empty page, got ${JSON.stringify(page)}`);
  });
});

await check("B.8c: paginating page-by-page with the last row's id as next cursor covers every row once", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedPosts(db, 10);
    const Post = new ModelDelegate(postMeta, exec);
    const seen = [];
    let cursor;
    for (;;) {
      const args = cursor !== undefined ? { cursor: { id: cursor }, take: 3 } : { take: 3 };
      const page = await Post.findMany(args);
      if (page.length === 0) break;
      for (const row of page) seen.push(row.id);
      cursor = page[page.length - 1].id;
      if (page.length < 3) break;
    }
    assert(
      seen.length === 10 && seen.every((id, i) => id === i + 1),
      `expected ids 1..10 exactly once each in order, got ${JSON.stringify(seen)}`,
    );
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client cursor: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client cursor: all checks passed");
}
