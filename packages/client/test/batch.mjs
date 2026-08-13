/**
 * @indigodb/client — batch mutations (PR A, client-batch-aggregate).
 *
 * `ModelDelegate.createMany`/`updateMany`/`deleteMany` (design.md "SQL
 * shapes", client-batch-mutations spec). All three reuse the existing
 * `Params`/`quote`/`buildWhere` builders — no second WHERE compiler.
 *
 * Layout:
 *  - A.1: `createMany([])` throws `IndigoArgumentError` code `EMPTY_BATCH`
 *    before any SQL is issued.
 *  - A.2: `updateMany`/`deleteMany` with an absent or empty `where` throw
 *    `IndigoWhereError` code `EMPTY_WHERE` before any SQL is issued (spec
 *    Requirement "updateMany and deleteMany require a non-empty where").
 *  - A.3: `createMany` emits a single multi-row `INSERT ... VALUES
 *    (...),(...) RETURNING 1`, `Params`-bound, `count = rows.length`.
 *  - A.4: `updateMany`/`deleteMany` reuse `buildWhere`, return
 *    `{ count: rows.length }` via `RETURNING 1`.
 *  - A.8: PGlite integration — real counts for the happy paths.
 */

import { IndigoWhereError, IndigoArgumentError, ModelDelegate } from "../dist/delegate.js";
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

const tagMeta = {
  name: "Tag",
  table: "Tag",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
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

async function seed(db) {
  await db.exec(`
    CREATE TABLE "Tag" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
  `);
}

async function seedUnique(db) {
  await db.exec(`
    CREATE TABLE "Tag" (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  `);
}

console.log("@indigodb/client: batch mutations (createMany/updateMany/deleteMany)");

// ─── A.1: createMany([]) throws EMPTY_BATCH before exec ───────────────────

await check("A.1: createMany([]) throws IndigoArgumentError code EMPTY_BATCH before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const Tag = new ModelDelegate(tagMeta, exec);
  let threw = false;
  try {
    await Tag.createMany({ data: [] });
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
    assert(err.code === "EMPTY_BATCH", `expected code EMPTY_BATCH, got ${err.code}`);
  }
  assert(threw, "expected createMany([]) to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued for an empty batch");
});

// ─── A.2: updateMany/deleteMany with absent/{} where throw EMPTY_WHERE ────

await check("A.2a: updateMany with no where throws IndigoWhereError code EMPTY_WHERE before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const Tag = new ModelDelegate(tagMeta, exec);
  let threw = false;
  try {
    await Tag.updateMany({ data: { name: "x" } });
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoWhereError, "expected an IndigoWhereError");
    assert(err.code === "EMPTY_WHERE", `expected code EMPTY_WHERE, got ${err.code}`);
  }
  assert(threw, "expected updateMany() to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued");
});

await check("A.2b: updateMany with where: {} throws IndigoWhereError code EMPTY_WHERE before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const Tag = new ModelDelegate(tagMeta, exec);
  let threw = false;
  try {
    await Tag.updateMany({ where: {}, data: { name: "x" } });
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoWhereError, "expected an IndigoWhereError");
    assert(err.code === "EMPTY_WHERE", `expected code EMPTY_WHERE, got ${err.code}`);
  }
  assert(threw, "expected updateMany() to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued");
});

await check("A.2c: deleteMany with no where throws IndigoWhereError code EMPTY_WHERE before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const Tag = new ModelDelegate(tagMeta, exec);
  let threw = false;
  try {
    await Tag.deleteMany({});
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoWhereError, "expected an IndigoWhereError");
    assert(err.code === "EMPTY_WHERE", `expected code EMPTY_WHERE, got ${err.code}`);
  }
  assert(threw, "expected deleteMany() to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued");
});

await check("A.2d: deleteMany with where: {} throws IndigoWhereError code EMPTY_WHERE before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const Tag = new ModelDelegate(tagMeta, exec);
  let threw = false;
  try {
    await Tag.deleteMany({ where: {} });
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoWhereError, "expected an IndigoWhereError");
    assert(err.code === "EMPTY_WHERE", `expected code EMPTY_WHERE, got ${err.code}`);
  }
  assert(threw, "expected deleteMany() to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued");
});

// ─── A.3: createMany emits a single multi-row INSERT ... RETURNING 1 ─────

await check("A.3: createMany emits one multi-row INSERT ... VALUES (...),(...) RETURNING 1, Params-bound", async () => {
  const { exec, calls } = stubExecutor([{ "?column?": 1 }, { "?column?": 1 }]);
  const Tag = new ModelDelegate(tagMeta, exec);
  const result = await Tag.createMany({ data: [{ name: "a" }, { name: "b" }] });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(
    calls[0].sql === 'INSERT INTO "Tag" ("name") VALUES ($1), ($2) RETURNING 1',
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(
    calls[0].params.length === 2 && calls[0].params[0] === "a" && calls[0].params[1] === "b",
    `unexpected params: ${JSON.stringify(calls[0].params)}`,
  );
  assert(result.count === 2, `expected count 2, got ${result.count}`);
});

// ─── A.4: updateMany/deleteMany reuse buildWhere, return count via RETURNING 1 ──

await check("A.4a: updateMany reuses buildWhere and returns { count: rows.length } via RETURNING 1", async () => {
  const { exec, calls } = stubExecutor([{ "?column?": 1 }]);
  const Tag = new ModelDelegate(tagMeta, exec);
  const result = await Tag.updateMany({ where: { name: "x" }, data: { name: "y" } });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(
    calls[0].sql === 'UPDATE "Tag" SET "name" = $1 WHERE "name" = $2 RETURNING 1',
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(result.count === 1, `expected count 1, got ${result.count}`);
});

await check("A.4b: deleteMany reuses buildWhere and returns { count: rows.length } via RETURNING 1", async () => {
  const { exec, calls } = stubExecutor([{ "?column?": 1 }, { "?column?": 1 }]);
  const Tag = new ModelDelegate(tagMeta, exec);
  const result = await Tag.deleteMany({ where: { name: "x" } });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(calls[0].sql === 'DELETE FROM "Tag" WHERE "name" = $1 RETURNING 1', `unexpected SQL: ${calls[0].sql}`);
  assert(result.count === 2, `expected count 2, got ${result.count}`);
});

// ─── A.8: PGlite integration — real counts ────────────────────────────────

await check("A.8a: createMany inserts all rows together and resolves with the real count", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const Tag = new ModelDelegate(tagMeta, exec);
    const result = await Tag.createMany({ data: [{ name: "a" }, { name: "b" }] });
    assert(result.count === 2, `expected count 2, got ${result.count}`);
    const rows = await Tag.findMany({});
    assert(rows.length === 2, `expected 2 rows persisted, got ${rows.length}`);
  });
});

await check("A.8b: createMany's constraint violation fails the whole batch — no partial insert", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUnique(db);
    const Tag = new ModelDelegate(tagMeta, exec);
    await Tag.createMany({ data: [{ name: "a" }] });
    let threw = false;
    try {
      await Tag.createMany({ data: [{ name: "b" }, { name: "a" }] });
    } catch {
      threw = true;
    }
    assert(threw, "expected the batch insert to reject on the unique-constraint violation");
    const rows = await Tag.findMany({});
    assert(rows.length === 1, `expected no row from the failed batch to persist, got ${rows.length}`);
  });
});

await check("A.8c: updateMany updates every matching row and returns the real count", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const Tag = new ModelDelegate(tagMeta, exec);
    await Tag.createMany({ data: [{ name: "x" }, { name: "y" }] });
    const result = await Tag.updateMany({ where: { name: { in: ["x", "y"] } }, data: { name: "z" } });
    assert(result.count === 2, `expected count 2, got ${result.count}`);
  });
});

await check("A.8d: deleteMany reports zero when nothing matches, does not throw", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const Tag = new ModelDelegate(tagMeta, exec);
    const result = await Tag.deleteMany({ where: { name: "missing" } });
    assert(result.count === 0, `expected count 0, got ${result.count}`);
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client batch: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client batch: all checks passed");
}
