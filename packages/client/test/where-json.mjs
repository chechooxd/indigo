/**
 * @indigodb/client — JSON path filters on `Json`/`jsonb` columns
 * (client-where-composition PR C, tasks.md C3.1-C4.1).
 *
 * Plain Node, no framework, mirroring `where-composition.mjs`'s style.
 * Proves `whereExpr`'s field-level JSON dispatch (`fieldMeta.json` +
 * `path` key, design.md "JSON Filter (PR C)"): `equals`/`not` compile to
 * jsonb equality via `#>`, `gt`/`gte`/`lt`/`lte` compile to a `#>>` text
 * comparison (cast to `::numeric` for a numeric operand), `jsonContains`
 * compiles to `@>` containment, and a `path` key against a non-JSON column
 * throws `IndigoWhereError` rather than silently emitting `#>`.
 */

import { ModelDelegate, IndigoWhereError } from "../dist/delegate.js";
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

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

const meta = {
  name: "T",
  table: "T",
  fields: {
    id: { db: "id", pk: true },
    metadata: { db: "metadata", json: true },
    title: { db: "title" },
  },
};

console.log("client regression: JSON path filters");

// ─── equals/not compile to jsonb equality via #> ──────────────────────────

await check("equals compiles to (col #> $p::text[]) = $v::jsonb", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { metadata: { path: ["status"], equals: "active" } } });
  assert(
    calls[0].sql.includes(`WHERE ("metadata" #> $1::text[]) = $2::jsonb`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(
    Array.isArray(calls[0].params[0]) &&
      calls[0].params[0][0] === "status" &&
      calls[0].params[1] === JSON.stringify("active"),
    `unexpected params: ${JSON.stringify(calls[0].params)}`,
  );
});

await check("not compiles to (col #> $p::text[]) <> $v::jsonb", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { metadata: { path: ["status"], not: "active" } } });
  assert(
    calls[0].sql.includes(`WHERE ("metadata" #> $1::text[]) <> $2::jsonb`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(calls[0].params[1] === JSON.stringify("active"));
});

// ─── gt/gte/lt/lte, numeric operand: #>> cast to ::numeric ───────────────

await check("gt with a numeric operand compiles to (col #>> $p::text[])::numeric > $v", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { metadata: { path: ["score"], gt: 10 } } });
  assert(
    calls[0].sql.includes(`WHERE ("metadata" #>> $1::text[])::numeric > $2`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(calls[0].params[1] === 10);
});

await check("gte/lt/lte with a numeric operand cast to ::numeric", async () => {
  for (const [op, sqlOp] of [
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
  ]) {
    const { exec, calls } = stubExecutor();
    const delegate = new ModelDelegate(meta, exec);
    await delegate.findMany({ where: { metadata: { path: ["score"], [op]: 10 } } });
    assert(
      calls[0].sql.includes(`WHERE ("metadata" #>> $1::text[])::numeric ${sqlOp} $2`),
      `unexpected SQL for ${op}: ${calls[0].sql}`,
    );
  }
});

// ─── gt/gte/lt/lte, string operand: #>> with no ::numeric cast ───────────

await check("gt with a string operand compiles to (col #>> $p::text[]) > $v (no ::numeric cast)", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { metadata: { path: ["status"], gt: "active" } } });
  assert(
    calls[0].sql.includes(`WHERE ("metadata" #>> $1::text[]) > $2`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(!calls[0].sql.includes("::numeric"), `unexpected ::numeric cast: ${calls[0].sql}`);
  assert(calls[0].params[1] === "active");
});

// ─── jsonContains compiles to @> containment ──────────────────────────────

await check("jsonContains compiles to (col #> $p::text[]) @> $v::jsonb", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { metadata: { path: [], jsonContains: { a: 1 } } } });
  assert(
    calls[0].sql.includes(`WHERE ("metadata" #> $1::text[]) @> $2::jsonb`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(calls[0].params[1] === JSON.stringify({ a: 1 }));
});

// ─── path on a non-JSON column throws IndigoWhereError ────────────────────

await check("a `path` key against a non-JSON column throws IndigoWhereError, not a silent #>", async () => {
  const { exec } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  let caught;
  try {
    await delegate.findMany({ where: { title: { path: ["x"], equals: "y" } } });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IndigoWhereError, `expected IndigoWhereError, got ${caught}`);
});

// ─── Integration: jsonb path comparisons round-trip against a live table ──

await check("PGlite round-trip: jsonb path equals/gt comparisons round-trip", async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE TABLE "T" (
        id SERIAL PRIMARY KEY,
        metadata JSONB
      );
    `);
    const exec = createPgliteExecutor(db);
    const tMeta = {
      name: "T",
      table: "T",
      fields: { id: { db: "id", pk: true }, metadata: { db: "metadata", json: true } },
    };
    const delegate = new ModelDelegate(tMeta, exec);
    await delegate.create({ data: { metadata: { status: "active", score: 5, tags: ["a", "b"] } } });
    await delegate.create({ data: { metadata: ["top-level-array", 42] } });
    await delegate.create({ data: { metadata: { status: "inactive", score: 20 } } });

    const arrayRows = await delegate.findMany({
      where: { metadata: { path: [], jsonContains: ["top-level-array"] } },
    });
    assert(arrayRows.length === 1, `expected 1 row for top-level JSON array, got ${arrayRows.length}`);

    const equalsRows = await delegate.findMany({
      where: { metadata: { path: ["status"], equals: "active" } },
    });
    assert(equalsRows.length === 1, `expected 1 row for equals, got ${equalsRows.length}`);

    const gtRows = await delegate.findMany({ where: { metadata: { path: ["score"], gt: 10 } } });
    assert(gtRows.length === 1, `expected 1 row for gt, got ${gtRows.length}`);
    assert(gtRows[0].metadata.status === "inactive");
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client where-json: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client where-json: all checks passed");
}
