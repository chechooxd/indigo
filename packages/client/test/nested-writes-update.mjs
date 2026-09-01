/**
 * @indigodb/client — nested-write UPDATE planner (PR C, nested-writes).
 *
 * PR C (tasks.md C1.1-C3.1) — `ModelDelegate.update` gains the same planner
 * shape as `create()` (nested-writes-create.mjs), plus two update-only
 * behaviors:
 *  - `disconnect`/`set` on relations (spec Requirement 3/4): to-many reuses
 *    the existing unbounded `update()` (FK = NULL, gated by `optionalFk`);
 *    a required relation (fkSide OR non-fkSide) throws
 *    `REQUIRED_RELATION_DISCONNECT` instead of orphaning/cascading.
 *  - `AMBIGUOUS_UPDATE_TARGET` (design.md Data Flow): relation ops require
 *    `where` to resolve to a single row — more than one match rejects,
 *    including when `data` is relation-ops-only (no scalars).
 *
 * Fixture: Publisher 1-N Book (books.publisherId NOT NULL — REQUIRED to-many
 * FK), Author 1-N Book (books.authorId NULLABLE — OPTIONAL to-many FK, and
 * Book.author is the matching OPTIONAL to-one/fkSide relation).
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate, IndigoNestedWriteError, IndigoNotFoundError } from "../dist/delegate.js";
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

// ─── Fixture ────────────────────────────────────────────────────────────────

const authorMeta = {
  name: "Author",
  table: "Author",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
  },
  relations: {
    books: { target: "Book", from: "id", to: "authorId", list: true, fkSide: false, optional: false, optionalFk: true },
    profile: {
      target: "Profile",
      from: "id",
      to: "authorId",
      list: false,
      fkSide: false,
      optional: true,
      optionalFk: true,
    },
  },
};

// 1-1 inverse relation (non-fkSide, optional) — reaches applyNonFkSideOp's
// single-value disconnect/set branch, which C1.x's to-many fixtures cannot:
// Author.books is list:true (the array branch), and Book.author/.publisher
// are fkSide:true (folded into the parent's own scalars, never call
// target.update at all).
const profileMeta = {
  name: "Profile",
  table: "Profile",
  fields: {
    id: { db: "id", pk: true },
    bio: { db: "bio" },
    authorId: { db: "author_id" },
  },
};

const publisherMeta = {
  name: "Publisher",
  table: "Publisher",
  fields: {
    id: { db: "id", pk: true },
    name: { db: "name" },
  },
  relations: {
    books: {
      target: "Book",
      from: "id",
      to: "publisherId",
      list: true,
      fkSide: false,
      optional: false,
      optionalFk: false,
    },
  },
};

const bookMeta = {
  name: "Book",
  table: "Book",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
    authorId: { db: "author_id" },
    publisherId: { db: "publisher_id" },
  },
  relations: {
    author: { target: "Author", from: "authorId", to: "id", list: false, fkSide: true, optional: true, optionalFk: true },
    publisher: {
      target: "Publisher",
      from: "publisherId",
      to: "id",
      list: false,
      fkSide: true,
      optional: false,
      optionalFk: false,
    },
  },
};

async function seed(db) {
  await db.exec(`
    CREATE TABLE "Author" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "Publisher" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "Book" (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INT REFERENCES "Author"(id),
      publisher_id INT NOT NULL REFERENCES "Publisher"(id)
    );
    CREATE TABLE "Profile" (id SERIAL PRIMARY KEY, bio TEXT, author_id INT REFERENCES "Author"(id));
  `);
}

function buildDelegates(exec, runAtomic) {
  const registry = {};
  const siblings = () => registry;
  registry.Author = new ModelDelegate(authorMeta, exec, siblings, runAtomic);
  registry.Publisher = new ModelDelegate(publisherMeta, exec, siblings, runAtomic);
  registry.Book = new ModelDelegate(bookMeta, exec, siblings, runAtomic);
  registry.Profile = new ModelDelegate(profileMeta, exec, siblings, runAtomic);
  return registry;
}

function buildTopLevelRegistry(client) {
  const topLevelRunAtomic = (fn) => client.$transaction((txExec) => fn(buildDelegates(txExec)));
  return buildDelegates(client.exec, topLevelRunAtomic);
}

console.log("@indigodb/client: nested-write update planner");

// ─── C1.1: disconnect/set on to-many via update (FK=NULL, requires optionalFk) ─

await check("C1.1a: disconnect on an OPTIONAL to-many sets the matched child's FK to NULL", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const author = await Author.create({ data: { name: "Ada" } });
    const book = await Book.create({ data: { title: "B1", authorId: author.id, publisherId: publisher.id } });

    await Author.update({ where: { id: author.id }, data: { books: { disconnect: [{ id: book.id }] } } });

    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].authorId === null, "expected the book's authorId to be cleared to NULL");
  });
});

await check("C1.1b: disconnect on a REQUIRED to-many (publisherId NOT NULL) throws REQUIRED_RELATION_DISCONNECT", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Publisher.update({ where: { id: publisher.id }, data: { books: { disconnect: [{ id: book.id }] } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
      assert(err.code === "REQUIRED_RELATION_DISCONNECT", `expected code REQUIRED_RELATION_DISCONNECT, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].publisherId === publisher.id, "expected the book's publisherId to be UNCHANGED");
  });
});

// ─── C1.1c-e: disconnect/set matching NOTHING is a no-op, not a throw ──────
// Regression coverage for the verify finding: applyNonFkSideOp's
// disconnect/set handling reuses target.update() to clear an FK, which now
// throws IndigoNotFoundError on a zero-row match (this PR's own guard).
// C1.3a (below) always seeds two pre-linked books before calling `set: []`,
// so it never exercises the zero-currently-linked branch — the same blind
// spot C1.4c had before its rewrite. These seed an EMPTY relation instead.

await check("C1.1c: set: [] on an author with ZERO currently-linked books is a no-op, does not throw", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author } = buildDelegates(exec);
    const author = await Author.create({ data: { name: "Ada" } });

    // No book was ever created/linked — Author.books is empty.
    const result = await Author.update({ where: { id: author.id }, data: { books: { set: [] } } });
    assert(result.id === author.id, "expected update() to resolve with the author row, not throw");
  });
});

await check(
  "C1.1d: disconnect naming a book id that does not exist at all is a no-op, does not throw",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seed(db);
      const { Author } = buildDelegates(exec);
      const author = await Author.create({ data: { name: "Ada" } });

      // No Book row with id 999999 exists anywhere — `where: { id }` on the
      // per-item disconnect loop matches zero rows (distinct from C1.1c's
      // "author has zero linked books" — this is "the named row is not
      // there at all").
      const result = await Author.update({
        where: { id: author.id },
        data: { books: { disconnect: [{ id: 999999 }] } },
      });
      assert(result.id === author.id, "expected update() to resolve with the author row, not throw");
    });
  },
);

await check(
  "C1.2d: disconnect on an OPTIONAL to-one non-fkSide relation (Author.profile) with nothing linked is a no-op",
  async () => {
    await withDatabase(async (db) => {
      const exec = createPgliteExecutor(db);
      await seed(db);
      const { Author } = buildDelegates(exec);
      const author = await Author.create({ data: { name: "Ada" } });

      // No Profile row was ever created for this author.
      const result = await Author.update({ where: { id: author.id }, data: { profile: { disconnect: true } } });
      assert(result.id === author.id, "expected update() to resolve with the author row, not throw");
    });
  },
);

// ─── C1.2: required to-one disconnect/set throws REQUIRED_RELATION_DISCONNECT ──

await check("C1.2a: disconnect on a REQUIRED to-one (fkSide, Book.publisher) throws", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Book.update({ where: { id: book.id }, data: { publisher: { disconnect: true } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
      assert(err.code === "REQUIRED_RELATION_DISCONNECT", `expected code REQUIRED_RELATION_DISCONNECT, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].publisherId === publisher.id, "expected the book's publisherId to be UNCHANGED");
  });
});

await check("C1.2b: set: null on a REQUIRED to-one (fkSide, Book.publisher) throws", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Book.update({ where: { id: book.id }, data: { publisher: { set: null } } });
    } catch (err) {
      threw = true;
      assert(err.code === "REQUIRED_RELATION_DISCONNECT", `expected code REQUIRED_RELATION_DISCONNECT, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
  });
});

await check("C1.2c: disconnect on an OPTIONAL to-one (fkSide, Book.author) clears the FK to NULL", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const author = await Author.create({ data: { name: "Ada" } });
    const book = await Book.create({ data: { title: "B1", authorId: author.id, publisherId: publisher.id } });

    const updated = await Book.update({ where: { id: book.id }, data: { author: { disconnect: true } } });
    assert(updated.authorId === null, "expected the book's authorId to be cleared to NULL");
  });
});

// ─── C1.3: set: [] disconnects the entire linked set, deletes nothing ─────────

await check("C1.3a: set: [] on Author.books disconnects every currently-linked book, deletes none", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const author = await Author.create({ data: { name: "Ada" } });
    const b1 = await Book.create({ data: { title: "B1", authorId: author.id, publisherId: publisher.id } });
    const b2 = await Book.create({ data: { title: "B2", authorId: author.id, publisherId: publisher.id } });

    await Author.update({ where: { id: author.id }, data: { books: { set: [] } } });

    const books = await Book.findMany({ where: { id: { in: [b1.id, b2.id] } } });
    assert(books.length === 2, "expected NO book row to be deleted");
    assert(books.every((b) => b.authorId === null), "expected every previously-linked book to have authorId cleared");
  });
});

await check("C1.3b: set: [where] on Author.books disconnects the old set and connects the new one", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const author = await Author.create({ data: { name: "Ada" } });
    const oldBook = await Book.create({ data: { title: "old", authorId: author.id, publisherId: publisher.id } });
    const newBook = await Book.create({ data: { title: "new", publisherId: publisher.id } });

    await Author.update({ where: { id: author.id }, data: { books: { set: [{ id: newBook.id }] } } });

    const after = await Book.findMany({ where: { id: { in: [oldBook.id, newBook.id] } } });
    const oldAfter = after.find((b) => b.id === oldBook.id);
    const newAfter = after.find((b) => b.id === newBook.id);
    assert(oldAfter.authorId === null, "expected the OLD book to be disconnected");
    assert(newAfter.authorId === author.id, "expected the NEW book to be connected");
  });
});

// ─── C1.4: relation-ops-only data resolves target via findMany; >1 match -> AMBIGUOUS_UPDATE_TARGET ─

await check("C1.4a: relation-ops-only data (no scalars) still applies to the single matched row", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const author = await Author.create({ data: { name: "Ada" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    await Author.update({ where: { id: author.id }, data: { books: { connect: [{ id: book.id }] } } });

    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].authorId === author.id, "expected the book to be connected to the author");
  });
});

await check("C1.4b: `where` matching more than one row + relation ops throws AMBIGUOUS_UPDATE_TARGET", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    await Author.create({ data: { name: "Dup" } });
    await Author.create({ data: { name: "Dup" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Author.update({ where: { name: "Dup" }, data: { books: { connect: [{ id: book.id }] } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNestedWriteError, "expected an IndigoNestedWriteError");
      assert(err.code === "AMBIGUOUS_UPDATE_TARGET", `expected code AMBIGUOUS_UPDATE_TARGET, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].authorId === null, "expected NO connect to have happened");
  });
});

// C1.4c previously asserted the resolved value was strictly equal to
// `undefined` on a zero-row match with relation-ops-only `data` — ratifying
// the pre-existing defect where a zero-row write silently resolved with a
// value typed as the row but actually absent at runtime. This
// is a deliberate behavior flip (client-write-preconditions spec WP-6,
// client-nested-writes spec NW-4, design.md Data Flow): the call now throws
// `IndigoNotFoundError` code `RECORD_NOT_FOUND` instead. The no-partial-write
// assertion (`after[0].authorId === null`) is KEPT so that guarantee is
// still proven at its new location, not dropped.
await check("C1.4c: `where` matching zero rows with relation ops throws RECORD_NOT_FOUND (no partial write)", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const { Author, Publisher, Book } = buildDelegates(exec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Author.update({ where: { id: 999 }, data: { books: { connect: [{ id: book.id }] } } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoNotFoundError, "expected an IndigoNotFoundError");
      assert(err.code === "RECORD_NOT_FOUND", `expected code RECORD_NOT_FOUND, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");
    const after = await Book.findMany({ where: { id: book.id } });
    assert(after[0].authorId === null, "expected NO connect to have happened for a nonexistent parent");
  });
});

// ─── Scalar-only parity + rollback ─────────────────────────────────────────

await check("update() with no relation ops skips the planner entirely — same SQL as pre-change update()", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seed(db);
    const calls = [];
    const recordingExec = async (sql, params) => {
      calls.push({ sql, params });
      return exec(sql, params);
    };
    const { Publisher } = buildDelegates(recordingExec);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    calls.length = 0;
    await Publisher.update({ where: { id: publisher.id }, data: { name: "Renamed" } });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      calls[0].sql === 'UPDATE "Publisher" SET "name" = $1 WHERE "id" = $2 RETURNING "id" AS "id", "name" AS "name"',
      `unexpected SQL: ${calls[0].sql}`,
    );
  });
});

await check("a failing nested relation op inside update() rolls back the parent's own scalar changes too", async () => {
  await withDatabase(async (db) => {
    const { exec, transaction } = createPgliteDb(db);
    await seed(db);
    const client = new IndigoClientBase({ db: { exec, transaction } });
    const { Publisher, Book } = buildTopLevelRegistry(client);
    const publisher = await Publisher.create({ data: { name: "Pub" } });
    const book = await Book.create({ data: { title: "B1", publisherId: publisher.id } });

    let threw = false;
    try {
      await Publisher.update({
        where: { id: publisher.id },
        data: { name: "Renamed", books: { disconnect: [{ id: book.id }] } },
      });
    } catch (err) {
      threw = true;
      assert(err.code === "REQUIRED_RELATION_DISCONNECT", `expected code REQUIRED_RELATION_DISCONNECT, got ${err.code}`);
    }
    assert(threw, "expected update() to reject");

    const after = await Publisher.findMany({ where: { id: publisher.id } });
    assert(after[0].name === "Pub", "expected the publisher's name to be UNCHANGED (rolled back)");
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client nested-writes-update: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client nested-writes-update: all checks passed");
}
