/**
 * @indigodb/client — `createPgAdapter` parity suite (`client-driver-adapters`
 * spec, design.md "Testing Strategy": "pg adapter parity").
 *
 * `transactions-pg.mjs` proves the DEFAULT `connectionString`/`pool`
 * construction path against a real Postgres engine reachable over a real TCP
 * `pg.Pool` connection. Since `client.ts`'s `connectionString` branch now
 * just calls `createPgAdapter` internally (design.md "Technical Approach" —
 * "the built-in path and the bring-your-own-driver path become the same
 * code"), this file mirrors that suite's assertions but constructs the
 * client explicitly via `{ db: createPgAdapter({ connectionString }) }`,
 * proving the public adapter factory itself — not just the path that wraps
 * it — genuinely round-trips commit/rollback/release/typed-errors over the
 * wire.
 */

import pg from "pg";
import { IndigoClientBase } from "../dist/client.js";
import { IndigoDatabaseError } from "../dist/errors.js";
import { createPgAdapter } from "../dist/adapters/index.js";
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

console.log("@indigodb/client: adapters-pg");

// ─── Commit on success ──────────────────────────────────────────────────────

await check("createPgAdapter: commit persists the write outside the transaction", async () => {
  await withRealPostgres(async ({ connectionString }) => {
    const client = new IndigoClientBase({ db: createPgAdapter({ connectionString }) });
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

await check("createPgAdapter: fn throws synchronously — session is rolled back, no writes visible", async () => {
  await withRealPostgres(async ({ connectionString }) => {
    const client = new IndigoClientBase({ db: createPgAdapter({ connectionString }) });
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
  "createPgAdapter: N sequential transactions on a pool of size 1 never hang — every session is genuinely released",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({
        db: createPgAdapter({ connectionString, max: 1 }),
      });
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

// ─── Existing-pool input: close() does not end a caller-owned pool ─────────

await check(
  "createPgAdapter({ pool }): $disconnect() does not end the caller-supplied pg.Pool — the caller remains responsible for it",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const pool = new pg.Pool({ connectionString });
      const client = new IndigoClientBase({ db: createPgAdapter({ pool }) });
      try {
        await client.$queryRaw(CREATE_POST_TABLE);
        const rows = await client.$queryRaw('SELECT 1 AS x');
        assert(rows[0].x === 1, "expected the caller-supplied pool to serve queries normally");
        await client.$disconnect();

        // The pool must still be usable after $disconnect() — proof it was
        // never ended, only the adapter's ownership-scoped teardown ran.
        const stillWorks = await pool.query("SELECT 2 AS y");
        assert(stillWorks.rows[0].y === 2, "expected the caller-owned pool to remain usable after client.$disconnect()");
      } finally {
        await pool.end();
      }
    });
  },
);

// ─── Typed database errors over the explicit adapter path ─────────────────

const CREATE_USER_TABLE = `
  CREATE TABLE "User" (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  );
`;

await check(
  "createPgAdapter: a real unique-constraint violation surfaces as IndigoDatabaseError",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({ db: createPgAdapter({ connectionString }) });
      try {
        await client.$queryRaw(CREATE_USER_TABLE);
        await client.$queryRaw('INSERT INTO "User" (email) VALUES ($1)', ["a@x.com"]);

        let caught;
        try {
          await client.$queryRaw('INSERT INTO "User" (email) VALUES ($1)', ["a@x.com"]);
        } catch (err) {
          caught = err;
        }
        assert(caught instanceof IndigoDatabaseError, "expected an IndigoDatabaseError to be thrown");
        assert(caught.code === "UNIQUE_VIOLATION", `expected code UNIQUE_VIOLATION, got: ${caught?.code}`);
        assert(caught.sqlstate === "23505", `expected sqlstate 23505, got: ${caught?.sqlstate}`);
      } finally {
        await client.$disconnect();
      }
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client adapters-pg: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client adapters-pg: all checks passed");
}
