/**
 * @indigodb/client — upsert (PR D, client-batch-aggregate).
 *
 * `ModelDelegate.upsert` (design.md "ON CONFLICT target", client-upsert
 * spec). Issues a single `INSERT ... ON CONFLICT (<unique columns>) DO
 * UPDATE SET ...` statement, no `runAtomic` (one statement is already
 * atomic). The conflict target is resolved from `where`'s keys matching a
 * declared unique-constraint group in `__meta.uniqueGroups` (PK first, then
 * `@unique` columns, then unique indexes) — an exact key-set match only;
 * anything else (unknown field set, operator objects, partial composite
 * match) throws `IndigoArgumentError` code `NO_MATCHING_UNIQUE_CONSTRAINT`
 * before any SQL is issued.
 *
 * Layout:
 *  - D.1: `where` matching no declared unique group throws before `exec`.
 *  - D.2: `where` containing an operator object (non-plain-equality) throws
 *    the same code.
 *  - D.3: partial match against a composite unique group throws the same
 *    code.
 *  - D.4: a matching `where` emits the exact `ON CONFLICT ... DO UPDATE`
 *    shape.
 *  - D.11: PGlite integration — insert-then-update lifecycle, single-column
 *    and composite unique group targets.
 */

import { IndigoArgumentError, ModelDelegate } from "../dist/delegate.js";
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

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

async function seedUser(db) {
  await db.exec(`
    CREATE TABLE "User" (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);
  `);
}

async function seedMembership(db) {
  await db.exec(`
    CREATE TABLE "Membership" (
      id SERIAL PRIMARY KEY,
      "userId" INT NOT NULL,
      "orgId" INT NOT NULL,
      role TEXT,
      UNIQUE ("userId", "orgId")
    );
  `);
}

console.log("@indigodb/client: upsert");

// ─── D.1: where matching no declared unique group throws before exec ──────

await check(
  "D.1: where on a non-unique field throws IndigoArgumentError code NO_MATCHING_UNIQUE_CONSTRAINT before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.upsert({ where: { name: "A" }, create: { email: "a@x.com", name: "A" }, update: { name: "A" } });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected upsert() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── D.2: where with an operator object throws the same code ──────────────

await check(
  "D.2: where containing an operator object throws IndigoArgumentError code NO_MATCHING_UNIQUE_CONSTRAINT before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const User = new ModelDelegate(userMeta, exec);
    let threw = false;
    try {
      await User.upsert({
        where: { email: { equals: "a@x.com" } },
        create: { email: "a@x.com", name: "A" },
        update: { name: "A" },
      });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected upsert() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── D.3: partial composite match throws the same code ────────────────────

await check(
  "D.3: partial match against a composite unique group throws IndigoArgumentError code NO_MATCHING_UNIQUE_CONSTRAINT before any SQL is issued",
  async () => {
    const { exec, calls } = stubExecutor();
    const Membership = new ModelDelegate(membershipMeta, exec);
    let threw = false;
    try {
      await Membership.upsert({
        where: { userId: 1 },
        create: { userId: 1, orgId: 2, role: "member" },
        update: { role: "member" },
      });
    } catch (err) {
      threw = true;
      assert(err instanceof IndigoArgumentError, "expected an IndigoArgumentError");
      assert(
        err.code === "NO_MATCHING_UNIQUE_CONSTRAINT",
        `expected code NO_MATCHING_UNIQUE_CONSTRAINT, got ${err.code}`,
      );
    }
    assert(threw, "expected upsert() to reject");
    assert(calls.length === 0, "expected NO SQL statement to be issued");
  },
);

// ─── D.4: matching where emits the exact ON CONFLICT ... DO UPDATE shape ──

await check(
  "D.4a: single-column unique target emits INSERT ... ON CONFLICT (email) DO UPDATE SET ... RETURNING <selectList>",
  async () => {
    const { exec, calls } = stubExecutor([{ id: 1, email: "b@x.com", name: "New" }]);
    const User = new ModelDelegate(userMeta, exec);
    const result = await User.upsert({
      where: { email: "b@x.com" },
      create: { email: "b@x.com", name: "B" },
      update: { name: "New" },
    });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      calls[0].sql ===
        'INSERT INTO "User" ("email", "name") VALUES ($1, $2) ON CONFLICT ("email") DO UPDATE SET "name" = $3 ' +
          'RETURNING "id" AS "id", "email" AS "email", "name" AS "name"',
      `unexpected SQL: ${calls[0].sql}`,
    );
    assert(
      calls[0].params.length === 3 &&
        calls[0].params[0] === "b@x.com" &&
        calls[0].params[1] === "B" &&
        calls[0].params[2] === "New",
      `unexpected params: ${JSON.stringify(calls[0].params)}`,
    );
    assert(result.name === "New", `unexpected result: ${JSON.stringify(result)}`);
  },
);

await check(
  "D.4b: composite unique target emits ON CONFLICT (userId, orgId) DO UPDATE",
  async () => {
    const { exec, calls } = stubExecutor([{ id: 1, userId: 1, orgId: 2, role: "member" }]);
    const Membership = new ModelDelegate(membershipMeta, exec);
    await Membership.upsert({
      where: { userId: 1, orgId: 2 },
      create: { userId: 1, orgId: 2, role: "member" },
      update: { role: "member" },
    });
    assert(calls.length === 1, `expected exactly 1 statement, got ${calls.length}`);
    assert(
      calls[0].sql ===
        'INSERT INTO "Membership" ("userId", "orgId", "role") VALUES ($1, $2, $3) ON CONFLICT ("userId", "orgId") ' +
          'DO UPDATE SET "role" = $4 RETURNING "id" AS "id", "userId" AS "userId", "orgId" AS "orgId", "role" AS "role"',
      `unexpected SQL: ${calls[0].sql}`,
    );
  },
);

// ─── D.11: PGlite integration — insert-then-update lifecycle ──────────────

await check("D.11a: single-column unique upsert inserts then updates the real row", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedUser(db);
    const User = new ModelDelegate(userMeta, exec);

    const inserted = await User.upsert({
      where: { email: "a@x.com" },
      create: { email: "a@x.com", name: "A" },
      update: { name: "ignored" },
    });
    assert(inserted.name === "A", `expected inserted name "A", got ${inserted.name}`);
    const afterInsert = await User.findMany({});
    assert(afterInsert.length === 1, `expected 1 row after insert, got ${afterInsert.length}`);

    const updated = await User.upsert({
      where: { email: "a@x.com" },
      create: { email: "a@x.com", name: "should not be used" },
      update: { name: "Updated" },
    });
    assert(updated.name === "Updated", `expected updated name "Updated", got ${updated.name}`);
    const afterUpdate = await User.findMany({});
    assert(afterUpdate.length === 1, `expected still 1 row after update, got ${afterUpdate.length}`);
  });
});

await check("D.11b: composite unique upsert inserts then updates the real row", async () => {
  await withDatabase(async (db) => {
    const exec = createPgliteExecutor(db);
    await seedMembership(db);
    const Membership = new ModelDelegate(membershipMeta, exec);

    const inserted = await Membership.upsert({
      where: { userId: 1, orgId: 2 },
      create: { userId: 1, orgId: 2, role: "member" },
      update: { role: "ignored" },
    });
    assert(inserted.role === "member", `expected inserted role "member", got ${inserted.role}`);

    const updated = await Membership.upsert({
      where: { userId: 1, orgId: 2 },
      create: { userId: 1, orgId: 2, role: "should not be used" },
      update: { role: "admin" },
    });
    assert(updated.role === "admin", `expected updated role "admin", got ${updated.role}`);
    const rows = await Membership.findMany({});
    assert(rows.length === 1, `expected still 1 row after update, got ${rows.length}`);
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client upsert: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client upsert: all checks passed");
}
