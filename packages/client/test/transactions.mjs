/**
 * @indigodb/client — `$transaction` / `$withSession` regression suite.
 *
 * Plain Node, no test framework, mirroring `client.mjs`'s style. Covers the
 * `client-transactions` spec's interactive-callback form against
 * `IndigoClientBase` directly (Slice 1 — no generated typed `TransactionClient`
 * yet, `fn` receives the raw session `Executor`).
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate } from "../dist/delegate.js";
import { withDatabase, createPgliteDb } from "./pglite-harness.mjs";

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

const postMeta = {
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
  },
};

async function createPostTable(exec) {
  await exec(`
    CREATE TABLE "Post" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL
    );
  `);
}

// ─── Commit on success ─────────────────────────────────────────────────────

await check(
  "commit: fn resolves, writes visible after $transaction resolves",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      const result = await client.$transaction(async (tx) => {
        const posts = new ModelDelegate(postMeta, tx);
        return posts.create({ data: { title: "Hello" } });
      });
      assert(
        result.title === "Hello",
        "expected $transaction to resolve with fn's return value",
      );

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const found = await outsidePosts.findMany({});
      assert(found.length === 1, "expected the write to be visible after commit");
      assert(found[0].title === "Hello", "expected the committed row to match what was created");
    });
  },
);

// ─── Rollback on failure ───────────────────────────────────────────────────

await check(
  "rollback-on-throw: fn throws synchronously, session rolled back, no writes visible",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      let caught;
      try {
        await client.$transaction(async (tx) => {
          const posts = new ModelDelegate(postMeta, tx);
          await posts.create({ data: { title: "ShouldRollback" } });
          throw new Error("boom");
        });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error, "expected $transaction to reject");
      assert(caught.message === "boom", `expected the thrown error to propagate unmasked, got: ${caught?.message}`);

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const found = await outsidePosts.findMany({});
      assert(found.length === 0, "expected no writes visible after rollback");
    });
  },
);

await check(
  "rollback-on-rejected-promise: fn's returned promise rejects, session rolled back, rejection reason propagated",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      let caught;
      try {
        await client.$transaction(async (tx) => {
          const posts = new ModelDelegate(postMeta, tx);
          await posts.create({ data: { title: "AlsoShouldRollback" } });
          return Promise.reject(new Error("rejected-inside-fn"));
        });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error, "expected $transaction to reject");
      assert(
        caught.message === "rejected-inside-fn",
        `expected the rejection reason to propagate unmasked, got: ${caught?.message}`,
      );

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const found = await outsidePosts.findMany({});
      assert(found.length === 0, "expected no writes visible after rollback");
    });
  },
);

// ─── Nested transactions are rejected ──────────────────────────────────────

await check(
  "nesting-rejected: client.$transaction() inside an active transaction rejects; outer transaction's session unaffected",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      let nestedErr;
      let nestedFnCalled = false;
      const result = await client.$transaction(async (tx) => {
        const posts = new ModelDelegate(postMeta, tx);
        await posts.create({ data: { title: "Outer" } });
        try {
          await client.$transaction(async () => {
            nestedFnCalled = true;
          });
        } catch (err) {
          nestedErr = err;
        }
        return "outer-done";
      });

      assert(nestedErr instanceof Error, "expected the nested $transaction call to reject");
      assert(
        /nested/i.test(nestedErr.message),
        `expected an explicit nested-transaction error, got: ${nestedErr?.message}`,
      );
      assert(nestedFnCalled === false, "expected the nested callback to never run");
      assert(result === "outer-done", "expected the outer transaction to still resolve normally");

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const found = await outsidePosts.findMany({});
      assert(
        found.length === 1 && found[0].title === "Outer",
        "expected the outer transaction's write to still commit despite the rejected nested call",
      );
    });
  },
);

// ─── Unsupported executors fail explicitly ─────────────────────────────────

await check(
  "unsupported-executor-error: injected db without a transaction hook rejects $transaction, fn never invoked",
  async () => {
    const { exec } = stubExecutor();
    const client = new IndigoClientBase({ db: { exec } });

    let fnCalled = false;
    let caught;
    try {
      await client.$transaction(async () => {
        fnCalled = true;
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, "expected $transaction to reject");
    assert(
      /does not support transactions/i.test(caught.message),
      `expected an explicit "does not support transactions" error, got: ${caught?.message}`,
    );
    assert(fnCalled === false, "expected fn to never be invoked");
  },
);

// ─── Session always released ───────────────────────────────────────────────

await check(
  "no-leak-on-mid-callback-throw: a tx operation throws before fn settles; session released once, no connection leak",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      let caught;
      try {
        await client.$transaction(async (tx) => {
          const posts = new ModelDelegate(postMeta, tx);
          // Violates the NOT NULL constraint — the operation itself throws
          // before fn's own returned promise ever settles.
          await posts.create({ data: {} });
        });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error, "expected $transaction to reject with the tx operation's error");
      // `createPGliteAdapter`'s transaction-scoped exec is now wrapped with
      // `withDatabaseErrors` (client-driver-adapters spec, error parity with
      // `createPgAdapter`), so the not-null violation surfaces as a typed
      // `IndigoDatabaseError` with the original PGlite error reachable via
      // `.cause`, rather than as the raw untyped error itself.
      assert(
        caught.cause !== undefined && /null/i.test(caught.cause.message),
        `expected the underlying not-null constraint violation to propagate via .cause, got: ${caught?.cause?.message}`,
      );

      // Prove there is no leaked/held session: the client must still be
      // fully usable for further work afterward.
      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const created = await outsidePosts.create({ data: { title: "AfterFailure" } });
      assert(
        created.title === "AfterFailure",
        "expected the client to remain usable after a mid-callback failure (no leaked connection)",
      );
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client transactions: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client transactions: all checks passed");
}
