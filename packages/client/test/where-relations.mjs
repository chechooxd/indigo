/**
 * @indigodb/client — relation filters `some`/`every`/`none` via correlated
 * `EXISTS`/`NOT EXISTS` subqueries (client-where-composition PR B, tasks.md
 * B3.1-B4.1).
 *
 * Plain Node, no framework, mirroring `where-composition.mjs`'s style.
 * Proves `whereExpr`'s relation-key dispatch (checked before `meta.fields`,
 * design.md "Key dispatch order"), the exact SQL shapes for `some`/`none`/
 * `every` (design.md "Relation SQL Shapes (PR B)"), collision-free
 * depth-indexed aliases across self-relation nesting, the composite-relation
 * rejection, and a PGlite round-trip proving `every` is vacuously satisfied
 * by a parent row with zero related children.
 */

import { ModelDelegate, IndigoRelationError } from "../dist/delegate.js";
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

// `Post` has-many `Comment` (comments.post_id -> posts.id). `Comment` also
// self-relates via `replies` (comments.parent_id -> comments.id) to exercise
// the depth-indexed-alias collision-free requirement (B3.2).
const postMeta = {
  name: "Post",
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
  },
  relations: {
    comments: { target: "Comment", from: "id", to: "postId", list: true, fkSide: false, optional: true, optionalFk: true },
  },
};

const commentMeta = {
  name: "Comment",
  table: "Comment",
  fields: {
    id: { db: "id", pk: true },
    postId: { db: "post_id" },
    parentId: { db: "parent_id" },
    flagged: { db: "flagged" },
  },
  relations: {
    replies: { target: "Comment", from: "id", to: "parentId", list: true, fkSide: false, optional: true, optionalFk: true },
    order: { target: "Order", composite: true },
  },
};

function makeSiblings(exec) {
  const registry = {};
  const postDelegate = new ModelDelegate(postMeta, exec, () => registry);
  const commentDelegate = new ModelDelegate(commentMeta, exec, () => registry);
  registry.Post = postDelegate;
  registry.Comment = commentDelegate;
  return { postDelegate, commentDelegate, registry };
}

console.log("client regression: relation filters (some/every/none)");

// ─── some compiles to EXISTS ───────────────────────────────────────────────

await check("some compiles to EXISTS with the correlated subquery shape", async () => {
  const { exec, calls } = stubExecutor();
  const { postDelegate } = makeSiblings(exec);
  await postDelegate.findMany({ where: { comments: { some: { flagged: true } } } });
  assert(calls.length === 1, "expected one query");
  assert(
    calls[0].sql.includes(
      `WHERE EXISTS (SELECT 1 FROM "Comment" AS "t1" WHERE "t1"."post_id" = "Post"."id" AND ("t1"."flagged" = $1))`,
    ),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(calls[0].params.length === 1 && calls[0].params[0] === true);
});

// ─── none compiles to NOT EXISTS ───────────────────────────────────────────

await check("none compiles to NOT EXISTS with the correlated subquery shape", async () => {
  const { exec, calls } = stubExecutor();
  const { postDelegate } = makeSiblings(exec);
  await postDelegate.findMany({ where: { comments: { none: { flagged: true } } } });
  assert(
    calls[0].sql.includes(
      `WHERE NOT EXISTS (SELECT 1 FROM "Comment" AS "t1" WHERE "t1"."post_id" = "Post"."id" AND ("t1"."flagged" = $1))`,
    ),
    `unexpected SQL: ${calls[0].sql}`,
  );
});

// ─── every uses vacuous-truth NOT EXISTS(... AND NOT(<f>)) ─────────────────

await check("every compiles to vacuous-truth NOT EXISTS(... AND NOT(<f>))", async () => {
  const { exec, calls } = stubExecutor();
  const { postDelegate } = makeSiblings(exec);
  await postDelegate.findMany({ where: { comments: { every: { flagged: true } } } });
  assert(
    calls[0].sql.includes(
      `WHERE NOT EXISTS (SELECT 1 FROM "Comment" AS "t1" WHERE "t1"."post_id" = "Post"."id" AND NOT ("t1"."flagged" = $1))`,
    ),
    `unexpected SQL: ${calls[0].sql}`,
  );
});

// ─── a null nested filter drops the AND(<f>) term for some/none ───────────

await check("some: {} (no nested filter) drops the AND(<f>) term — has any child", async () => {
  const { exec, calls } = stubExecutor();
  const { postDelegate } = makeSiblings(exec);
  await postDelegate.findMany({ where: { comments: { some: {} } } });
  assert(
    calls[0].sql.includes(`WHERE EXISTS (SELECT 1 FROM "Comment" AS "t1" WHERE "t1"."post_id" = "Post"."id")`),
    `unexpected SQL: ${calls[0].sql}`,
  );
  assert(calls[0].params.length === 0, "expected no params");
});

// ─── Composite relations throw the existing IndigoRelationError shape ─────

await check("composite relation in a where filter throws IndigoRelationError", async () => {
  const { exec } = stubExecutor();
  const { commentDelegate } = makeSiblings(exec);
  let caught;
  try {
    await commentDelegate.findMany({ where: { order: { some: {} } } });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IndigoRelationError, `expected IndigoRelationError, got ${caught}`);
});

// ─── B3.2: self-relation nesting uses collision-free depth-indexed aliases ─

await check("self-relation nesting (Comment.replies) uses collision-free depth-indexed aliases", async () => {
  const { exec, calls } = stubExecutor();
  const { commentDelegate } = makeSiblings(exec);
  await commentDelegate.findMany({
    where: { replies: { some: { replies: { some: { flagged: true } } } } },
  });
  assert(
    calls[0].sql.includes(
      `WHERE EXISTS (SELECT 1 FROM "Comment" AS "t1" WHERE "t1"."parent_id" = "Comment"."id" AND ` +
        `(EXISTS (SELECT 1 FROM "Comment" AS "t2" WHERE "t2"."parent_id" = "t1"."id" AND ("t2"."flagged" = $1))))`,
    ),
    `unexpected SQL: ${calls[0].sql}`,
  );
});

// ─── Integration: every is vacuously satisfied by zero-children rows ──────

await check("PGlite round-trip: every is vacuously satisfied by a parent row with zero children", async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE TABLE "Post" (
        id SERIAL PRIMARY KEY
      );
      CREATE TABLE "Comment" (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL,
        parent_id INTEGER,
        flagged BOOLEAN NOT NULL DEFAULT false
      );
    `);
    const exec = createPgliteExecutor(db);
    const registry = {};
    const postDelegate = new ModelDelegate(postMeta, exec, () => registry);
    const commentDelegate = new ModelDelegate(commentMeta, exec, () => registry);
    registry.Post = postDelegate;
    registry.Comment = commentDelegate;

    const withZeroChildren = await postDelegate.create({ data: {} });
    const withFlaggedChild = await postDelegate.create({ data: {} });
    await commentDelegate.create({ data: { postId: withFlaggedChild.id, flagged: true } });

    const rows = await postDelegate.findMany({ where: { comments: { every: { flagged: true } } } });
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    assert(
      ids.includes(withZeroChildren.id),
      `expected the zero-children row (${withZeroChildren.id}) to satisfy \`every\` vacuously; got ${JSON.stringify(ids)}`,
    );
    assert(
      ids.includes(withFlaggedChild.id),
      `expected the all-flagged row (${withFlaggedChild.id}) to satisfy \`every\`; got ${JSON.stringify(ids)}`,
    );
  });
});

if (failures > 0) {
  console.error(`\n@indigodb/client where-relations: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client where-relations: all checks passed");
}
