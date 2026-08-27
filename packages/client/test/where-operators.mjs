/**
 * @indigodb/client — `where` scalar-operator coverage + NULL semantics.
 *
 * Plain Node, no framework, mirroring `where-composition.mjs`'s style.
 *
 * Closes the coverage audit that followed the `contains`/`startsWith`/
 * `endsWith` escaping defect: of the 11 scalar operators `fieldExpr`
 * implements, 7 had no test at all. Four of them (`lt`, `lte`, `gte`,
 * `notIn`) turned out to be correct and are pinned here so they stay that
 * way. The rest exposed the NULL-handling defects this file also covers.
 *
 * NULL semantics (decided with the user, Prisma-compatible):
 *   - `equals: null`  → `IS NULL`. Previously bound null as a parameter, so
 *     `v = $1` was never true and the filter returned nothing — while the
 *     `v: null` shorthand DID compile to `IS NULL`. The same API contradicted
 *     itself depending on which spelling you used.
 *   - `not: null`     → `IS NOT NULL`. Previously `v <> $1`, which is NULL for
 *     every row, so the filter could not match anything in any database.
 *   - `not: <value>`  → also returns rows where the column IS NULL, matching
 *     Prisma. Under plain SQL, `NULL <> 'x'` is unknown, so NULL rows silently
 *     vanished from a filter the caller reads as "everything except x".
 *   - `notIn: [...]`  → same rule as `not`, for the same reason: it is the
 *     other negation operator, and splitting their NULL behaviour would be
 *     arbitrary.
 *
 * Every case round-trips against a real PostgreSQL engine (PGlite): these are
 * claims about which rows come back, not about how the SQL is spelled.
 */

import { ModelDelegate } from "../dist/delegate.js";
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

const numMeta = { name: "N", table: "N", fields: { id: { db: "id", pk: true }, n: { db: "n" } } };
const strMeta = { name: "S", table: "S", fields: { id: { db: "id", pk: true }, v: { db: "v" } } };

/** Seeds an INTEGER column with `values` (nulls allowed), returns a delegate. */
async function withNumbers(db, values) {
  await db.exec(`CREATE TABLE "N" (id SERIAL PRIMARY KEY, n INTEGER);`);
  const d = new ModelDelegate(numMeta, createPgliteExecutor(db));
  for (const n of values) await d.create({ data: { n } });
  return d;
}

/** Seeds a TEXT column with `values` (nulls allowed), returns a delegate. */
async function withStrings(db, values) {
  await db.exec(`CREATE TABLE "S" (id SERIAL PRIMARY KEY, v TEXT);`);
  const d = new ModelDelegate(strMeta, createPgliteExecutor(db));
  for (const v of values) await d.create({ data: { v } });
  return d;
}

/** `col` values matched by `where`, JSON-sorted for order-independent compare. */
async function matched(delegate, where, col) {
  const rows = await delegate.findMany({ where });
  return JSON.stringify(rows.map((r) => r[col]).sort());
}

console.log("client regression: where scalar operators + NULL semantics");

// ─── Comparison operators that had no coverage (verified correct) ───────────

await check("lt / lte / gt / gte return the correct ranges", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, 3]);
    assert((await matched(d, { n: { lt: 3 } }, "n")) === "[1,2]", "lt: 3");
    assert((await matched(d, { n: { lte: 2 } }, "n")) === "[1,2]", "lte: 2");
    assert((await matched(d, { n: { gt: 2 } }, "n")) === "[3]", "gt: 2");
    assert((await matched(d, { n: { gte: 2 } }, "n")) === "[2,3]", "gte: 2");
  });
});

await check("two operators on one field join with AND (gt + lt is a range)", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, 3]);
    assert((await matched(d, { n: { gt: 1, lt: 3 } }, "n")) === "[2]", "expected only 2");
  });
});

await check("in / notIn over a non-null column", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, 3]);
    assert((await matched(d, { n: { in: [1, 2] } }, "n")) === "[1,2]", "in");
    assert((await matched(d, { n: { notIn: [1, 2] } }, "n")) === "[3]", "notIn");
  });
});

await check("empty-array identities: in: [] matches nothing, notIn: [] matches all", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, 3]);
    assert((await matched(d, { n: { in: [] } }, "n")) === "[]", "in: [] must match nothing");
    assert(
      (await matched(d, { n: { notIn: [] } }, "n")) === "[1,2,3]",
      "notIn: [] must match everything",
    );
  });
});

// ─── NULL semantics ─────────────────────────────────────────────────────────

await check("v: null and equals: null agree — both select the NULL row", async () => {
  await withDatabase(async (db) => {
    const d = await withStrings(db, ["alice", null]);
    const shorthand = await matched(d, { v: null }, "v");
    const explicit = await matched(d, { v: { equals: null } }, "v");
    assert(shorthand === "[null]", `v: null should select the NULL row, got ${shorthand}`);
    assert(
      explicit === shorthand,
      `equals: null must agree with the v: null shorthand — got ${explicit} vs ${shorthand}`,
    );
  });
});

await check("not: null selects every non-NULL row (IS NOT NULL)", async () => {
  await withDatabase(async (db) => {
    const d = await withStrings(db, ["alice", "bob", null]);
    const found = await matched(d, { v: { not: null } }, "v");
    assert(found === '["alice","bob"]', `expected the non-NULL rows, got ${found}`);
  });
});

await check("not: <value> includes NULL rows (Prisma-compatible)", async () => {
  await withDatabase(async (db) => {
    const d = await withStrings(db, ["alice", "bob", null]);
    const found = await matched(d, { v: { not: "alice" } }, "v");
    assert(found === '["bob",null]', `NULL rows must survive a not filter, got ${found}`);
  });
});

await check("notIn: [...] includes NULL rows, like not", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, 3, null]);
    const found = await matched(d, { n: { notIn: [1, 2] } }, "n");
    assert(found === "[3,null]", `NULL rows must survive a notIn filter, got ${found}`);
  });
});

await check("equals: <value> still excludes NULL rows (equality is unchanged)", async () => {
  await withDatabase(async (db) => {
    const d = await withStrings(db, ["alice", null]);
    const found = await matched(d, { v: { equals: "alice" } }, "v");
    assert(found === '["alice"]', `unexpected equals result: ${found}`);
  });
});

await check("in: [...] still excludes NULL rows (positive filters unchanged)", async () => {
  await withDatabase(async (db) => {
    const d = await withNumbers(db, [1, 2, null]);
    const found = await matched(d, { n: { in: [1, 2] } }, "n");
    assert(found === "[1,2]", `in must not start matching NULLs: ${found}`);
  });
});

// ─── The NULL forms emit no bind parameter at all ───────────────────────────

await check("equals: null and not: null compile to IS NULL / IS NOT NULL, unparameterized", async () => {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return [];
  };
  const d = new ModelDelegate(strMeta, exec);

  await d.findMany({ where: { v: { equals: null } } });
  assert(calls[0].sql.includes(`"v" IS NULL`), `expected IS NULL: ${calls[0].sql}`);
  assert(calls[0].params.length === 0, `IS NULL needs no bind param: ${JSON.stringify(calls[0].params)}`);

  await d.findMany({ where: { v: { not: null } } });
  assert(calls[1].sql.includes(`"v" IS NOT NULL`), `expected IS NOT NULL: ${calls[1].sql}`);
  assert(calls[1].params.length === 0, `IS NOT NULL needs no bind param: ${JSON.stringify(calls[1].params)}`);
});

await check("not: <value> still binds its value as a parameter, never inlined", async () => {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return [];
  };
  const d = new ModelDelegate(strMeta, exec);
  await d.findMany({ where: { v: { not: "alice" } } });
  assert(!calls[0].sql.includes("alice"), `value must not appear in SQL: ${calls[0].sql}`);
  assert(calls[0].params.length === 1 && calls[0].params[0] === "alice", "expected one bind param");
});

if (failures > 0) {
  console.error(`\n@indigodb/client where-operators: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client where-operators: all checks passed");
}
