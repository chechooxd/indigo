/**
 * @indigodb/client — `$auth` regression suite (`client-auth-context` spec,
 * design.md decisions 15/16, tasks.md C3.1/C3.2/C3.3).
 *
 * Plain Node, no test framework, mirroring `transactions.mjs`'s style.
 * `IndigoClientBase` exposes the underlying mechanics as `protected
 * $authSession` (only the generated `IndigoClient` exposes the public,
 * typed `$auth`) — a thin `TestClient` subclass exposes it for white-box
 * assertions, the same pattern `client.mjs` uses for `$realtime()`.
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

/**
 * Exposes the protected `$authSession` for white-box assertions.
 * `IndigoClientBase` names this `$authSession`, not `$auth` — the generated
 * `IndigoClient`'s public `$auth` (see `generator/src/client.ts`) is a NEW
 * method built on top of it, never a same-named override (a real override
 * here would narrow the callback parameter type and fail TypeScript's
 * strict override-compatibility check; see `client.ts`'s doc comment).
 */
class TestClient extends IndigoClientBase {
  auth(ctx, fn) {
    return this.$authSession(ctx, fn);
  }
}

const postMeta = {
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    ownerId: { db: "ownerId" },
    title: { db: "title" },
  },
};

async function createPostTable(exec) {
  await exec(`
    CREATE TABLE "Post" (
      id SERIAL PRIMARY KEY,
      "ownerId" integer NOT NULL,
      title TEXT NOT NULL
    );
  `);
}

console.log("@indigodb/client: $auth");

// ─── C3.1: $auth issues set_config as a bound param, then delegates to fn ──

await check(
  "$auth issues SELECT set_config('app.user_id', $1, true) as a bound param before delegating to fn",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);

      // Records every statement issued through the SESSION-scoped executor
      // (the one `$withSession`'s hook hands to `$auth`'s inner callback) —
      // wrapping `transaction` itself, not `client.exec`, since `set_config`
      // is issued on the session exec, never on the outer pooled `exec`.
      const calls = [];
      const recordingTransaction = (fn) =>
        transaction((sessionExec) => {
          const wrapped = async (sql, params) => {
            calls.push({ sql, params });
            return sessionExec(sql, params);
          };
          return fn(wrapped);
        });

      const client = new TestClient({ db: { exec, transaction: recordingTransaction } });

      await client.auth({ userId: 42 }, async (sessionExec) => {
        return sessionExec("SELECT 1", []);
      });

      const setConfigCall = calls.find((c) => c.sql.includes("set_config"));
      assert(setConfigCall, `expected a set_config call, got ${JSON.stringify(calls)}`);
      assert(
        setConfigCall.sql.includes("$1"),
        "set_config's value must be a bound parameter ($1), never string-interpolated",
      );
      assert(
        setConfigCall.params[0] === "42",
        `expected the bound param to carry the userId, got ${JSON.stringify(setConfigCall.params)}`,
      );
    });
  },
);

// ─── C3.2 (threat: SQL injection via the auth value) ───────────────────────

await check(
  "$auth({userId: \"1'; DROP TABLE ...\"}) leaves the schema intact — the value is bound, never interpolated",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new TestClient({ db: { exec, transaction } });

      await client.auth({ userId: "1'; DROP TABLE \"Post\"; --" }, async (sessionExec) => {
        return sessionExec("SELECT 1", []);
      });

      const posts = new ModelDelegate(postMeta, client.exec);
      const found = await posts.findMany({});
      assert(Array.isArray(found), "expected the Post table to still exist and be queryable");
    });
  },
);

// ─── C3.3: $auth built on $withSession; identity dies at COMMIT/ROLLBACK ───

await check(
  "$auth is built on $withSession: a write made inside is visible after commit (BEGIN/COMMIT owned by $withSession, not reimplemented)",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new TestClient({ db: { exec, transaction } });

      const created = await client.auth({ userId: 7 }, async (sessionExec) => {
        const posts = new ModelDelegate(postMeta, sessionExec);
        return posts.create({ data: { ownerId: 7, title: "Hello" } });
      });
      assert(created.title === "Hello", "expected $auth's fn result to be returned");

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const found = await outsidePosts.findMany({});
      assert(found.length === 1, "expected the write to be visible after commit");
    });
  },
);

await check(
  "$auth's identity does not leak across a recycled pooled connection: a later query on the SAME db handle, made WITHOUT $auth, sees no residual app.user_id",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new TestClient({ db: { exec, transaction } });

      await client.auth({ userId: 7 }, async (sessionExec) => {
        const posts = new ModelDelegate(postMeta, sessionExec);
        return posts.create({ data: { ownerId: 7, title: "Hello" } });
      });

      // A query OUTSIDE $auth on the same client/connection must not see the
      // prior transaction's `app.user_id` — `set_config(..., true)` is
      // transaction-local, so it must not survive the COMMIT that closed
      // the $auth session above.
      const rows = await client.exec(
        "SELECT current_setting('app.user_id', true) AS v",
        [],
      );
      assert(
        rows[0].v === null || rows[0].v === "",
        `expected no residual app.user_id outside the $auth session, got ${JSON.stringify(rows[0].v)}`,
      );
    });
  },
);

await check(
  "rejects if a $transaction/$auth call is already in flight (no nested transactions, same guard as $transaction)",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await createPostTable(exec);
      const client = new TestClient({ db: { exec, transaction } });

      let caught;
      try {
        await client.auth({ userId: 1 }, async () => {
          return client.auth({ userId: 2 }, async () => {});
        });
      } catch (err) {
        caught = err;
      }
      assert(caught, "expected a nesting error");
      assert(/cannot be nested/.test(caught.message), caught.message);
    });
  },
);

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all $auth cases passed.");
}
