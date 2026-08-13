/**
 * @indigodb/client — aggregate / groupBy / distinct (PR C, client-batch-aggregate).
 *
 * `ModelDelegate.aggregate`/`groupBy` and `findMany({ distinct })` (design.md
 * "SQL shapes", client-aggregation spec). All three reuse the existing
 * `Params`/`quote`/`buildWhere` builders — no second WHERE compiler.
 *
 * Layout:
 *  - C.1: `_sum`/`_avg` on a non-numeric field throws `IndigoArgumentError`
 *    code `NON_NUMERIC_AGGREGATE` before `exec`.
 *  - C.2: unknown aggregate field throws `UNKNOWN_AGGREGATE_FIELD`; an empty
 *    aggregate selection throws `EMPTY_AGGREGATE`.
 *  - C.3: `aggregate()` emits one `SELECT count(*)::int AS agg0, sum("c")
 *    ::float8 AS agg1, ... WHERE <expr>` with positional aliases, JS-side
 *    descriptor rebuild into the nested `AggregateResult` shape.
 *  - C.4: `groupBy()` emits `GROUP BY <fields>`, no `having` support.
 *  - C.5: `findMany({ distinct })` emits `SELECT DISTINCT ON (...)` with the
 *    distinct columns prepended to `ORDER BY`.
 *  - C.12: PGlite integration — real aggregate values, groupBy grouping,
 *    DISTINCT ON row identity.
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

const orderMeta = {
  name: "Order",
  table: "Order",
  fields: {
    id: { db: "id", pk: true, numeric: true },
    status: { db: "status" },
    total: { db: "total", numeric: true },
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

async function seedOrders(db) {
  await db.exec(`
    CREATE TABLE "Order" (id SERIAL PRIMARY KEY, status TEXT NOT NULL, total NUMERIC NOT NULL);
  `);
  const rows = [
    ["paid", 10],
    ["paid", 20],
    ["pending", 5],
  ];
  for (const [status, total] of rows) {
    await db.exec(`INSERT INTO "Order" (status, total) VALUES ('${status}', ${total});`);
  }
}

console.log("@indigodb/client: aggregate / groupBy / distinct");

// ─── C.1: _sum/_avg on a non-numeric field throws NON_NUMERIC_AGGREGATE ────

await check(
  "C.1a: aggregate({ _sum: { status: true } }) throws IndigoArgumentError code NON_NUMERIC_AGGREGATE before exec",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    let threw = false;
    try {
      await Order.aggregate({ _sum: { status: true } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "NON_NUMERIC_AGGREGATE", `expected code NON_NUMERIC_AGGREGATE, got ${err.code}`);
    }
    assert(threw, "expected aggregate({ _sum }) on a non-numeric field to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

await check(
  "C.1b: aggregate({ _avg: { status: true } }) throws IndigoArgumentError code NON_NUMERIC_AGGREGATE before exec",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    let threw = false;
    try {
      await Order.aggregate({ _avg: { status: true } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "NON_NUMERIC_AGGREGATE", `expected code NON_NUMERIC_AGGREGATE, got ${err.code}`);
    }
    assert(threw, "expected aggregate({ _avg }) on a non-numeric field to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── C.2: unknown field / empty selection ──────────────────────────────────

await check(
  "C.2a: aggregate({ _sum: { bogus: true } }) throws IndigoArgumentError code UNKNOWN_AGGREGATE_FIELD before exec",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    let threw = false;
    try {
      await Order.aggregate({ _sum: { bogus: true } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "UNKNOWN_AGGREGATE_FIELD", `expected code UNKNOWN_AGGREGATE_FIELD, got ${err.code}`);
    }
    assert(threw, "expected aggregate({ _sum }) on an unknown field to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

await check(
  "C.2b: aggregate({}) throws IndigoArgumentError code EMPTY_AGGREGATE before exec",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    let threw = false;
    try {
      await Order.aggregate({});
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "EMPTY_AGGREGATE", `expected code EMPTY_AGGREGATE, got ${err.code}`);
    }
    assert(threw, "expected aggregate({}) to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── C.3: aggregate() emits one SELECT with positional aliases ────────────

await check(
  "C.3: aggregate emits one SELECT count(*)::int AS agg0, sum(...)::float8 AS agg1 ... WHERE <expr>, rebuilds nested result",
  async () => {
    const { exec, calls } = stubExecutor([{ agg0: 3, agg1: "35", agg2: "11.666666666666667" }]);
    const Order = new ModelDelegate(orderMeta, exec);
    const result = await Order.aggregate({
      where: { status: "paid" },
      _count: true,
      _sum: { total: true },
      _avg: { total: true },
    });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      calls[0].sql ===
        'SELECT count(*)::int AS agg0, sum("total")::float8 AS agg1, avg("total")::float8 AS agg2 ' +
          'FROM "Order" WHERE "status" = $1',
      `unexpected SQL: ${calls[0].sql}`,
    );
    assert(calls[0].params.length === 1 && calls[0].params[0] === "paid", `unexpected params: ${JSON.stringify(calls[0].params)}`);
    assert(result._count === 3, `expected _count 3, got ${JSON.stringify(result)}`);
    assert(result._sum.total === 35, `expected _sum.total 35, got ${JSON.stringify(result)}`);
    assert(
      Math.abs(result._avg.total - 11.666666666666667) < 1e-9,
      `expected _avg.total ~11.6667, got ${JSON.stringify(result)}`,
    );
  },
);

await check("C.3b: _min/_max keep the column's native (uncast) value", async () => {
  const { exec, calls } = stubExecutor([{ agg0: 5, agg1: 20 }]);
  const Order = new ModelDelegate(orderMeta, exec);
  const result = await Order.aggregate({ _min: { total: true }, _max: { total: true } });
  assert(
    calls[0].sql === 'SELECT min("total") AS agg0, max("total") AS agg1 FROM "Order"',
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(result._min.total === 5 && result._max.total === 20, `unexpected result: ${JSON.stringify(result)}`);
});

// ─── C.4: groupBy() emits GROUP BY, no having ──────────────────────────────

await check("C.4: groupBy emits SELECT <by>, <aggregates> ... GROUP BY <by>", async () => {
  const { exec, calls } = stubExecutor([
    { status: "paid", agg0: 2 },
    { status: "pending", agg0: 1 },
  ]);
  const Order = new ModelDelegate(orderMeta, exec);
  const result = await Order.groupBy({ by: ["status"], _count: true });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(
    calls[0].sql ===
      'SELECT "status" AS "status", count(*)::int AS agg0 FROM "Order" GROUP BY "status"',
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(
    result.length === 2 && result[0].status === "paid" && result[0]._count === 2,
    `unexpected result: ${JSON.stringify(result)}`,
  );
  assert(
    result[1].status === "pending" && result[1]._count === 1,
    `unexpected result: ${JSON.stringify(result)}`,
  );
  assert(!("having" in result), "groupBy result carries no having key");
});

await check("C.4b: groupBy has no having support at the runtime SQL level", async () => {
  const { exec, calls } = stubExecutor([{ status: "paid" }]);
  const Order = new ModelDelegate(orderMeta, exec);
  await Order.groupBy({ by: ["status"] });
  assert(!calls[0].sql.includes("HAVING"), `expected no HAVING clause: ${calls[0].sql}`);
});

// ─── C.5: findMany({ distinct }) emits SELECT DISTINCT ON (...) ───────────

await check(
  "C.5a: findMany({ distinct: ['status'] }) emits SELECT DISTINCT ON (\"status\") ... ORDER BY \"status\"",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    await Order.findMany({ distinct: ["status"] });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      calls[0].sql ===
        'SELECT DISTINCT ON ("status") "id" AS "id", "status" AS "status", "total" AS "total" FROM "Order" ' +
          'ORDER BY "status"',
      `unexpected SQL: ${calls[0].sql}`,
    );
  },
);

await check(
  "C.5b: distinct fields already leading orderBy are not duplicated",
  async () => {
    const { exec, calls } = stubExecutor();
    const Order = new ModelDelegate(orderMeta, exec);
    await Order.findMany({ distinct: ["status"], orderBy: { status: "desc" } });
    const { sql } = calls[0];
    assert(sql.includes('DISTINCT ON ("status")'), `expected DISTINCT ON clause: ${sql}`);
    assert(sql.endsWith('ORDER BY "status" DESC'), `expected ORDER BY status DESC exactly once: ${sql}`);
  },
);

// ─── C.12: PGlite integration ───────────────────────────────────────────────

await check("C.12a: aggregate computes real _count/_sum/_avg/_min/_max values", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedOrders(db);
    const Order = new ModelDelegate(orderMeta, exec);
    const result = await Order.aggregate({
      _count: true,
      _sum: { total: true },
      _avg: { total: true },
      _min: { total: true },
      _max: { total: true },
    });
    assert(result._count === 3, `expected _count 3, got ${JSON.stringify(result)}`);
    assert(result._sum.total === 35, `expected _sum.total 35, got ${JSON.stringify(result)}`);
    assert(Number(result._min.total) === 5, `expected _min.total 5, got ${JSON.stringify(result)}`);
    assert(Number(result._max.total) === 20, `expected _max.total 20, got ${JSON.stringify(result)}`);
  });
});

await check("C.12b: groupBy groups real rows by status with per-group counts", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedOrders(db);
    const Order = new ModelDelegate(orderMeta, exec);
    const groups = await Order.groupBy({ by: ["status"], _count: true, _sum: { total: true } });
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g]));
    assert(byStatus.paid._count === 2, `expected 2 paid orders, got ${JSON.stringify(groups)}`);
    assert(byStatus.paid._sum.total === 30, `expected paid sum 30, got ${JSON.stringify(groups)}`);
    assert(byStatus.pending._count === 1, `expected 1 pending order, got ${JSON.stringify(groups)}`);
  });
});

await check("C.12c: distinct returns at most one row per distinct status value", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedOrders(db);
    const Order = new ModelDelegate(orderMeta, exec);
    const rows = await Order.findMany({ distinct: ["status"], orderBy: { status: "asc" } });
    const statuses = rows.map((r) => r.status);
    assert(
      statuses.length === new Set(statuses).size,
      `expected at most one row per distinct status, got ${JSON.stringify(statuses)}`,
    );
    assert(statuses.length === 2, `expected 2 distinct statuses (paid, pending), got ${JSON.stringify(statuses)}`);
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client aggregate: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client aggregate: all checks passed");
}
