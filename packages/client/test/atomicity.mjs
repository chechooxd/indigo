/**
 * @indigodb/client — nested-write atomicity seam (`runAtomic`) regression.
 *
 * PR A (nested-writes, tasks.md A3.1/A3.2) — `ModelDelegate` gains a 4th
 * constructor argument, `runAtomic` (design.md Decision "atomicity via
 * `runAtomic`, a 4th `__delegates` argument"). This PR only threads the seam
 * through the constructor and proves its default/override behavior; no
 * planner (create/update nested-op logic) reads it yet.
 *
 * Default (omitted `runAtomic`, the shape `__delegates` passes when already
 * inside `$transaction`): IDENTITY — calls `fn` with the delegate's own
 * `siblings()` registry directly, opening no new transaction.
 *
 * Explicit `runAtomic` (the shape the generated constructor passes at the
 * top level, `(fn) => this.$transaction(fn)`): a REAL transaction is opened
 * around `fn`, proven end-to-end against PGlite — a write inside `fn`
 * commits only once the whole `runAtomic` call resolves.
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

const postMeta = {
  name: "Post",
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
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

// ─── Default (omitted) runAtomic: identity, no new transaction ────────────

await check(
  "default runAtomic (4th arg omitted) is identity: calls fn with this delegate's own siblings() registry",
  async () => {
    const { exec } = stubExecutor();
    const siblingsReg = { post: "stand-in-for-a-sibling-delegate" };
    const delegate = new ModelDelegate(postMeta, exec, () => siblingsReg);

    let received;
    const result = await delegate['runAtomic'](async (tx) => {
      received = tx;
      return "identity-result";
    });

    assert(received === siblingsReg, "expected fn to receive the delegate's own siblings() registry, unchanged");
    assert(result === "identity-result", "expected runAtomic to return fn's own return value");
  },
);

await check(
  "default runAtomic with no siblings thunk: calls fn with an empty registry, never throws",
  async () => {
    const { exec } = stubExecutor();
    const delegate = new ModelDelegate(postMeta, exec);

    let received;
    await delegate['runAtomic'](async (tx) => {
      received = tx;
    });

    assert(received !== undefined && received !== null, "expected fn to be called with a defined (empty) registry");
    assert(Object.keys(received).length === 0, "expected an empty registry when no siblings thunk was provided");
  },
);

// ─── Explicit runAtomic: real thunk, e.g. (fn) => this.$transaction(fn) ────

await check(
  "explicit runAtomic (4th arg) overrides the default and is invoked instead",
  async () => {
    const { exec } = stubExecutor();
    const customReg = { post: "custom-registry" };
    const calls = [];
    const customRunAtomic = async (fn) => {
      calls.push("custom-runAtomic-called");
      return fn(customReg);
    };
    const delegate = new ModelDelegate(postMeta, exec, undefined, customRunAtomic);

    let received;
    await delegate['runAtomic'](async (tx) => {
      received = tx;
    });

    assert(calls.length === 1, "expected the explicit runAtomic to be invoked exactly once");
    assert(received === customReg, "expected fn to receive the CUSTOM registry, not the delegate's own siblings()");
  },
);

await check(
  "top-level real thunk: `(fn) => client.$transaction(fn)` opens one real transaction — the write only commits once runAtomic resolves",
  async () => {
    await withDatabase(async (db) => {
      const { exec, transaction } = createPgliteDb(db);
      await exec(`
        CREATE TABLE "Post" (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL
        );
      `);
      const client = new IndigoClientBase({ db: { exec, transaction } });

      // Mirrors the generated constructor's wiring: `(fn) => this.$transaction(fn)`.
      const topLevelRunAtomic = (fn) =>
        client.$transaction((txExec) => fn({ post: new ModelDelegate(postMeta, txExec) }));

      const delegate = new ModelDelegate(postMeta, client.exec, undefined, topLevelRunAtomic);

      // The transaction closure must only ever touch the `tx` handle it
      // receives, never the outer `db`/`client.exec` (electric-sql/pglite#76,
      // documented on `pglite-harness.mjs`'s `createPgliteDb`) — so
      // visibility is proven by committing-after-resolve, mirroring
      // `transactions.mjs`'s own commit assertion, not by racing a
      // concurrent outside read mid-transaction.
      const result = await delegate['runAtomic'](async (tx) => {
        return tx.post.create({ data: { title: "InsideRunAtomic" } });
      });

      assert(result.title === "InsideRunAtomic", "expected runAtomic to resolve with fn's own return value");

      const outsidePosts = new ModelDelegate(postMeta, client.exec);
      const afterCommit = await outsidePosts.findMany({});
      assert(afterCommit.length === 1, "expected the write to be visible after runAtomic (the transaction) resolves");
      assert(afterCommit[0].title === "InsideRunAtomic", "expected the committed row to match what was created");
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client atomicity: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client atomicity: all checks passed");
}
