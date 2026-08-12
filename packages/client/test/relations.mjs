/**
 * @indigodb/client — `include`/`select` relation loading regression suite.
 *
 * Plain Node, PGlite-backed, matching `client.mjs`'s style. Exercises
 * `ModelDelegate`'s batched `loadRelations` (design.md Data Flow) end to
 * end: 1-N/N-1/1-1 stitching, empty/null cardinality, round-trip counts,
 * join-key stripping on both sides, composite-key runtime rejection,
 * `RealtimeModelDelegate`'s dispatch staying flat, and no-`include`
 * backward compatibility (tasks.md Phases 3-6).
 */

import { ModelDelegate, IndigoRelationError } from "../dist/delegate.js";
import { RealtimeModelDelegate } from "../dist/realtime-delegate.js";
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

// ─── Fixture: User 1-N Post, Post N-1 User (author, editor nullable), User 1-1 Profile ──

const userMeta = {
  table: "User",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
    email: { db: "email" },
  },
  relations: {
    posts: { target: "Post", from: "id", to: "authorId", list: true },
    profile: { target: "Profile", from: "id", to: "userId", list: false },
  },
};

const postMeta = {
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    authorId: { db: "author_id" },
    editorId: { db: "editor_id" },
  },
  relations: {
    author: { target: "User", from: "authorId", to: "id", list: false },
    editor: { target: "User", from: "editorId", to: "id", list: false },
  },
};

const profileMeta = {
  table: "Profile",
  fields: {
    id: { db: "id", pk: true },
    bio: { db: "bio" },
    userId: { db: "user_id" },
  },
  relations: {
    user: { target: "User", from: "userId", to: "id", list: false },
  },
};

/** Composite-key marker, as emitted by the generator for a rejected relation. */
const orderMeta = {
  table: "Order",
  fields: {
    id: { db: "id", pk: true },
    a: { db: "a" },
    b: { db: "b" },
  },
  relations: {
    lineItems: { target: "LineItem", composite: true },
  },
};

/** Counting executor: wraps a PGlite executor and records every statement. */
function countingExecutor(db) {
  const base = createPgliteExecutor(db);
  const calls = [];
  return {
    calls,
    exec: async (sql, params) => {
      calls.push({ sql, params });
      return base(sql, params);
    },
  };
}

/** DDL setup uses PGlite's own multi-statement `db.exec`, not the
 * single-statement `Executor` seam (`db.query`) — same split as
 * `client.mjs`'s CRUD smoke test. */
async function seed(db) {
  await db.exec(`
    CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE "Post" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INT NOT NULL,
      editor_id INT
    );
    CREATE TABLE "Profile" (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INT NOT NULL);
  `);
}

/** Builds the three delegates wired to each other via a sibling registry,
 * exactly as `__delegates` does in the generated client. */
function buildDelegates(exec) {
  const registry = {};
  const siblings = () => registry;
  registry.User = new ModelDelegate(userMeta, exec, siblings);
  registry.Post = new ModelDelegate(postMeta, exec, siblings);
  registry.Profile = new ModelDelegate(profileMeta, exec, siblings);
  return registry;
}

console.log("@indigodb/client: relation loading (include/select)");

// ─── Phase 3: batched loadRelations + stitch ──────────────────────────────

await check("3.1: 1-N include returns array of full child rows", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Post.create({ data: { title: "P1", authorId: ada.id } });
    await Post.create({ data: { title: "P2", authorId: ada.id } });

    const [user] = await User.findMany({ where: { id: ada.id }, include: { posts: true } });
    assert(Array.isArray(user.posts), "expected posts to be an array");
    assert(user.posts.length === 2, "expected 2 posts");
    assert(user.posts.every((p) => typeof p.title === "string"), "expected full child rows");
  });
});

await check("3.2: N-1 include with nullable FK resolves null to null", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    const post = await Post.create({ data: { title: "P1", authorId: ada.id } });

    const [row] = await Post.findMany({ where: { id: post.id }, include: { editor: true } });
    assert(row.editor === null, "expected editor to be null when editorId is null");
  });
});

await check("3.3: 1-1 include resolves to a single object, not an array", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Profile } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Profile.create({ data: { bio: "hi", userId: ada.id } });

    const [user] = await User.findMany({ where: { id: ada.id }, include: { profile: true } });
    assert(!Array.isArray(user.profile), "expected profile to not be an array");
    assert(user.profile.bio === "hi", "expected profile bio to match");
  });
});

await check("3.4: empty to-many relation resolves to [], never undefined/missing", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });

    const [user] = await User.findMany({ where: { id: ada.id }, include: { posts: true } });
    assert("posts" in user, "expected posts key to be present");
    assert(Array.isArray(user.posts), "expected posts to be an array");
    assert(user.posts.length === 0, "expected posts to be empty");
  });
});

await check(
  "3.5: many parents sharing one FK each get correctly matched objects, 1 batched query",
  async () => {
    await withDatabase(async (db) => {
      const counting = countingExecutor(db);
      await seed(db);
      const { User, Post } = buildDelegates(counting.exec);
      const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
      const bob = await User.create({ data: { name: "Bob", email: "bob@x.com" } });
      const p1 = await Post.create({ data: { title: "P1", authorId: ada.id } });
      const p2 = await Post.create({ data: { title: "P2", authorId: bob.id } });

      counting.calls.length = 0;
      const posts = await Post.findMany({
        where: { id: { in: [p1.id, p2.id] } },
        include: { author: true },
      });
      const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
      assert(byId[p1.id].author.name === "Ada", "expected p1's author to be Ada");
      assert(byId[p2.id].author.name === "Bob", "expected p2's author to be Bob");
      assert(counting.calls.length === 2, `expected 2 total queries (1 parent + 1 batched), got ${counting.calls.length}`);
    });
  },
);

await check("3.6: nested select inside include narrows child rows to exactly the selected scalars", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Post.create({ data: { title: "P1", authorId: ada.id } });

    const [user] = await User.findMany({
      where: { id: ada.id },
      include: { posts: { select: { title: true } } },
    });
    const keys = Object.keys(user.posts[0]).sort();
    assert(keys.length === 1 && keys[0] === "title", `expected only [title], got [${keys.join(", ")}]`);
  });
});

await check("3.7: round-trip count = 1 + distinct included relations", async () => {
  await withDatabase(async (db) => {
    const counting = countingExecutor(db);
    await seed(db);
    const { User } = buildDelegates(counting.exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });

    counting.calls.length = 0;
    await User.findMany({ where: { id: ada.id }, include: { posts: true, profile: true } });
    assert(counting.calls.length === 3, `expected 3 total queries (1 + 2 relations), got ${counting.calls.length}`);
  });
});

await check("3.8: take/skip on the parent query stay correct when include is present", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    for (let i = 0; i < 5; i++) {
      const u = await User.create({ data: { name: `U${i}`, email: `u${i}@x.com` } });
      await Post.create({ data: { title: `P${i}`, authorId: u.id } });
    }

    const page = await User.findMany({
      orderBy: { id: "asc" },
      take: 2,
      skip: 1,
      include: { posts: true },
    });
    assert(page.length === 2, `expected 2 rows, got ${page.length}`);
    assert(page[0].name === "U1", `expected pagination to skip U0, got ${page[0].name}`);
    assert(page[0].posts.length === 1, "expected each page row to still have its own posts");
  });
});

await check("3.9: no include/select -> byte-identical SQL and flat rows vs pre-change baseline", async () => {
  await withDatabase(async (db) => {
    const counting = countingExecutor(db);
    await seed(db);
    const { User } = buildDelegates(counting.exec);
    await User.create({ data: { name: "Ada", email: "ada@x.com" } });

    counting.calls.length = 0;
    const rows = await User.findMany();
    assert(counting.calls.length === 1, "expected exactly one query with no include");
    assert(
      counting.calls[0].sql === 'SELECT "id" AS "id", "name" AS "name", "email" AS "email" FROM "User"',
      `unexpected SQL: ${counting.calls[0].sql}`,
    );
    assert(!("posts" in rows[0]), "expected no relation keys on a plain findMany row");
  });
});

// ─── Phase 4: join-key stripping ───────────────────────────────────────────

await check("4.1: parent select omitting the fk/pk key still stitches, and key is stripped", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Post.create({ data: { title: "P1", authorId: ada.id } });

    const [user] = await User.findMany({
      where: { id: ada.id },
      select: { name: true },
      include: { posts: true },
    });
    assert(user.posts.length === 1, "expected posts to stitch correctly");
    assert(!("id" in user), "expected the forced parent key (id) to be stripped from the final row");
    assert(user.name === "Ada", "expected the explicitly selected field to remain");
  });
});

await check("4.2: child select omitting the ref column still stitches, and key is stripped", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Post.create({ data: { title: "P1", authorId: ada.id } });

    const [user] = await User.findMany({
      where: { id: ada.id },
      include: { posts: { select: { title: true } } },
    });
    assert(user.posts.length === 1, "expected posts to stitch correctly");
    assert(!("authorId" in user.posts[0]), "expected the forced child key (authorId) to be stripped");
    assert(user.posts[0].title === "P1", "expected the explicitly selected child field to remain");
  });
});

await check("4.x: explicitly selected parent key is kept, not stripped", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { User, Post } = buildDelegates(exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });
    await Post.create({ data: { title: "P1", authorId: ada.id } });

    const [user] = await User.findMany({
      where: { id: ada.id },
      select: { id: true, name: true },
      include: { posts: true },
    });
    assert("id" in user, "expected explicitly-selected id to remain");
    assert(user.id === ada.id, "expected id to have the right value");
  });
});

// ─── Phase 5: composite-key runtime rejection ─────────────────────────────

await check("5.1: include on a composite-key relation throws before any batched query", async () => {
  await withDatabase(async (db) => {
    const counting = countingExecutor(db);
    await counting.exec(
      `CREATE TABLE "Order" (id SERIAL PRIMARY KEY, a INT NOT NULL, b INT NOT NULL);`,
      [],
    );
    const registry = {};
    const siblings = () => registry;
    registry.Order = new ModelDelegate(orderMeta, counting.exec, siblings);
    await registry.Order.create({ data: { a: 1, b: 2 } });

    counting.calls.length = 0;
    let threw = false;
    try {
      await registry.Order.findMany({ include: { lineItems: true } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoRelationError, "expected an IndigoRelationError");
      assert(/composite|more than one column/.test(err.message), `unexpected message: ${err.message}`);
    }
    assert(threw, "expected findMany to throw for a composite-key include");
    assert(counting.calls.length === 1, "expected only the parent query, no batched follow-up");
  });
});

// ─── Phase 6: realtime regression ──────────────────────────────────────────

await check("6.1: RealtimeModelDelegate.dispatch's partial refetch passes no include and stays flat", async () => {
  await withDatabase(async (db) => {
    const counting = countingExecutor(db);
    await seed(db);
    const { User } = buildDelegates(counting.exec);
    const ada = await User.create({ data: { name: "Ada", email: "ada@x.com" } });

    let fakeManager = { subscribe: () => () => {} };
    const realtimeUser = new RealtimeModelDelegate(
      userMeta,
      counting.exec,
      () => fakeManager,
      "User",
      () => ({ User: realtimeUser }),
    );

    counting.calls.length = 0;
    let received;
    // White-box: call the private `dispatch` indirectly is not exposed, so
    // exercise it through `subscribe`'s wired `onEvent` callback shape by
    // reaching into the same code path `subscribe()` uses.
    const handlers = {
      onUpdate: (e) => {
        received = e;
      },
    };
    // `dispatch` is private; simulate exactly what `subscribe`'s onEvent
    // forwards to it for a partial UPDATE event.
    await realtimeUser["dispatch"](
      { op: "UPDATE", table: "User", pk: { id: ada.id }, partial: true, ts: "now" },
      handlers,
    );

    assert(counting.calls.length === 1, "expected exactly one refetch query, no batched include query");
    assert(received !== undefined, "expected onUpdate to fire");
    assert(!("posts" in received.new), "expected the refetched row to stay flat (no relation keys)");
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client relations: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client relations: all checks passed");
}
