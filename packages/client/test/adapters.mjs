/**
 * @indigodb/client — Driver adapter unit + integration suite
 * (`client-driver-adapters` spec).
 *
 * Phase 2 (RED → GREEN, `createPgAdapter`): ownership inference (`close()`
 * ends an adapter-owned pool, never a caller-owned one), the transaction
 * hook's `BEGIN`/`COMMIT`/`ROLLBACK` ordering plus poison-aware `release`,
 * and typed-error propagation through `exec`. Phase 3 (`createPGliteAdapter`):
 * a real PGlite instance driven end-to-end through `IndigoClientBase`,
 * asserting the adapter delegates to PGlite's own `transaction()` API and
 * never issues a raw `BEGIN`/`COMMIT`/`ROLLBACK` statement itself.
 */

import { PGlite } from "@electric-sql/pglite";
import { createPgAdapter, createPGliteAdapter } from "../dist/adapters/index.js";
import { IndigoDatabaseError } from "../dist/errors.js";
import { IndigoClientBase } from "../dist/client.js";

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

console.log("@indigodb/client: adapters");

// ─── Phase 2.1: ownership inference — close() ──────────────────────────────

await check(
  "createPgAdapter(PoolConfig): close() calls pool.end() — the adapter owns the pool it constructed",
  async () => {
    const adapter = createPgAdapter({});
    let endCalled = 0;
    adapter.pool.end = async () => {
      endCalled++;
    };
    await adapter.close();
    assert(endCalled === 1, `expected pool.end() to be called exactly once, got ${endCalled}`);
  },
);

await check(
  "createPgAdapter({ pool }): close() does NOT call end() — the caller owns the pool's lifecycle",
  async () => {
    const calls = [];
    const fakePool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        calls.push("end");
      },
    };
    const adapter = createPgAdapter({ pool: fakePool });
    assert(adapter.pool === fakePool, "expected the adapter to expose the exact caller-supplied pool instance");
    await adapter.close();
    assert(calls.length === 0, "expected end() to never be called for a caller-supplied pool");
  },
);

// ─── Phase 2.2: transaction hook ordering ──────────────────────────────────

function fakePoolWithClient(clientOverrides = {}) {
  const clientCalls = [];
  const releaseCalls = [];
  const client = {
    query: async (sql) => {
      clientCalls.push(sql);
      if (clientOverrides.onQuery) return clientOverrides.onQuery(sql);
      return { rows: [] };
    },
    release: (poison) => {
      releaseCalls.push(poison);
    },
  };
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => client,
    end: async () => {},
  };
  return { pool, clientCalls, releaseCalls };
}

await check(
  "transaction: success path issues BEGIN → fn's queries → COMMIT, releases with no poison",
  async () => {
    const { pool, clientCalls, releaseCalls } = fakePoolWithClient();
    const adapter = createPgAdapter({ pool });
    const result = await adapter.transaction(async (exec) => {
      await exec("SELECT 1", []);
      return "done";
    });
    assert(result === "done", "expected transaction() to resolve with fn's return value");
    assert(
      clientCalls[0] === "BEGIN" && clientCalls[1] === "SELECT 1" && clientCalls[2] === "COMMIT",
      `expected [BEGIN, SELECT 1, COMMIT] order, got: ${JSON.stringify(clientCalls)}`,
    );
    assert(releaseCalls.length === 1, "expected release() to be called exactly once");
    assert(releaseCalls[0] === undefined, `expected release() with no poison, got: ${releaseCalls[0]}`);
  },
);

await check(
  "transaction: fn throws — ROLLBACK is issued, release is called with no poison, original error propagates unmasked",
  async () => {
    const { pool, clientCalls, releaseCalls } = fakePoolWithClient();
    const adapter = createPgAdapter({ pool });
    let caught;
    try {
      await adapter.transaction(async (exec) => {
        await exec("INSERT ...", []);
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error && caught.message === "boom", "expected the original thrown error to propagate unmasked");
    assert(
      clientCalls[0] === "BEGIN" && clientCalls[1] === "INSERT ..." && clientCalls[2] === "ROLLBACK",
      `expected [BEGIN, INSERT ..., ROLLBACK] order, got: ${JSON.stringify(clientCalls)}`,
    );
    assert(releaseCalls.length === 1, "expected release() to be called exactly once");
    assert(releaseCalls[0] === undefined, `expected release() with no poison when ROLLBACK itself succeeds, got: ${releaseCalls[0]}`);
  },
);

await check(
  "transaction: fn throws AND the ROLLBACK itself fails — release is called with the rollback error as poison",
  async () => {
    const rollbackErr = new Error("rollback failed");
    const { pool, clientCalls, releaseCalls } = fakePoolWithClient({
      onQuery: (sql) => {
        if (sql === "ROLLBACK") throw rollbackErr;
        return { rows: [] };
      },
    });
    const adapter = createPgAdapter({ pool });
    const originalErr = new Error("boom");
    let caught;
    const savedConsoleError = console.error;
    console.error = () => {}; // silence expected diagnostic log for this scenario
    try {
      await adapter.transaction(async () => {
        throw originalErr;
      });
    } catch (err) {
      caught = err;
    } finally {
      console.error = savedConsoleError;
    }
    assert(caught === originalErr, "expected the original error to propagate, never masked by the rollback failure");
    assert(clientCalls.includes("ROLLBACK"), "expected ROLLBACK to have been attempted");
    assert(releaseCalls.length === 1, "expected release() to be called exactly once");
    assert(releaseCalls[0] === rollbackErr, "expected release() to be called with the rollback error as poison");
  },
);

// ─── Phase 2.3: typed error propagation through exec ───────────────────────

await check(
  "exec: a rejection shaped like a pg DatabaseError ({ code: '23505' }) surfaces as IndigoDatabaseError",
  async () => {
    const fakePool = {
      query: async () => {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    const adapter = createPgAdapter({ pool: fakePool });
    let caught;
    try {
      await adapter.exec("INSERT ...", []);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof IndigoDatabaseError, "expected an IndigoDatabaseError to be thrown");
    assert(caught.code === "UNIQUE_VIOLATION", `expected code UNIQUE_VIOLATION, got: ${caught?.code}`);
    assert(caught.sqlstate === "23505", `expected sqlstate 23505, got: ${caught?.sqlstate}`);
  },
);

// ─── Phase 3.1: createPGliteAdapter end-to-end, over a real PGlite instance ─

await check(
  "createPGliteAdapter: IndigoClientBase built through it executes queries and delegates transaction() — never a raw BEGIN/COMMIT/ROLLBACK",
  async () => {
    const db = new PGlite();
    const controlStatements = [];

    // Wrap the outer instance's own query() to record every literal SQL
    // string the adapter (or IndigoClientBase, transitively) issues through
    // it directly — this is where a raw control statement would have to
    // appear if the adapter didn't delegate to PGlite's own transaction().
    const origQuery = db.query.bind(db);
    db.query = async (sql, params) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        controlStatements.push(trimmed);
      }
      return origQuery(sql, params);
    };
    // Same wrapping for every `tx` handle PGlite's own transaction() hands
    // back, so a raw control statement issued from inside fn would also be
    // caught.
    const origTransaction = db.transaction.bind(db);
    db.transaction = (fn) =>
      origTransaction(async (tx) => {
        const origTxQuery = tx.query.bind(tx);
        tx.query = async (sql, params) => {
          const trimmed = sql.trim().toUpperCase();
          if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
            controlStatements.push(trimmed);
          }
          return origTxQuery(sql, params);
        };
        return fn(tx);
      });

    try {
      const adapter = createPGliteAdapter(db);
      const client = new IndigoClientBase({ db: adapter });

      await client.$queryRaw('CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL)');

      const result = await client.$transaction(async (tx) => {
        await tx('INSERT INTO "Post" (title) VALUES ($1)', ["Hello"]);
        return "committed";
      });
      assert(result === "committed", "expected $transaction to resolve with fn's return value");

      const rows = await client.$queryRaw('SELECT * FROM "Post"');
      assert(rows.length === 1 && rows[0].title === "Hello", "expected the committed write to be visible");

      let caught;
      try {
        await client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["ShouldRollback"]);
          throw new Error("boom");
        });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error && caught.message === "boom", "expected the rollback-triggering error to propagate unmasked");

      const rowsAfterRollback = await client.$queryRaw('SELECT * FROM "Post"');
      assert(rowsAfterRollback.length === 1, "expected no additional row after the rolled-back transaction");

      assert(
        controlStatements.length === 0,
        `expected the adapter to never issue a raw control statement, got: ${JSON.stringify(controlStatements)}`,
      );
    } finally {
      await db.close();
    }
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client adapters: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client adapters: all checks passed");
}
