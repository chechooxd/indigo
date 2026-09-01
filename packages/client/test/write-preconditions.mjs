/**
 * @indigodb/client — write preconditions (`update`/`delete`).
 *
 * `client-write-preconditions` spec: `ModelDelegate.update`/`.delete` MUST
 * validate two preconditions before issuing SQL and MUST NOT lie about the
 * outcome of a zero-row write.
 *
 *  - WP-1/WP-3/D6a: empty-`SET` guard on the direct scalar `rawUpdate` path
 *    (`IndigoArgumentError` code `EMPTY_UPDATE_DATA`, pre-SQL).
 *  - WP-2: the pre-existing relation-ops-only empty-scalar guard is
 *    unaffected by the new direct-path guard (regression).
 *  - WP-4/WP-5/WP-7/D6b: zero-row `update`/`delete` on the direct scalar
 *    path throws `IndigoNotFoundError` code `RECORD_NOT_FOUND`; a matching
 *    write still resolves with the row; a multi-row match with no relation
 *    ops still updates every match (D6b is a non-narrowing guard).
 *
 * WP-6/NW-4 (the relation-ops-only branch's not-found throw) is covered by
 * `nested-writes-update.mjs` C1.4c, rewritten as part of this same change —
 * not duplicated here (design.md Testing Strategy).
 */

import { IndigoArgumentError } from "../dist/delegate.js";
import { ModelDelegate, IndigoNotFoundError } from "../dist/delegate.js";
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

const userMeta = {
  name: "User",
  table: "user",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
    email: { db: "email" },
  },
};

const postMeta = {
  name: "Post",
  table: "post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    authorId: { db: "author_id" },
  },
  relations: {
    author: { target: "Author", from: "authorId", to: "id", list: false, fkSide: true, optional: true, optionalFk: true },
  },
};

const authorMeta = {
  name: "Author",
  table: "author",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
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

async function seedUser(db) {
  await db.exec(`CREATE TABLE "user" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT);`);
}

async function seedPostAuthor(db) {
  await db.exec(`
    CREATE TABLE "author" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "post" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INT REFERENCES "author"(id)
    );
  `);
}

function buildDelegates(exec) {
  const registry = {};
  const siblings = () => registry;
  registry.Author = new ModelDelegate(authorMeta, exec, siblings);
  registry.Post = new ModelDelegate(postMeta, exec, siblings);
  return registry;
}

console.log("@indigodb/client: write preconditions");

// ─── WP-1: all-undefined data, no relation ops, throws pre-SQL ────────────

await check(
  "WP-1: all-undefined data with no relation ops throws IndigoArgumentError code EMPTY_UPDATE_DATA before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.update({ where: { id: 1 }, data: { name: undefined, email: undefined } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "EMPTY_UPDATE_DATA", `expected code EMPTY_UPDATE_DATA, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── WP-2: relation-ops-only empty-scalar guard remains in force ──────────

await check(
  "WP-2: relation-ops-only data (no scalars) still applies the connect and issues no empty-SET UPDATE",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seedPostAuthor(db);
      const { Author, Post } = buildDelegates(exec);
      const author = await Author.create({ data: { name: "Ada" } });
      const post = await Post.create({ data: { title: "P1" } });

      const calls = [];
      const recordingExec = async (sql, params) => {
        calls.push({ sql, params });
        return exec(sql, params);
      };
      const registry = { Author: new ModelDelegate(authorMeta, recordingExec, () => registry), Post: new ModelDelegate(postMeta, recordingExec, () => registry) };

      const updated = await registry.Post.update({ where: { id: post.id }, data: { author: { connect: { id: author.id } } } });
      assert(updated.authorId === author.id, "expected the post to be connected to the author");
      const emptySet = calls.some((c) => /UPDATE\s+"post"\s+SET\s+WHERE/i.test(c.sql));
      assert(!emptySet, `expected no empty-SET UPDATE to be issued, got: ${JSON.stringify(calls.map((c) => c.sql))}`);
    });
  },
);

// ─── WP-3: a single defined scalar assignment is accepted ─────────────────

await check(
  "WP-3: a single defined scalar assignment is accepted and emits the expected UPDATE SET shape",
  async () => {
    const { exec, calls } = stubExecutor([{ id: 1, name: "New", email: null }]);
    const User = new ModelDelegate(userMeta, exec);
    await User.update({ where: { id: 1 }, data: { name: "New", email: undefined } });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      /^UPDATE "user" SET "name" = \$1 WHERE/.test(calls[0].sql),
      `unexpected SQL: ${calls[0].sql}`,
    );
  },
);

// ─── WP-4/D6b: zero-row / multi-row direct scalar update ──────────────────

await check(
  "WP-4: zero-row update on the direct scalar path throws IndigoNotFoundError code RECORD_NOT_FOUND",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seedUser(db);
      const User = new ModelDelegate(userMeta, exec);
      let threw = false;
      try {
        await User.update({ where: { id: 999 }, data: { name: "New" } });
      } catch (err) {
        threw = true;
        assert(err instanceof IndigoNotFoundError, "expected an IndigoNotFoundError");
        assert(err.code === "RECORD_NOT_FOUND", `expected code RECORD_NOT_FOUND, got ${err.code}`);
      }
      assert(threw, "expected update() to reject");
    });
  },
);

await check("D6b: multi-row where + scalar-only data still updates every match, no throw", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);
    await User.create({ data: { name: "Dup" } });
    await User.create({ data: { name: "Dup" } });

    const result = await User.update({ where: { name: "Dup" }, data: { email: "shared@x.com" } });
    assert(result.email === "shared@x.com", "expected the (first) updated row to be returned");
    const rows = await User.findMany({ where: { name: "Dup" } });
    assert(rows.length === 2, "expected both rows to still exist");
    assert(
      rows.every((r) => r.email === "shared@x.com"),
      "expected BOTH rows to be updated, no RECORD_NOT_FOUND/AMBIGUOUS_UPDATE_TARGET narrowing",
    );
  });
});

// ─── WP-5: zero-row delete throws ──────────────────────────────────────────

await check("WP-5: zero-row delete throws IndigoNotFoundError code RECORD_NOT_FOUND", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.delete({ where: { id: 999 } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNotFoundError, "expected an IndigoNotFoundError");
      assert(err.code === "RECORD_NOT_FOUND", `expected code RECORD_NOT_FOUND, got ${err.code}`);
    }
    assert(threw, "expected delete() to reject");
  });
});

// ─── WP-7: a matching update resolves with the updated row ────────────────

await check("WP-7: a matching update resolves with the updated row, does not throw", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);
    const created = await User.create({ data: { name: "Ada" } });
    const updated = await User.update({ where: { id: created.id }, data: { name: "New" } });
    assert(updated.name === "New", `expected updated row, got ${JSON.stringify(updated)}`);
  });
});

// ─── D6a: zero-row where × all-undefined data — EMPTY_UPDATE_DATA wins ────

await check(
  "D6a: zero-row where with all-undefined data throws EMPTY_UPDATE_DATA before any SQL is issued (not RECORD_NOT_FOUND)",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.update({ where: { id: 999 }, data: { name: undefined } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(err.code === "EMPTY_UPDATE_DATA", `expected code EMPTY_UPDATE_DATA, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client write-preconditions: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client write-preconditions: all checks passed");
}
