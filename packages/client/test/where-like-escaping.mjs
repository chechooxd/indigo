/**
 * @indigodb/client — `contains` / `startsWith` / `endsWith` LIKE-metacharacter
 * escaping regression suite.
 *
 * Plain Node, no framework, mirroring `where-composition.mjs`'s style.
 *
 * These three operators are documented in `types.ts` as substring / prefix /
 * suffix matches — literal text, not patterns. They compile to `ILIKE`, so the
 * value has to be escaped before it reaches the pattern: `%`, `_` and the
 * escape character itself are wildcards in a LIKE pattern, and a user value
 * carrying one silently widens the match.
 *
 * This is a correctness defect, NOT an injection one: the value has always
 * travelled as a bind parameter (`$N`), so no SQL structure was ever
 * attacker-controllable. What leaked was pattern semantics — `contains: "100%"`
 * matching "1000 euros", `contains: "a_b"` matching "axb".
 *
 * Every case below round-trips against a real PostgreSQL engine (PGlite)
 * rather than asserting on emitted SQL text, because the bug is about what
 * the database *matches*, not about how the statement is spelled.
 */

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

const meta = {
  name: "T",
  table: "T",
  fields: { id: { db: "id", pk: true }, v: { db: "v" } },
};

/** Seeds a fresh table with one row per entry of `values`, returns a delegate. */
async function withRows(db, values) {
  await db.exec(`CREATE TABLE "T" (id SERIAL PRIMARY KEY, v TEXT NOT NULL);`);
  const delegate = new ModelDelegate(meta, createPgliteExecutor(db));
  for (const v of values) await delegate.create({ data: { v } });
  return delegate;
}

/** The `v` values matched by `where`, sorted for order-independent assertions. */
async function matched(delegate, where) {
  const rows = await delegate.findMany({ where });
  return rows.map((r) => r.v).sort();
}

console.log("client regression: LIKE metacharacter escaping (contains/startsWith/endsWith)");

// ─── `%` must be literal, not a wildcard ────────────────────────────────────

await check('contains: "100%" matches only the literal "100%", not "1000 euros"', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["discount 100% off", "1000 euros", "100"]);
    const found = await matched(delegate, { v: { contains: "100%" } });
    assert(
      found.length === 1 && found[0] === "discount 100% off",
      `expected only the literal "100%" row, got ${JSON.stringify(found)}`,
    );
  });
});

await check('startsWith: "%" does not match every row', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["%off", "plain", "another"]);
    const found = await matched(delegate, { v: { startsWith: "%" } });
    assert(
      found.length === 1 && found[0] === "%off",
      `a leading "%" must be literal, got ${JSON.stringify(found)}`,
    );
  });
});

await check('endsWith: "%" does not match every row', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["total%", "plain", "another"]);
    const found = await matched(delegate, { v: { endsWith: "%" } });
    assert(
      found.length === 1 && found[0] === "total%",
      `a trailing "%" must be literal, got ${JSON.stringify(found)}`,
    );
  });
});

// ─── `_` must be literal, not a single-character wildcard ───────────────────

await check('contains: "a_b" does not match "axb"', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["a_b", "axb", "ab"]);
    const found = await matched(delegate, { v: { contains: "a_b" } });
    assert(
      found.length === 1 && found[0] === "a_b",
      `"_" must be literal, got ${JSON.stringify(found)}`,
    );
  });
});

await check('startsWith: "_x" does not match "ax"', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["_xyz", "axyz"]);
    const found = await matched(delegate, { v: { startsWith: "_x" } });
    assert(
      found.length === 1 && found[0] === "_xyz",
      `"_" must be literal, got ${JSON.stringify(found)}`,
    );
  });
});

// ─── The escape character itself must survive as a literal ──────────────────

await check('contains: a backslash matches the literal backslash row', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["C:\\Users\\alice", "C:Usersalice"]);
    const found = await matched(delegate, { v: { contains: "\\Users" } });
    assert(
      found.length === 1 && found[0] === "C:\\Users\\alice",
      `a backslash must be literal, got ${JSON.stringify(found)}`,
    );
  });
});

await check('contains: "100\\%" (backslash + percent) matches only that literal text', async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["100\\% raw", "100% raw", "1000 raw"]);
    const found = await matched(delegate, { v: { contains: "100\\%" } });
    assert(
      found.length === 1 && found[0] === "100\\% raw",
      `escape char + wildcard must both stay literal, got ${JSON.stringify(found)}`,
    );
  });
});

// ─── Ordinary values keep working exactly as before (no regression) ─────────

await check("plain values still match: contains/startsWith/endsWith unchanged", async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["alice@acme.dev", "bob@other.io", "carol@acme.dev"]);
    const contains = await matched(delegate, { v: { contains: "acme" } });
    assert(contains.length === 2, `expected 2 contains matches, got ${JSON.stringify(contains)}`);

    const starts = await matched(delegate, { v: { startsWith: "bob" } });
    assert(
      starts.length === 1 && starts[0] === "bob@other.io",
      `unexpected startsWith result: ${JSON.stringify(starts)}`,
    );

    const ends = await matched(delegate, { v: { endsWith: ".dev" } });
    assert(ends.length === 2, `expected 2 endsWith matches, got ${JSON.stringify(ends)}`);
  });
});

await check("case-insensitivity is preserved (ILIKE, not LIKE)", async () => {
  await withDatabase(async (db) => {
    const delegate = await withRows(db, ["ALICE@ACME.DEV", "bob@other.io"]);
    const found = await matched(delegate, { v: { contains: "acme" } });
    assert(
      found.length === 1 && found[0] === "ALICE@ACME.DEV",
      `contains must stay case-insensitive, got ${JSON.stringify(found)}`,
    );
  });
});

// ─── The value still travels as a bind parameter, never inlined ─────────────

await check("the escaped pattern is still a bind parameter, never inlined into SQL", async () => {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return [];
  };
  const delegate = new ModelDelegate(meta, exec);
  await delegate.findMany({ where: { v: { contains: "100%" } } });
  assert(calls.length === 1, "expected one query");
  assert(!calls[0].sql.includes("100"), `value must not appear in SQL text: ${calls[0].sql}`);
  assert(calls[0].params.length === 1, `expected exactly one bind param: ${JSON.stringify(calls[0].params)}`);
});

if (failures > 0) {
  console.error(`\n@indigodb/client where-like-escaping: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client where-like-escaping: all checks passed");
}
