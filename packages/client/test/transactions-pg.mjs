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
 * dedicated connection" scenario plus commit/rollback/release on that path,
 * plus (Slice 3) the array form's rollback against this same real path.
 */

import { IndigoClientBase } from "../dist/client.js";
import { IndigoDatabaseError } from "../dist/errors.js";
import { ModelDelegate } from "../dist/delegate.js";
import { isIndigoPromise, runDeferred, IndigoTransactionError } from "../dist/promise.js";
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

// ─── Typed database errors over the real pg.Pool path (client-database-errors spec) ─

const CREATE_USER_TABLE = `
  CREATE TABLE "User" (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  );
`;

await check(
  "pg.Pool: a real unique-constraint violation as a direct statement failure surfaces as IndigoDatabaseError",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({ connectionString });
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
        assert(caught.cause !== undefined, "expected the original pg DatabaseError to be preserved on .cause");
      } finally {
        await client.$disconnect();
      }
    });
  },
);

await check(
  "pg.Pool: a real unique-constraint violation inside $transaction/$withSession surfaces as IndigoDatabaseError, rolled back",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new IndigoClientBase({ connectionString });
      try {
        await client.$queryRaw(CREATE_USER_TABLE);
        await client.$queryRaw('INSERT INTO "User" (email) VALUES ($1)', ["b@x.com"]);

        let caught;
        try {
          await client.$transaction(async (tx) => {
            await tx('INSERT INTO "User" (email) VALUES ($1)', ["b@x.com"]);
          });
        } catch (err) {
          caught = err;
        }
        assert(caught instanceof IndigoDatabaseError, "expected an IndigoDatabaseError inside $transaction");
        assert(caught.code === "UNIQUE_VIOLATION", `expected code UNIQUE_VIOLATION, got: ${caught?.code}`);

        const rows = await client.$queryRaw('SELECT * FROM "User"');
        assert(rows.length === 1, "expected the failed transaction to have rolled back with no extra row");
      } finally {
        await client.$disconnect();
      }
    });
  },
);

// ─── Array form ($transaction([...])) against real Postgres ────────────────
//
// Mirrors `transactions.mjs`'s array-form section (same hand-wired
// generated-client stand-in), but over the real `pg.Pool`/wire-protocol path
// (`connectionString`, no injected `db`) instead of PGlite driven directly —
// proving the array form's rollback holds against a genuine Postgres
// connection, not just the in-process PGlite path (tasks.md Slice 3, 3.5).

const CREATE_USER_TABLE_FOR_ARRAY = `
  CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
`;
const CREATE_POST_TABLE_FOR_ARRAY = `
  CREATE TABLE "Post" (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    author_id INT REFERENCES "User"(id)
  );
`;

const arrayUserMeta = {
  name: "User",
  table: "User",
  fields: { id: { db: "id", pk: true }, name: { db: "name" } },
};
const arrayPostMeta = {
  name: "Post",
  table: "Post",
  fields: { id: { db: "id", pk: true }, title: { db: "title" }, authorId: { db: "author_id" } },
};

function buildArrayFormPgRegistry(exec, runAtomic) {
  const registry = {};
  const siblings = () => registry;
  registry.User = new ModelDelegate(arrayUserMeta, exec, siblings, runAtomic);
  registry.Post = new ModelDelegate(arrayPostMeta, exec, siblings, runAtomic);
  return registry;
}

/** Same stand-in as `transactions.mjs`'s `GeneratedLikeClient` — see that
 * file's doc comment for why this hand-wiring mirrors the generator's
 * planned `$transaction` emission exactly. */
class ArrayFormPgClient extends IndigoClientBase {
  constructor(options) {
    super(options);
    const registry = buildArrayFormPgRegistry(this.exec, (fn) => this.$transaction(fn));
    this.User = registry.User;
    this.Post = registry.Post;
  }

  $transaction(fnOrOps) {
    if (Array.isArray(fnOrOps)) {
      for (const op of fnOrOps) {
        if (!isIndigoPromise(op)) {
          throw new IndigoTransactionError(
            "NOT_A_DEFERRED_OPERATION",
            "$transaction array elements must be deferred operations returned by a model " +
              `delegate method (e.g. db.user.create(...)), got ${typeof op}. If this value comes ` +
              "from a generated client, regenerate it.",
          );
        }
      }
      if (fnOrOps.length === 0) {
        return Promise.resolve([]);
      }
      return this.$withSession((exec) => runDeferred(fnOrOps, buildArrayFormPgRegistry(exec)));
    }
    return this.$withSession((exec) => fnOrOps(buildArrayFormPgRegistry(exec)));
  }
}

await check(
  "pg.Pool: array-form $transaction commits both ops atomically, in order",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new ArrayFormPgClient({ connectionString });
      try {
        await client.$queryRaw(CREATE_USER_TABLE_FOR_ARRAY);
        await client.$queryRaw(CREATE_POST_TABLE_FOR_ARRAY);

        const [user, post] = await client.$transaction([
          client.User.create({ data: { name: "Ada" } }),
          client.Post.create({ data: { title: "Hello", authorId: 1 } }),
        ]);
        assert(user.name === "Ada", "expected the first op's result to be the created User");
        assert(post.title === "Hello", "expected the second op's result to be the created Post");

        const users = await client.$queryRaw('SELECT * FROM "User"');
        const posts = await client.$queryRaw('SELECT * FROM "Post"');
        assert(users.length === 1, "expected the User row to be visible after commit");
        assert(posts.length === 1, "expected the Post row to be visible after commit");
      } finally {
        await client.$disconnect();
      }
    });
  },
);

await check(
  "pg.Pool: array-form $transaction rolls back all ops against a real Postgres instance when the second op fails",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const client = new ArrayFormPgClient({ connectionString, pool: { max: 1 } });
      try {
        await client.$queryRaw(CREATE_USER_TABLE_FOR_ARRAY);
        await client.$queryRaw(CREATE_POST_TABLE_FOR_ARRAY);

        let caught;
        try {
          await client.$transaction([
            client.User.create({ data: { name: "Ada" } }),
            // `title` is NOT NULL — violates the constraint, rolling back the
            // whole array including the first op's already-inserted row.
            client.Post.create({ data: { title: null, authorId: 1 } }),
          ]);
        } catch (err) {
          caught = err;
        }
        assert(caught instanceof Error, "expected the array-form $transaction to reject");

        const users = await client.$queryRaw('SELECT * FROM "User"');
        assert(users.length === 0, "expected the first op's row to be absent after a real-Postgres rollback");

        // Proves the pool's sole connection was genuinely released (not
        // leaked) despite the rollback — a hung/leaked connection would
        // deadlock this against `pool: { max: 1 }`, and `check`'s
        // `withTimeout` wrapper turns that into an explicit failure.
        const [afterRollbackUser] = await client.$transaction([client.User.create({ data: { name: "AfterRollback" } })]);
        assert(afterRollbackUser.name === "AfterRollback", "expected the client to remain usable after a rolled-back array transaction");
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
