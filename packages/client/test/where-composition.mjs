/**
 * @indigodb/client — recursive `AND`/`OR`/`NOT` `where` composition
 * regression suite (client-where-composition PR A, tasks.md A3.1-A4.1).
 *
 * Plain Node, no framework, mirroring `client.mjs`'s style. Proves
 * `whereExpr`'s structural-key dispatch (checked BEFORE `meta.fields`, so
 * `OR`/`AND`/`NOT` can never be mistaken for column names — the exact
 * defect the proposal opens with), correct recursive parenthesization with
 * one shared `Params` instance (no `$N` collisions), the empty-array
 * identities (`AND: []` → `TRUE`, `OR: []` → `FALSE`), the unknown-key
 * `IndigoWhereError`, and a PGlite round-trip proving `OR` returns the
 * expected row union against a live table.
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
    a: { db: "a" },
    b: { db: "b" },
    c: { db: "c" },
  },
};

console.log("client regression: where composition (AND/OR/NOT)");

// ─── Structural-key dispatch: OR no longer crashes as a column name ──────

await check("OR no longer crashes: compiles to valid parenthesized SQL", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { OR: [{ a: 1 }, { b: 2 }] } });
  assert(calls.length === 1, "expected one query");
  assert(
    calls[0].sql.includes(`WHERE ("a" = $1 OR "b" = $2)`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(!calls[0].sql.includes(`"OR"`), 'must never treat "OR" as a column name');
  assert(calls[0].params.length === 2 && calls[0].params[0] === 1 && calls[0].params[1] === 2);
});

// ─── Nested AND/OR/NOT: correct parenthesization, sequential $N ──────────

await check("nested AND/OR/NOT compiles with correct parenthesization and sequential params", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({
    where: { AND: [{ a: 1 }, { OR: [{ b: 2 }, { NOT: { c: 3 } }] }] },
  });
  assert(calls.length === 1, "expected one query");
  assert(
    calls[0].sql.includes(`WHERE ("a" = $1 AND ("b" = $2 OR NOT ("c" = $3)))`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(
    calls[0].params.length === 3 &&
      calls[0].params[0] === 1 &&
      calls[0].params[1] === 2 &&
      calls[0].params[2] === 3,
    `unexpected params: ${JSON.stringify(calls[0].params)}`,
  );
});

// ─── Empty AND/OR identity semantics ──────────────────────────────────────

await check("empty AND matches all rows (TRUE, no params)", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { AND: [] } });
  assert(calls[0].sql.includes("WHERE TRUE"), `unexpected SQL: ${calls[0].sql}`);
  assert(calls[0].params.length === 0, "expected no params");
});

await check("empty OR matches no rows (FALSE, no params)", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { OR: [] } });
  assert(calls[0].sql.includes("WHERE FALSE"), `unexpected SQL: ${calls[0].sql}`);
  assert(calls[0].params.length === 0, "expected no params");
});

await check("AND: [{}] and NOT: {} contribute nothing (no WHERE clause)", async () => {
  const { exec: exec1, calls: calls1 } = stubExecutor();
  const d1 = new ModelDelegate(meta, exec1);
  await d1.findMany({ where: { AND: [{}] } });
  assert(!calls1[0].sql.includes("WHERE"), `unexpected SQL: ${calls1[0].sql}`);

  const { exec: exec2, calls: calls2 } = stubExecutor();
  const d2 = new ModelDelegate(meta, exec2);
  await d2.findMany({ where: { NOT: {} } });
  assert(!calls2[0].sql.includes("WHERE"), `unexpected SQL: ${calls2[0].sql}`);
});

// ─── Unknown `where` key throws IndigoWhereError ──────────────────────────

await check("unknown where key throws IndigoWhereError with a typed .code", async () => {
  const { exec } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  let caught;
  try {
    await delegate.findMany({ where: { zzz: 1 } });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IndigoWhereError, `expected IndigoWhereError, got ${caught}`);
  assert(caught.code === "UNKNOWN_WHERE_KEY", `unexpected code: ${caught.code}`);
});

// ─── Regression: existing scalar-where SQL stays byte-identical (alias:null) ──

await check("regression: flat scalar where stays byte-identical to the pre-composition output", async () => {
  const { exec, calls } = stubExecutor();
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { a: 1, b: { gt: 2 } } });
  assert(
    calls[0].sql.includes(`WHERE "a" = $1 AND "b" > $2`),
    `unexpected SQL: ${calls[0].sql}`,
  );
});

// ─── Integration: OR returns the expected row union against PGlite ───────

await check("PGlite round-trip: OR returns the union of matching rows", async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE TABLE "T" (
        id SERIAL PRIMARY KEY,
        a INTEGER NOT NULL,
        b INTEGER NOT NULL
      );
    `);
    const exec = createPgliteExecutor(db);
    const tMeta = {
      name: "T",
      table: "T",
      fields: { id: { db: "id", pk: true }, a: { db: "a" }, b: { db: "b" } },
    };
    const delegate = new ModelDelegate(tMeta, exec);
    await delegate.create({ data: { a: 1, b: 0 } });
    await delegate.create({ data: { a: 0, b: 2 } });
    await delegate.create({ data: { a: 0, b: 0 } });

    const rows = await delegate.findMany({ where: { OR: [{ a: 1 }, { b: 2 }] } });
    assert(rows.length === 2, `expected 2 rows in the OR union, got ${rows.length}`);
    const sums = rows.map((r) => r.a + r.b).sort();
    assert(sums[0] === 1 && sums[1] === 2, `unexpected matched rows: ${JSON.stringify(rows)}`);
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client where-composition: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client where-composition: all checks passed");
}
