/**
 * @indigodb/client — Executor seam regression suite.
 *
 * Plain Node, no test framework, mirroring `packages/migrator/test` and
 * `packages/cli/test`'s style. Proves the seam mechanism only: construction
 * on both paths, the exact missing-connection-string error, `$queryRaw`
 * path-independence, `$disconnect` on all three variants, realtime teardown,
 * and ONE happy-path CRUD round-trip through the injected executor. It does
 * NOT audit `buildWhere`'s operators, column aliasing or `select`/`orderBy`/
 * `take`/`skip` — that is separate, larger ORM-parity work.
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate } from "../dist/delegate.js";
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

/** Exposes the protected `$realtime()` thunk for white-box assertions. */
class TestClient extends IndigoClientBase {
  triggerRealtime() {
    return this.$realtime();
  }
}

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

// ─── Phase 2: constructor seam ────────────────────────────────────────────

await check("constructs with options.db and no connectionString/pool", () => {
  const { exec } = stubExecutor();
  const client = new IndigoClientBase({ db: { exec } });
  // `private` compiles away — TS fields are ordinary properties at runtime,
  // so this white-box read is how the spec's "no pg.Pool is constructed on
  // the injected path" requirement gets a real assertion instead of "the
  // constructor didn't throw" standing in for it.
  assert(client["pool"] === null, "no pg.Pool should be constructed when options.db is supplied");
});

await check(
  "throws the exact original error when neither db, connectionString/DATABASE_URL, nor pool is given",
  () => {
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      let threw = false;
      let message = "";
      try {
        new IndigoClientBase({});
      } catch (err) {
        threw = true;
        message = err.message;
      }
      assert(threw, "expected constructor to throw");
      assert(
        message ===
          "IndigoClient: no connection string. Pass `connectionString` or set DATABASE_URL.",
        `unexpected error message: ${message}`,
      );
    } finally {
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  },
);

await check("does not throw when options.db is given even without connectionString/pool/DATABASE_URL", () => {
  const savedUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { exec } = stubExecutor();
    new IndigoClientBase({ db: { exec } });
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
  }
});

// ─── Phase 3: exec / $queryRaw path-independence ──────────────────────────

await check("$queryRaw returns exactly the injected executor's rows", async () => {
  const rows = [{ id: 1, name: "Ada" }];
  const { exec, calls } = stubExecutor(rows);
  const client = new IndigoClientBase({ db: { exec } });
  const result = await client.$queryRaw("SELECT 1", []);
  assert(result === rows, "expected $queryRaw to return the exact rows array");
  assert(calls.length === 1, "expected the injected executor to be called once");
});

// ─── Phase 4: $disconnect across all three variants ───────────────────────

await check("injected-with-close: $disconnect calls close, not any pool method", async () => {
  const { exec } = stubExecutor();
  let closed = false;
  const client = new IndigoClientBase({
    db: {
      exec,
      close: async () => {
        closed = true;
      },
    },
  });
  await client.$disconnect();
  assert(closed, "expected close() to be called");
});

await check("injected-without-close: $disconnect resolves without throwing", async () => {
  const { exec } = stubExecutor();
  const client = new IndigoClientBase({ db: { exec } });
  await client.$disconnect();
});

// ─── Phase 4: realtime teardown on all paths ──────────────────────────────

await check("realtime is torn down on $disconnect (injected path)", async () => {
  const { exec } = stubExecutor();
  const client = new TestClient({
    db: { exec },
    realtime: { url: "http://127.0.0.1:1" },
  });
  client.triggerRealtime();
  assert(client.realtimeManager !== null, "expected a realtime manager to exist");
  await client.$disconnect();
  assert(client.realtimeManager === null, "expected realtime manager to be torn down");
});

await check("realtime is torn down on $disconnect (default pool path)", async () => {
  const client = new TestClient({
    connectionString: "postgres://unused/unused",
    realtime: { url: "http://127.0.0.1:1" },
  });
  client.triggerRealtime();
  assert(client.realtimeManager !== null, "expected a realtime manager to exist");
  await client.$disconnect();
  assert(client.realtimeManager === null, "expected realtime manager to be torn down");
});

await check("$disconnect calls pool.end() on the default (non-injected) path", async () => {
  const client = new IndigoClientBase({ connectionString: "postgres://unused/unused" });
  const pool = client["pool"];
  let endCalled = false;
  const originalEnd = pool.end.bind(pool);
  // A spy, not a stub: still calls through to the real pg.Pool#end so this
  // doesn't mask a genuine failure there, it only proves $disconnect() is
  // the caller — a regression that silently dropped that call would leave
  // endCalled false while $disconnect() itself keeps resolving cleanly.
  pool.end = async (...args) => {
    endCalled = true;
    return originalEnd(...args);
  };
  await client.$disconnect();
  assert(endCalled === true, "$disconnect() must call pool.end() on the default path");
});

// ─── Phase 5: CRUD passthrough smoke test ─────────────────────────────────

await check("create -> findMany -> update -> delete round-trips through the injected executor", async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE TABLE "Post" (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        published BOOLEAN NOT NULL DEFAULT false
      );
    `);

    const client = new IndigoClientBase({ db: { exec: createPgliteExecutor(db) } });
    const meta = {
      table: "Post",
      fields: {
        id: { db: "id", pk: true },
        title: { db: "title" },
        published: { db: "published" },
      },
    };
    const posts = new ModelDelegate(meta, client.exec);

    const created = await posts.create({ data: { title: "Hello", published: false } });
    assert(created.title === "Hello", "expected create() to return the inserted row");

    const found = await posts.findMany({ where: { id: created.id } });
    assert(found.length === 1, "expected findMany() to find the created row");
    assert(found[0].title === "Hello", "expected findMany() row to match");

    const updated = await posts.update({
      where: { id: created.id },
      data: { published: true },
    });
    assert(updated.published === true, "expected update() to persist the change");

    const deleted = await posts.delete({ where: { id: created.id } });
    assert(deleted.id === created.id, "expected delete() to return the removed row");

    const afterDelete = await posts.findMany({ where: { id: created.id } });
    assert(afterDelete.length === 0, "expected the row to be gone after delete()");
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client: all checks passed");
}
