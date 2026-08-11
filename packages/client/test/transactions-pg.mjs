/**
 * @indigodb/client — `$transaction` regression suite for the DEFAULT
 * `pg.Pool` path (no injected `db` option).
 *
 * Every scenario in `transactions.mjs` constructs `IndigoClientBase` with an
 * injected `db: { exec, transaction }` (PGlite driven directly through its
 * JS API), so `client.ts`'s `$withSession`'s `pool.connect()` →
 * `BEGIN` → scoped exec → `COMMIT`/`ROLLBACK` → `client.release(...)`
 * branch (the actual default behavior most consumers get) had zero runtime
 * coverage. This file closes that gap by driving `IndigoClientBase` purely
 * via `connectionString`/`pool` against a real Postgres engine reachable
 * over a real TCP `pg.Pool` connection (`pglite-socket-harness.mjs`),
 * proving the `client-transactions` spec's "pg.Pool path checks out a
 * dedicated connection" scenario plus commit/rollback/release on that path.
 */

import { IndigoClientBase } from "../dist/client.js";
import { withRealPostgres } from "./pglite-socket-harness.mjs";

let failures = 0;

async function check(name, fn) {
  try {
    await withTimeout(fn(), 15_000, name);
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

/** Fails fast (instead of hanging CI forever) if a leaked/exhausted pool deadlocks a scenario. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms — likely a hung/leaked pool connection: ${label}`)), ms),
    ),
  ]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CREATE_POST_TABLE = `
  CREATE TABLE "Post" (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL
  );
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Dedicated connection checkout (pg.Pool path) ──────────────────────────

await check(
  "pg.Pool: $transaction checks out a dedicated connection — a concurrent outside query is blocked until it releases",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({
        connectionString,
        // A pool of exactly one connection: if `$transaction` released and
        // re-acquired a connection per statement (instead of holding one
        // dedicated connection for the whole callback via `pool.connect()`),
        // the concurrent outside query below would be free to interleave.
        pool: { max: 1 },
      });
      try {
        await client.$queryRaw(CREATE_POST_TABLE);

        const events = [];
        let releaseGate;
        const gate = new Promise((resolve) => {
          releaseGate = resolve;
        });

        const txPromise = client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["Held"]);
          events.push("tx:inserted");
          await gate; // hold the transaction's connection open on purpose
          events.push("tx:about-to-return");
          return "tx-done";
        });

        // Give $transaction time to actually reach `pool.connect()` + BEGIN.
        await sleep(50);

        const outsidePromise = client.$queryRaw("SELECT 1 AS x").then((rows) => {
          events.push("outside:resolved");
          return rows;
        });

        // With only one connection in the pool and it checked out by the
        // still-open transaction, this outside query MUST still be pending.
        await sleep(50);
        assert(
          !events.includes("outside:resolved"),
          "expected the outside query to be blocked while $transaction holds the pool's sole connection",
        );

        releaseGate();
        const [txResult, outsideRows] = await Promise.all([txPromise, outsidePromise]);

        assert(txResult === "tx-done", "expected $transaction to resolve with fn's return value");
        assert(
          events.indexOf("tx:about-to-return") < events.indexOf("outside:resolved"),
          "expected the outside query to resolve only after the transaction's connection was released",
        );
        assert(outsideRows.length === 1 && outsideRows[0].x === 1, "expected the outside query to still succeed once unblocked");
      } finally {
        await client.$disconnect();
      }
    });
  },
);

// ─── Commit on success ──────────────────────────────────────────────────────

await check("pg.Pool: commit persists the write outside the transaction", async () => {
  await withRealPostgres(async ({ connectionString }) => {
    const client = new IndigoClientBase({ connectionString });
    try {
      await client.$queryRaw(CREATE_POST_TABLE);

      const result = await client.$transaction(async (tx) => {
        await tx('INSERT INTO "Post" (title) VALUES ($1)', ["Hello"]);
        return "committed";
      });
      assert(result === "committed", "expected $transaction to resolve with fn's return value");

      const rows = await client.$queryRaw('SELECT * FROM "Post"');
      assert(rows.length === 1, "expected the write to be visible after commit");
      assert(rows[0].title === "Hello", "expected the committed row to match what was created");
    } finally {
      await client.$disconnect();
    }
  });
});

// ─── Rollback on failure ────────────────────────────────────────────────────

await check("pg.Pool: fn throws synchronously — session is rolled back, no writes visible", async () => {
  await withRealPostgres(async ({ connectionString }) => {
    const client = new IndigoClientBase({ connectionString });
    try {
      await client.$queryRaw(CREATE_POST_TABLE);

      let caught;
      try {
        await client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["ShouldRollback"]);
          throw new Error("boom");
        });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error, "expected $transaction to reject");
      assert(caught.message === "boom", `expected the thrown error to propagate unmasked, got: ${caught?.message}`);

      const rows = await client.$queryRaw('SELECT * FROM "Post"');
      assert(rows.length === 0, "expected no writes visible after rollback");
    } finally {
      await client.$disconnect();
    }
  });
});

// ─── Session always released — sequential exhaustion / no leak ────────────

await check(
  "pg.Pool: N sequential transactions on a pool of size 1 never hang — every session is genuinely released",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({ connectionString, pool: { max: 1 } });
      try {
        await client.$queryRaw(CREATE_POST_TABLE);

        const N = 5;
        for (let i = 0; i < N; i++) {
          await client.$transaction(async (tx) => {
            await tx('INSERT INTO "Post" (title) VALUES ($1)', [`row-${i}`]);
          });
        }

        const rows = await client.$queryRaw('SELECT * FROM "Post" ORDER BY id');
        assert(rows.length === N, `expected all ${N} sequential transactions to have committed, got ${rows.length}`);
      } finally {
        await client.$disconnect();
      }
    });
  },
);

await check(
  "pg.Pool: a rolled-back transaction still releases its connection — the pool remains usable immediately after",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({ connectionString, pool: { max: 1 } });
      try {
        await client.$queryRaw(CREATE_POST_TABLE);

        let caught;
        try {
          await client.$transaction(async (tx) => {
            await tx('INSERT INTO "Post" (title) VALUES ($1)', ["WillRollback"]);
            throw new Error("boom");
          });
        } catch (err) {
          caught = err;
        }
        assert(caught instanceof Error, "expected the failing transaction to reject");

        // If the connection leaked (never released), this would hang forever
        // against a `max: 1` pool — the `withTimeout` wrapper around `check`
        // turns that hang into an explicit failure instead of a stuck suite.
        const result = await client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["AfterRollback"]);
          return "ok";
        });
        assert(result === "ok", "expected the client to remain usable after a rolled-back transaction");

        const rows = await client.$queryRaw('SELECT * FROM "Post"');
        assert(
          rows.length === 1 && rows[0].title === "AfterRollback",
          "expected only the post-rollback write to be committed",
        );
      } finally {
        await client.$disconnect();
      }
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client transactions-pg: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client transactions-pg: all checks passed");
}
