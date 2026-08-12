/**
 * @indigodb/client — nested-write CREATE planner (PR B, nested-writes).
 *
 * PR B (tasks.md B1.1-B3.1) — `ModelDelegate.create` gains a planner: it
 * splits `data` into scalars vs. relation sub-operations, rejects unknown
 * keys before any SQL runs (spec Requirement 5), and executes relation ops
 * in three phases inside one `runAtomic` session (design.md Data Flow, spec
 * Requirement 6): fkSide ops before the parent insert, non-fkSide ops after.
 *
 * Layout:
 *  - B1.1: op split — unit tests against a stub Executor (scalars vs.
 *    relOps vs. UNKNOWN_FIELD, no SQL for the rejected call).
 *  - B1.2: 3-phase ordering — unit tests against a counting/recording stub
 *    Executor, proving fkSide-before-parent-insert / non-fkSide-after.
 *  - B1.3: PGlite integration — to-one/to-many create/connect/connectOrCreate,
 *    `connect` miss -> CONNECT_NOT_FOUND + rollback, child failure rolls
 *    back the parent (spec Requirement 7).
 *  - B1.4: nested create issued via `tx.<model>.create` inside an active
 *    `$transaction` joins that session — no double-open.
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate, IndigoNestedWriteError } from "../dist/delegate.js";
import { withDatabase, createPgliteExecutor, createPgliteDb } from "./pglite-harness.mjs";

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

// ─── Fixture: User 1-N Post (author, fkSide on Post), User 1-1 Profile (fkSide on Profile) ──

const userMeta = {
  name: "User",
  table: "User",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
    email: { db: "email" },
  },
  relations: {
    posts: { target: "Post", from: "id", to: "authorId", list: true, fkSide: false, optional: false, optionalFk: true },
    profile: { target: "Profile", from: "id", to: "userId", list: false, fkSide: false, optional: true, optionalFk: true },
  },
};

const postMeta = {
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

const profileMeta = {
  name: "Profile",
  table: "Profile",
  fields: {
    id: { db: "id", pk: true },
    bio: { db: "bio" },
    userId: { db: "user_id" },
  },
  relations: {
    user: { target: "User", from: "userId", to: "id", list: false, fkSide: true, optional: false, optionalFk: false },
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

/** DDL setup — a real PGlite backend, matching relations.mjs's style. */
async function seed(db) {
  await db.exec(`
    CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE "Post" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INT NOT NULL REFERENCES "User"(id)
    );
    CREATE TABLE "Profile" (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INT NOT NULL UNIQUE REFERENCES "User"(id));
  `);
}

/** Builds the three delegates wired to each other via a sibling registry,
 * exactly as `__delegates` does in the generated client. */
function buildDelegates(exec, runAtomic) {
  const registry = {};
  const siblings = () => registry;
  registry.User = new ModelDelegate(userMeta, exec, siblings, runAtomic);
  registry.Post = new ModelDelegate(postMeta, exec, siblings, runAtomic);
  registry.Profile = new ModelDelegate(profileMeta, exec, siblings, runAtomic);
  return registry;
}

/**
 * Wires a REAL top-level `runAtomic`, exactly as the generated constructor
 * does (`(fn) => this.$transaction(fn as never)`) — genuine rollback
 * requires an actual transaction, not the identity default `buildDelegates`
 * alone provides. Any test asserting a rolled-back parent row (a phase-3
 * failure after the parent insert already ran) MUST use this, not raw
 * `buildDelegates(exec)`.
 */
function buildTopLevelRegistry(client) {
  const topLevelRunAtomic = (fn) => client.$transaction((txExec) => fn(buildDelegates(txExec)));
  return buildDelegates(client.exec, topLevelRunAtomic);
}

console.log("@indigodb/client: nested-write create planner");

// ─── B1.1: op split — scalars vs. relOps vs. UNKNOWN_FIELD ────────────────

await check("B1.1a: scalar-only data skips the planner entirely — same SQL as pre-change create()", async () => {
  const { exec, calls } = stubExecutor([{ id: 1, name: "Ada", email: "ada@x.com" }]);
  const { User } = buildDelegates(exec);
  await User.create({ data: { name: "Ada", email: "ada@x.com" } });
  assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
  assert(
    calls[0].sql === 'INSERT INTO "User" ("name", "email") VALUES ($1, $2) RETURNING "id" AS "id", "name" AS "name", "email" AS "email"',
    `unexpected SQL: ${calls[0].sql}`,
  );
});

await check("B1.1b: unknown key throws UNKNOWN_FIELD before any SQL is issued", async () => {
  const { exec, calls } = stubExecutor();
  const { User } = buildDelegates(exec);
  let threw = false;
  try {
    await User.create({ data: { name: "Ada", email: "ada@x.com", notAField: "x" } });
  } catch (err) {
    threw = true;
    assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
    assert(err.code === "UNKNOWN_FIELD", `expected code UNKNOWN_FIELD, got ${err.code}`);
    assert(/notAField/.test(err.message), `expected message to name the field, got: ${err.message}`);
  }
  assert(threw, "expected create() to reject");
  assert(calls.length === 0, "expected NO SQL statement to be issued for an unknown-field call");
});

await check("B1.1c: relation-op key is routed to relOps, not treated as an unknown/scalar field", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User } = buildDelegates(exec);
    // `posts` is a declared relation on User — must not throw UNKNOWN_FIELD.
    const user = await User.create({ data: { name: "Ada", email: "ada@x.com", posts: { create: [{ title: "P1" }] } } });
    assert(user.name === "Ada", "expected the parent row to be created");
  });
});

// ─── B1.2: 3-phase ordering ────────────────────────────────────────────────

await check("B1.2a: fkSide relation op resolves BEFORE the parent insert", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const calls = [];
    const recordingExec = async (sql, params) => {
      calls.push(sql);
      return exec(sql, params);
    };
    const { Post } = buildDelegates(recordingExec);
    await Post.create({ data: { title: "P1", authorId: 0, author: { create: { name: "Ada", email: "ada@x.com" } } } });

    const userInsertIdx = calls.findIndex((sql) => sql.includes('INSERT INTO "User"'));
    const postInsertIdx = calls.findIndex((sql) => sql.includes('INSERT INTO "Post"'));
    assert(userInsertIdx !== -1 && postInsertIdx !== -1, "expected both inserts to happen");
    assert(userInsertIdx < postInsertIdx, "expected the fkSide (author/User) insert to happen BEFORE the parent (Post) insert");
  });
});

await check("B1.2b: non-fkSide relation op resolves AFTER the parent insert", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const calls = [];
    const recordingExec = async (sql, params) => {
      calls.push(sql);
      return exec(sql, params);
    };
    const { User } = buildDelegates(recordingExec);
    await User.create({ data: { name: "Ada", email: "ada@x.com", posts: { create: [{ title: "P1" }] } } });

    const userInsertIdx = calls.findIndex((sql) => sql.includes('INSERT INTO "User"'));
    const postInsertIdx = calls.findIndex((sql) => sql.includes('INSERT INTO "Post"'));
    assert(userInsertIdx !== -1 && postInsertIdx !== -1, "expected both inserts to happen");
    assert(userInsertIdx < postInsertIdx, "expected the parent (User) insert to happen BEFORE the non-fkSide (posts/Post) insert");
  });
});

// ─── B1.3: PGlite integration — each op x cardinality, rollback ───────────

await check("B1.3a: to-one create nested under parent create (fkSide)", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Post } = buildDelegates(exec);
    const post = await Post.create({
      data: { title: "x", authorId: 0, author: { create: { name: "A", email: "a@x.com" } } },
    });
    assert(typeof post.authorId === "number" && post.authorId > 0, "expected the post's FK to reference the new author");
  });
});

await check("B1.3b: to-many create nested under parent create (non-fkSide)", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const user = await User.create({
      data: { name: "A", email: "a@x.com", posts: { create: [{ title: "x" }] } },
    });
    const posts = await Post.findMany({ where: { authorId: user.id } });
    assert(posts.length === 1, "expected exactly one post to be created and linked");
    assert(posts[0].title === "x", "expected the post's title to match");
  });
});

await check("B1.3c: connect links an existing row, no new row inserted", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const existing = await User.create({ data: { name: "A", email: "a@x.com" } });

    const calls = [];
    const recordingExec = async (sql, params) => {
      calls.push(sql);
      return exec(sql, params);
    };
    const { Post: PostRec } = buildDelegates(recordingExec);
    const post = await PostRec.create({
      data: { title: "x", authorId: 0, author: { connect: { id: existing.id } } },
    });
    assert(post.authorId === existing.id, "expected the post's FK to be set to the connected author");
    assert(!calls.some((sql) => sql.includes('INSERT INTO "User"')), "expected NO new author row to be inserted");
  });
});

await check("B1.3d: connect to a non-existent row throws CONNECT_NOT_FOUND and rolls back — no post row inserted", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Post } = buildDelegates(exec);
    let threw = false;
    try {
      await Post.create({ data: { title: "x", authorId: 0, author: { connect: { id: 999 } } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
      assert(err.code === "CONNECT_NOT_FOUND", `expected code CONNECT_NOT_FOUND, got ${err.code}`);
    }
    assert(threw, "expected create() to reject");
    const posts = await Post.findMany({});
    assert(posts.length === 0, "expected NO post row to have been inserted (rolled back)");
  });
});

await check("B1.3e: connectOrCreate falls back to create when the lookup misses", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const post = await Post.create({
      data: {
        title: "x",
        authorId: 0,
        author: { connectOrCreate: { where: { email: "new@x.com" }, create: { name: "New", email: "new@x.com" } } },
      },
    });
    const users = await User.findMany({ where: { email: "new@x.com" } });
    assert(users.length === 1, "expected a new author row to be created");
    assert(post.authorId === users[0].id, "expected the post's FK to reference the newly created author");
  });
});

await check("B1.3f: connectOrCreate connects when the lookup finds a match — no duplicate row", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const existing = await User.create({ data: { name: "A", email: "a@x.com" } });
    const post = await Post.create({
      data: {
        title: "x",
        authorId: 0,
        author: { connectOrCreate: { where: { email: "a@x.com" }, create: { name: "Dup", email: "a@x.com" } } },
      },
    });
    const users = await User.findMany({ where: { email: "a@x.com" } });
    assert(users.length === 1, "expected NO duplicate author row");
    assert(post.authorId === existing.id, "expected the post's FK to reference the EXISTING author");
  });
});

await check("B1.3g: to-many connect on User.posts links an existing post — no new post inserted", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const bootstrap = buildDelegates(exec);
    const owner = await bootstrap.User.create({ data: { name: "Owner", email: "owner@x.com" } });
    const looseUserForPost = await bootstrap.User.create({ data: { name: "Temp", email: "temp@x.com" } });
    const orphanPost = await bootstrap.Post.create({ data: { title: "orphan", authorId: looseUserForPost.id } });

    const calls = [];
    const recordingExec = async (sql, params) => {
      calls.push(sql);
      return exec(sql, params);
    };
    const { User } = buildDelegates(recordingExec);
    await User.create({
      data: { name: "New", email: "new-owner@x.com", posts: { connect: [{ id: orphanPost.id }] } },
    });
    assert(!calls.some((sql) => sql.includes('INSERT INTO "Post"')), "expected NO new post row to be inserted");

    const relinked = await bootstrap.Post.findMany({ where: { id: orphanPost.id } });
    assert(relinked[0].authorId !== owner.id, "sanity: relinked post should not accidentally point at `owner`");
    assert(relinked[0].authorId !== looseUserForPost.id, "expected the post's FK to be reassigned off its original author");
  });
});

await check("B1.3h: to-many connect on a non-existent row throws CONNECT_NOT_FOUND and rolls back the parent", async () => {
  await withDatabase(async (db) => {
    const { exec, transaction } = createPgliteDb(db);
    await seed(db);
    const client = new IndigoClientBase({ db: { exec, transaction } });
    const { User } = buildTopLevelRegistry(client);
    let threw = false;
    try {
      await User.create({ data: { name: "New", email: "new@x.com", posts: { connect: [{ id: 999 }] } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
      assert(err.code === "CONNECT_NOT_FOUND", `expected code CONNECT_NOT_FOUND, got ${err.code}`);
    }
    assert(threw, "expected create() to reject");
    const users = await User.findMany({ where: { email: "new@x.com" } });
    assert(users.length === 0, "expected NO user row to have been inserted (rolled back)");
  });
});

await check("B1.3i (spec Requirement 7): a failing nested child write rolls back the parent", async () => {
  await withDatabase(async (db) => {
    const { exec, transaction } = createPgliteDb(db);
    await seed(db);
    const client = new IndigoClientBase({ db: { exec, transaction } });
    const { User, Post } = buildTopLevelRegistry(client);
    let threw = false;
    try {
      await User.create({
        data: {
          name: "A",
          email: "a@x.com",
          posts: { create: [{ title: "ok" }, { title: null }] },
        },
      });
    } catch {
      threw = true;
    }
    assert(threw, "expected the call to reject (NOT NULL violation on the second post)");
    const users = await User.findMany({});
    const posts = await Post.findMany({});
    assert(users.length === 0, "expected NO user row to persist after rollback");
    assert(posts.length === 0, "expected NO post row to persist after rollback (not even the first, valid one)");
  });
});

await check("B1.3j: 1-1 to-one create nested under a non-fkSide relation (User.profile)", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Profile } = buildDelegates(exec);
    const user = await User.create({
      data: { name: "A", email: "a@x.com", profile: { create: { bio: "hi" } } },
    });
    const profiles = await Profile.findMany({ where: { userId: user.id } });
    assert(profiles.length === 1, "expected exactly one profile to be created and linked");
    assert(profiles[0].bio === "hi", "expected the profile's bio to match");
  });
});

// ─── B1.4: nested create inside an active $transaction joins the session ──

await check("B1.4: create() with relation ops issued via tx.<model>.create inside $transaction joins that session — no double-open", async () => {
  await withDatabase(async (db) => {
    const { exec, transaction } = createPgliteDb(db);
    // Multi-statement DDL needs PGlite's own `db.exec` (not the
    // single-statement `Executor` seam `exec`/`db.query` — same split
    // `relations.mjs`'s `seed()` uses).
    await db.exec(`
      CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE "Post" (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        author_id INT NOT NULL REFERENCES "User"(id)
      );
    `);
    const client = new IndigoClientBase({ db: { exec, transaction } });

    // Mirrors the generated constructor's top-level wiring.
    const topLevelRunAtomic = (fn) =>
      client.$transaction((txExec) => {
        const registry = buildDelegates(txExec);
        return fn(registry);
      });

    const outerRegistry = buildDelegates(client.exec, topLevelRunAtomic);

    const result = await outerRegistry.User.create({
      data: { name: "A", email: "a@x.com", posts: { create: [{ title: "nested" }] } },
    });

    assert(typeof result.id === "number", "expected the top-level nested create to resolve with the user row");
    const outsideUsers = new ModelDelegate(userMeta, client.exec);
    const afterCommit = await outsideUsers.findMany({});
    assert(afterCommit.length === 1, "expected the write to be visible after the transaction resolves");
  });
});

await check(
  "B1.4b: a failure inside fn still rolls back everything including the nested writes (client-transactions spec)",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await db.exec(`
        CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
        CREATE TABLE "Post" (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          author_id INT NOT NULL REFERENCES "User"(id)
        );
      `);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      let threw = false;
      try {
        await client.$transaction(async (txExec) => {
          const registry = buildDelegates(txExec);
          await registry.User.create({
            data: { name: "A", email: "a@x.com", posts: { create: [{ title: "nested" }] } },
          });
          throw new Error("boom — fail after the nested write");
        });
      } catch (err) {
        threw = true;
        assert(err.message === "boom — fail after the nested write", "expected the original rejection reason to propagate");
      }
      assert(threw, "expected $transaction to reject");

      const outsideUsers = new ModelDelegate(userMeta, client.exec);
      const afterRollback = await outsideUsers.findMany({});
      assert(afterRollback.length === 0, "expected NO user row to persist — the nested write must roll back too");
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client nested-writes-create: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client nested-writes-create: all checks passed");
}
