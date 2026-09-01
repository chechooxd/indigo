/**
 * @indigodb/client — unique write selector (`update`/`delete`, PR 2).
 *
 * `client-unique-write-selector` spec: `ModelDelegate.update`/`.delete`
 * MUST reject a `where` that does not exactly match a declared
 * unique-constraint group, via `assertUniqueWhere` — a runtime guard for
 * `as any` bypasses of the compile-time `UniqueWhere` narrowing (design.md
 * Decision D4/D5), modelled on `upsert`'s `resolveUpsertConflictTarget` but
 * kept a separate sibling function, not a reuse.
 *
 *  - UWS-5: a non-unique `where` throws `IndigoArgumentError` code
 *    `NO_MATCHING_UNIQUE_CONSTRAINT` before any SQL is issued. Sub-cases:
 *    non-unique field, operator-object field, partial composite key.
 *  - UWS-6: a valid unique `where` is accepted and proceeds.
 *  - UWS-7 (design.md Decision D7): a *declared-but-unenforced* unique
 *    group — the hand-authored meta declares `uniqueGroups: [["name"]]`
 *    while the PGlite DDL creates NO unique constraint on `name`. This is
 *    deliberate, not a fixture bug: it is the real production case the
 *    guard exists for — a constraint dropped in the database while the
 *    generated meta still declares it (schema drift). `assertUniqueWhere`
 *    only checks the WHERE's key SHAPE, not whether the database actually
 *    enforces uniqueness, so a `where` matching this declared group still
 *    passes the guard; `updateImpl`'s existing `findMany` ambiguity check
 *    (unaffected by this change) is what catches the two rows that
 *    actually share it, and throws `AMBIGUOUS_UPDATE_TARGET`.
 *  - UWS-3/UWS-4 (runtime halves): `findUnique` and `updateMany`/
 *    `deleteMany` are unaffected by the new guard (non-regressions) — they
 *    never call `assertUniqueWhere`.
 *  - D4: a delegate whose meta declares no `uniqueGroups` is unguarded —
 *    the guard is opt-in, not unconditional.
 *  - D6c/D6d: guard ordering relative to PR 1's `RECORD_NOT_FOUND` and
 *    `EMPTY_UPDATE_DATA` guards.
 */

import { ModelDelegate, IndigoArgumentError, IndigoNestedWriteError, IndigoNotFoundError } from "../dist/delegate.js";
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

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

// ─── UWS-5/UWS-6/D4/D6c/D6d/UWS-3/UWS-4 fixture ────────────────────────────

const userMeta = {
  name: "User",
  table: "User",
  fields: {
    id: { db: "id", pk: true },
    email: { db: "email" },
    name: { db: "name" },
  },
  uniqueGroups: [["id"], ["email"]],
};

const membershipMeta = {
  name: "Membership",
  table: "Membership",
  fields: {
    id: { db: "id", pk: true },
    userId: { db: "userId" },
    orgId: { db: "orgId" },
    role: { db: "role" },
  },
  uniqueGroups: [["id"], ["userId", "orgId"]],
};

async function seedUser(db) {
  await db.exec(`
    CREATE TABLE "User" (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);
  `);
}

// ─── UWS-7 (D7) fixture: declared-but-unenforced unique group ─────────────

const dupAuthorMeta = {
  name: "Author",
  table: "Author",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
  },
  relations: {
    books: { target: "Book", from: "id", to: "authorId", list: true, fkSide: false, optional: false, optionalFk: true },
  },
  // Declared, but the DDL below deliberately creates NO unique constraint
  // on "name" — see the file-header note on D7 / UWS-7.
  uniqueGroups: [["name"]],
};

const dupBookMeta = {
  name: "Book",
  table: "Book",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    authorId: { db: "author_id" },
  },
  relations: {
    author: { target: "Author", from: "authorId", to: "id", list: false, fkSide: true, optional: true, optionalFk: true },
  },
};

async function seedDup(db) {
  await db.exec(`
    CREATE TABLE "Author" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "Book" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INT REFERENCES "Author"(id)
    );
  `);
}

function buildDupDelegates(exec) {
  const registry = {};
  const siblings = () => registry;
  registry.Author = new ModelDelegate(dupAuthorMeta, exec, siblings);
  registry.Book = new ModelDelegate(dupBookMeta, exec, siblings);
  return registry;
}

console.log("@indigodb/client: unique write selector");

// ─── UWS-5: non-unique where throws NO_MATCHING_UNIQUE_CONSTRAINT ─────────

await check(
  "UWS-5a: a non-unique-looking where (name) throws NO_MATCHING_UNIQUE_CONSTRAINT before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.update({ where: { name: "A" }, data: { name: "B" } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected update() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

await check(
  "UWS-5b: an operator-object where (id: { gt: 1 }) throws the same code, before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.delete({ where: { id: { gt: 1 } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected delete() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

await check(
  "UWS-5c: a partial composite-key where (userId only, missing orgId) throws the same code",
  async () => {
    const { exec, calls } = stubExecutor();
    const Membership = new ModelDelegate(membershipMeta, exec);
    let threw = false;
    try {
      await Membership.update({ where: { userId: 1 }, data: { role: "admin" } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected update() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── UWS-6: a valid unique where is accepted and proceeds ─────────────────

await check("UWS-6: a valid unique where (as any bypass) proceeds and returns the deleted row", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);
    const created = await User.create({ data: { email: "a@x.com", name: "Ada" } });

    const deleted = await User.delete({ where: { email: created.email } });
    assert(deleted.email === "a@x.com", "expected the guard to accept the valid unique where and delete the row");
  });
});

// ─── UWS-7 (D7): declared-but-unenforced unique group ─────────────────────

await check(
  "UWS-7: a unique-shape-valid where that still matches multiple rows (D7: declared-but-unenforced group) passes assertUniqueWhere, then throws AMBIGUOUS_UPDATE_TARGET",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seedDup(db);
      const { Author, Book } = buildDupDelegates(exec);
      await Author.create({ data: { name: "Dup" } });
      await Author.create({ data: { name: "Dup" } });
      const book = await Book.create({ data: { title: "B1" } });

      let threw = false;
      try {
        await Author.update({ where: { name: "Dup" }, data: { books: { connect: [{ id: book.id }] } } });
      } catch (err) {
        threw = true;
        assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError (not IndigoArgumentError — assertUniqueWhere already passed)");
        assert(err.code === "AMBIGUOUS_UPDATE_TARGET", `expected code AMBIGUOUS_UPDATE_TARGET, got ${err.code}`);
      }
      assert(threw, "expected update() to reject — the where's shape matches the declared group, but two rows actually share it");
      const after = await Book.findMany({ where: { id: book.id } });
      assert(after[0].authorId === null, "expected NO connect to have happened");
    });
  },
);

// ─── UWS-3 (runtime half): findUnique unaffected ───────────────────────────

await check("UWS-3: findUnique still resolves the row or null, unaffected by the unique-selector guard", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);
    await User.create({ data: { email: "a@x.com", name: "Ada" } });

    const found = await User.findUnique({ where: { name: "Ada" } });
    assert(found && found.name === "Ada", "expected the matching row");

    const notFound = await User.findUnique({ where: { name: "Nope" } });
    assert(notFound === null, "expected null for no match");
  });
});

// ─── UWS-4 (runtime half): updateMany/deleteMany unaffected ───────────────

await check(
  "UWS-4: updateMany/deleteMany with a multi-row, non-unique where still update/delete every match",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seedUser(db);
      const User = new ModelDelegate(userMeta, exec);
      await User.create({ data: { email: "a@x.com", name: "Dup" } });
      await User.create({ data: { email: "b@x.com", name: "Dup" } });

      const updated = await User.updateMany({ where: { name: "Dup" }, data: { name: "Changed" } });
      assert(updated.count === 2, `expected count 2, got ${updated.count}`);

      const deleted = await User.deleteMany({ where: { name: "Changed" } });
      assert(deleted.count === 2, `expected count 2, got ${deleted.count}`);
    });
  },
);

// ─── D4: guard is opt-in — a meta with no uniqueGroups is unguarded ───────

await check(
  "D4: a delegate whose meta declares no uniqueGroups issues SQL unconditionally — the guard is opt-in",
  async () => {
    const { exec, calls } = stubExecutor([{ id: 1, name: "y" }]);
    const noGroupsMeta = {
      name: "User",
      table: "user",
      fields: { id: { db: "id", pk: true }, name: { db: "name" } },
    };
    const NoGroupsUser = new ModelDelegate(noGroupsMeta, exec);
    const result = await NoGroupsUser.update({ where: { name: "x" }, data: { name: "y" } });
    assert(calls.length === 1, "expected SQL to be issued unconditionally — no uniqueGroups means no guard");
    assert(result.name === "y", "sanity: the stubbed row is returned");
  },
);

// ─── D6c: unique where × zero rows — RECORD_NOT_FOUND after the guard ─────

await check(
  "D6c: a unique where matching zero rows passes assertUniqueWhere, then throws RECORD_NOT_FOUND",
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
        assert(err instanceof IndigoNotFoundError, "expected an IndigoNotFoundError, not IndigoArgumentError");
        assert(err.code === "RECORD_NOT_FOUND", `expected code RECORD_NOT_FOUND, got ${err.code}`);
      }
      assert(threw, "expected update() to reject");
    });
  },
);

// ─── D6d: unique where × all-undefined data — EMPTY_UPDATE_DATA still reached ─

await check(
  "D6d: a unique where with all-undefined data still reaches EMPTY_UPDATE_DATA through the new signature",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.update({ where: { id: 1 }, data: { name: undefined } });
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
  console.error(`\n@indigodb/client unique-write-selector: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client unique-write-selector: all checks passed");
}
