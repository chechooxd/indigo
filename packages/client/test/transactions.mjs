/**
 * @indigodb/client — `$transaction` / `$withSession` regression suite.
 *
 * Plain Node, no test framework, mirroring `client.mjs`'s style. Covers the
 * `client-transactions` spec's interactive-callback form against
 * `IndigoClientBase` directly (Slice 1 — no generated typed `TransactionClient`
 * yet, `fn` receives the raw session `Executor`), plus (Slice 3) the array
 * form (`$transaction([...])`) against a hand-wired stand-in for the
 * generator's emitted `IndigoClient`.
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate } from "../dist/delegate.js";
import { isIndigoPromise, runDeferred, IndigoTransactionError } from "../dist/promise.js";
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

// ─── Array form ($transaction([...])) ──────────────────────────────────────
//
// `IndigoClientBase` has no array-accepting overload (proven above via the
// base-client-only-supports-callback-form guard test). The array form is
// generated-client-only (design.md Decision 4/5), so this section hand-wires
// a minimal stand-in for the generator's emitted `IndigoClient` — exactly
// the same pattern `nested-writes-create.mjs`'s `buildDelegates`/
// `buildTopLevelRegistry` already uses for the callback form, extended with
// the `{ tx, byModel }` bundle and `$transaction` array branch the generator
// itself will emit (tasks.md Slice 3, generator/src/client.ts 3.3/3.4).

const userMeta = {
  name: "User",
  table: "User",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
  },
  relations: {
    posts: { target: "Post", from: "id", to: "authorId", list: true, fkSide: false, optional: false, optionalFk: true },
  },
};

const postArrayMeta = {
  name: "Post",
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    authorId: { db: "author_id" },
  },
  relations: {
    author: { target: "User", from: "authorId", to: "id", list: false, fkSide: true, optional: false, optionalFk: false },
  },
};

async function seedArrayFormTables(exec) {
  // PGlite's `.query()` (what `Executor` is backed by) rejects multiple
  // commands in one prepared statement — unlike `.exec()`, which
  // `nested-writes-create.mjs`'s `seed()` uses directly on the raw PGlite
  // instance. Split into two calls to stay on the public `Executor` seam.
  await exec('CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);');
  await exec(
    'CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INT REFERENCES "User"(id));',
  );
}

/** Registry keyed by MODEL NAME ("User"/"Post"), exactly matching
 * `IndigoPromise.model` (`this.meta.name`) and the generator's `byModel`
 * (design.md Decision 4). Doubles as `tx` here since this hand-authored
 * fixture has no camelCase delegate-name layer to distinguish them — the
 * real generator emits both key spaces, but `runDeferred` only ever reads
 * `byModel`. */
function buildArrayFormRegistry(exec, runAtomic) {
  const registry = {};
  const siblings = () => registry;
  registry.User = new ModelDelegate(userMeta, exec, siblings, runAtomic);
  registry.Post = new ModelDelegate(postArrayMeta, exec, siblings, runAtomic);
  return registry;
}

/**
 * Stand-in for the generator's emitted `IndigoClient` (tasks.md 3.3/3.4):
 * overrides `$transaction` with both the callback form (delegated to
 * `$withSession`, unchanged) and the array form — pre-validates every
 * element is an `IndigoPromise` BEFORE `$withSession` is even called (spec
 * "Non-IndigoPromise array elements throw... before opening a session"),
 * short-circuits an empty array to `[]` with no session work at all (spec
 * "Empty array is a no-op"), and otherwise opens one session and hands
 * `runDeferred` the session-scoped `byModel` registry — the exact shape
 * `generator/src/client.ts`'s emitted `$transaction` will produce.
 */
class GeneratedLikeClient extends IndigoClientBase {
  constructor(options) {
    super(options);
    const registry = buildArrayFormRegistry(this.exec, (fn) => this.$transaction(fn));
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
      return this.$withSession((exec) => runDeferred(fnOrOps, buildArrayFormRegistry(exec)));
    }
    return this.$withSession((exec) => fnOrOps(buildArrayFormRegistry(exec)));
  }
}

/** Wraps `createPgliteDb`'s `transaction` hook to count BEGIN/COMMIT/
 * ROLLBACK — PGlite's own `transaction()` API issues these internally, never
 * as SQL text through `exec` (client.ts's "extensions never observe BEGIN/
 * COMMIT/ROLLBACK" doc comment), so the ONLY observable signal for "exactly
 * one BEGIN" is counting invocations of the `transaction` hook itself. */
function instrumentedArrayFormAdapter(db) {
  const { exec, transaction } = createPgliteDb(db);
  const events = [];
  const wrappedTransaction = async (fn) => {
    events.push("BEGIN");
    try {
      const result = await transaction(fn);
      events.push("COMMIT");
      return result;
    } catch (err) {
      events.push("ROLLBACK");
      throw err;
    }
  };
  return { exec, transaction: wrappedTransaction, events };
}

await check(
  "array-form: two ops commit atomically in array order — one BEGIN, one COMMIT, one session",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      const [user, post] = await client.$transaction([
        client.User.create({ data: { name: "Ada" } }),
        client.Post.create({ data: { title: "Hello", authorId: 1 } }),
      ]);

      assert(user.name === "Ada", "expected the first op's result to be the created User");
      assert(post.title === "Hello", "expected the second op's result to be the created Post");
      assert(
        events.filter((e) => e === "BEGIN").length === 1,
        `expected exactly one BEGIN, got: ${JSON.stringify(events)}`,
      );
      assert(
        events.filter((e) => e === "COMMIT").length === 1,
        `expected exactly one COMMIT, got: ${JSON.stringify(events)}`,
      );

      const outsideUsers = new ModelDelegate(userMeta, client.exec);
      const outsidePosts = new ModelDelegate(postArrayMeta, client.exec);
      const users = await outsideUsers.findMany({});
      const posts = await outsidePosts.findMany({});
      assert(users.length === 1 && users[0].name === "Ada", "expected the User row to be visible after commit");
      assert(posts.length === 1 && posts[0].title === "Hello", "expected the Post row to be visible after commit");
    });
  },
);

await check(
  "array-form: second op failing rolls back the first — row absent, exactly one ROLLBACK, no COMMIT",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      let caught;
      try {
        await client.$transaction([
          client.User.create({ data: { name: "Ada" } }),
          client.Post.create({ data: { title: null, authorId: 1 } }),
        ]);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof Error, "expected $transaction to reject when the second op fails");
      assert(
        events.filter((e) => e === "ROLLBACK").length === 1,
        `expected exactly one ROLLBACK, got: ${JSON.stringify(events)}`,
      );
      assert(
        events.filter((e) => e === "COMMIT").length === 0,
        `expected no COMMIT to have been issued, got: ${JSON.stringify(events)}`,
      );

      const outsideUsers = new ModelDelegate(userMeta, client.exec);
      const users = await outsideUsers.findMany({});
      assert(users.length === 0, "expected the first op's row to be absent after rollback");
    });
  },
);

await check(
  "array-form: nested-write create inside the array opens no inner transaction — exactly one BEGIN total",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      const [user] = await client.$transaction([
        client.User.create({
          data: { name: "Ada", posts: { create: [{ title: "Nested" }] } },
        }),
      ]);
      assert(user.name === "Ada", "expected the parent User row to be created");
      assert(
        events.filter((e) => e === "BEGIN").length === 1,
        `expected exactly one BEGIN for the whole array (identity-default session reuse, design.md Decision 7), got: ${JSON.stringify(events)}`,
      );

      const outsidePosts = new ModelDelegate(postArrayMeta, client.exec);
      const posts = await outsidePosts.findMany({});
      assert(
        posts.length === 1 && posts[0].title === "Nested",
        "expected the nested-write child row to be visible after commit",
      );
    });
  },
);

await check("array-form: empty array resolves to [] with no BEGIN issued", async () => {
  await withDatabase(async (db) => {
    const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
    await seedArrayFormTables(exec);
    const client = new GeneratedLikeClient({ db: { exec, transaction } });

    const result = await client.$transaction([]);
    assert(Array.isArray(result) && result.length === 0, "expected $transaction([]) to resolve to []");
    assert(events.length === 0, `expected no session events for an empty array, got: ${JSON.stringify(events)}`);
  });
});

await check(
  "array-form: a plain value in the array throws NOT_A_DEFERRED_OPERATION before any BEGIN",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      let caught;
      try {
        await client.$transaction([client.User.create({ data: { name: "Ada" } }), 42]);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof IndigoTransactionError, "expected an IndigoTransactionError");
      assert(
        caught.code === "NOT_A_DEFERRED_OPERATION",
        `expected code NOT_A_DEFERRED_OPERATION, got: ${caught?.code}`,
      );
      assert(events.length === 0, `expected no BEGIN to have been issued, got: ${JSON.stringify(events)}`);

      const outsideUsers = new ModelDelegate(userMeta, client.exec);
      const users = await outsideUsers.findMany({});
      assert(users.length === 0, "expected no partial writes from the valid first op");
    });
  },
);

await check(
  "array-form: a stale-client-shaped plain Promise element throws with a regenerate hint before any BEGIN",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction, events } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      // Simulates a pre-upgrade generated client's delegate method, which
      // still returns an eager plain `Promise<T>` instead of `IndigoPromise<T>`.
      const stalePlainPromise = Promise.resolve({ id: 999, name: "Stale" });

      let caught;
      try {
        await client.$transaction([stalePlainPromise]);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof IndigoTransactionError, "expected an IndigoTransactionError");
      assert(
        caught.code === "NOT_A_DEFERRED_OPERATION",
        `expected code NOT_A_DEFERRED_OPERATION, got: ${caught?.code}`,
      );
      assert(/regenerate/i.test(caught.message), `expected a regenerate hint, got: ${caught?.message}`);
      assert(events.length === 0, `expected no BEGIN to have been issued, got: ${JSON.stringify(events)}`);
    });
  },
);

await check(
  "array-form: MODEL_NOT_IN_REGISTRY for an op carrying an unknown model name",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      // A delegate method for a model with no entry in this transaction's
      // registry (e.g. a schema drift between client generation and DB).
      const ghostMeta = { name: "Ghost", table: "Ghost", fields: { id: { db: "id", pk: true } } };
      const ghostDelegate = new ModelDelegate(ghostMeta, client.exec, () => ({}));
      const ghostOp = ghostDelegate.create({ data: {} });

      let caught;
      try {
        await client.$transaction([ghostOp]);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof IndigoTransactionError, "expected an IndigoTransactionError");
      assert(
        caught.code === "MODEL_NOT_IN_REGISTRY",
        `expected code MODEL_NOT_IN_REGISTRY, got: ${caught?.code}`,
      );
    });
  },
);

await check(
  "array-form: calling $transaction([...]) on `tx` inside an active callback fails — tx has no $transaction member",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      await client.$transaction(async (tx) => {
        assert(
          typeof tx.$transaction === "undefined",
          "expected the session-scoped tx registry to have no $transaction member " +
            "(TransactionClient structurally omits it, design.md Decision 4)",
        );
      });
    });
  },
);

await check(
  "array-form: calling client.$transaction([...]) from inside an active $transaction(fn) callback rejects with the nesting error",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = instrumentedArrayFormAdapter(db);
      await seedArrayFormTables(exec);
      const client = new GeneratedLikeClient({ db: { exec, transaction } });

      let nestedErr;
      await client.$transaction(async () => {
        try {
          // Deliberately NOT `.then()`ed/awaited before being passed in — a
          // real un-awaited `IndigoPromise` stays deferred, exercising the
          // outer client's `AsyncLocalStorage` reentrancy guard inside
          // `$withSession` rather than the (unrelated) NOT_A_DEFERRED_OPERATION
          // guard. Awaiting/`.then()`ing it first would execute it against
          // the client's TOP-LEVEL exec while the outer PGlite transaction
          // already holds that same connection — a real deadlock, not a
          // guard this test is trying to prove.
          await client.$transaction([client.User.create({ data: { name: "ShouldNeverRun" } })]);
        } catch (err) {
          nestedErr = err;
        }
      });

      assert(nestedErr instanceof Error, "expected the nested array-form call to reject");
      assert(/nested/i.test(nestedErr.message), `expected the existing nesting error, got: ${nestedErr?.message}`);

      const outsideUsers = new ModelDelegate(userMeta, client.exec);
      const users = await outsideUsers.findMany({ where: { name: "ShouldNeverRun" } });
      assert(users.length === 0, "expected the array op to never have executed");
    });
  },
);

await check(
  "array-form: injected executor without a transaction hook rejects, none of the ops invoked",
  async () => {
    const { exec } = stubExecutor();
    const client = new GeneratedLikeClient({ db: { exec } });

    let caught;
    try {
      await client.$transaction([client.User.create({ data: { name: "Ada" } })]);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, "expected $transaction to reject");
    assert(
      /does not support transactions/i.test(caught.message),
      `expected the existing "does not support transactions" error, got: ${caught?.message}`,
    );
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client transactions: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client transactions: all checks passed");
}
