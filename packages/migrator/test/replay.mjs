/**
 * @indigodb/migrator — replay-from-zero verification suite.
 *
 * Mirrors `appliability.mjs`'s style: plain Node, no test framework.
 * `migrator.mjs` and `appliability.mjs` both prove ONE hop at a time
 * (`prev` -> `next`). This suite proves the whole CHAIN: a database built by
 * replaying every migration hop in order, from empty, describes the exact
 * same structure as a database built by a single `db push` against the
 * chain's final schema. `pg-harness.mjs`'s `introspectPublicSchema` /
 * `assertSameStructure` do the comparison; this file owns only fixture
 * loading and the two build paths.
 *
 * SCOPE: structural equivalence of `information_schema` snapshots (columns,
 * types, nullability, defaults). Constraint/index names, FK action names,
 * and column ordinal position are intentionally never compared — see
 * `assertSameStructure`'s own doc comment in `pg-harness.mjs`.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadChainFixture } from "./lib.mjs";
import { withDatabase, applyPlan, introspectPublicSchema, assertSameStructure } from "./pg-harness.mjs";
import { planMigration, renderMigrationSql, renderPushSql } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const chainDir = join(here, "fixtures-chain", "user-post-status");

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("migrator replay-from-zero: comparator self-tests + chain replay (PGlite, in-process)");

// ─── Comparator self-tests ──────────────────────────────────────────────────
//
// RED first: these assert `assertSameStructure`'s behaviour as a detector,
// written before the helper existed (see `pg-harness.mjs`). They stay here,
// run every time, so a future regression in the comparator is caught the
// same way a regression in the migrator itself would be.

await check("comparator self-test: detects a deliberate type drift", async () => {
  await withDatabase(async (dbA) => {
    await dbA.exec('CREATE TABLE "T" ("n" text);');
    await withDatabase(async (dbB) => {
      await dbB.exec('CREATE TABLE "T" ("n" integer);');
      const a = await introspectPublicSchema(dbA);
      const b = await introspectPublicSchema(dbB);
      let threw = false;
      let message = "";
      try {
        assertSameStructure(a, b, { aLabel: "A", bLabel: "B" });
      } catch (err) {
        threw = true;
        message = err.message;
      }
      if (!threw) throw new Error("expected assertSameStructure to throw on a type drift, but it did not");
      if (!message.includes("T.n") || !message.includes("text") || !message.includes("integer")) {
        throw new Error(`expected message to name T.n, text, integer; got:\n${message}`);
      }
    });
  });
});

await check("comparator self-test: tolerates differing constraint/index names (false-positive guard)", async () => {
  await withDatabase(async (dbA) => {
    await dbA.exec('CREATE TABLE "T" ("id" integer, CONSTRAINT "T_pkey_a" PRIMARY KEY ("id"));');
    await dbA.exec('CREATE INDEX "idx_a" ON "T" ("id");');
    await withDatabase(async (dbB) => {
      await dbB.exec('CREATE TABLE "T" ("id" integer, CONSTRAINT "T_pkey_b" PRIMARY KEY ("id"));');
      await dbB.exec('CREATE INDEX "idx_b" ON "T" ("id");');
      const a = await introspectPublicSchema(dbA);
      const b = await introspectPublicSchema(dbB);
      assertSameStructure(a, b, { aLabel: "A", bLabel: "B" });
    });
  });
});

await check("comparator self-test: reports a missing table once, not per-column", async () => {
  await withDatabase(async (dbA) => {
    await dbA.exec('CREATE TABLE "Extra" ("a" integer, "b" integer, "c" integer);');
    await withDatabase(async (dbB) => {
      const a = await introspectPublicSchema(dbA);
      const b = await introspectPublicSchema(dbB);
      let message = "";
      try {
        assertSameStructure(a, b, { aLabel: "A", bLabel: "B" });
      } catch (err) {
        message = err.message;
      }
      const tableLines = message.split("\n").filter((line) => line.includes('table "Extra"'));
      if (tableLines.length !== 1) {
        throw new Error(`expected exactly one table-level divergence line for "Extra", got ${tableLines.length}:\n${message}`);
      }
    });
  });
});

// ─── Chain replay ────────────────────────────────────────────────────────────

const schemas = loadChainFixture(chainDir);

await check("chain replays from empty: every hop applies in sequence, no reset", async () => {
  await withDatabase(async (db) => {
    let prev = null;
    for (let i = 0; i < schemas.length; i++) {
      const next = schemas[i];
      const plan = planMigration(prev, next);
      const sql = renderMigrationSql(plan);
      const executed = await applyPlan(db, sql);
      if (executed < 1) {
        throw new Error(`hop ${i + 1}: expected at least one executed statement, got ${executed}`);
      }
      if (i === 2 && executed !== 2) {
        // Hop 3 adds a new enum value AND is the hop whose value is later
        // consumed in hop 4 — it must split into a pre-transaction ADD VALUE
        // plus a transactional body, exactly like `enum-add-value-and-use`.
        throw new Error(`hop 3 (enum-value hop): expected 2 executed units (pre-transaction + body), got ${executed}`);
      }
      prev = next;
    }
  });
});

await check("chain replay is structurally equivalent to a single push", async () => {
  const final = schemas[schemas.length - 1];

  await withDatabase(async (migrateDb) => {
    let prev = null;
    for (const next of schemas) {
      const plan = planMigration(prev, next);
      await applyPlan(migrateDb, renderMigrationSql(plan));
      prev = next;
    }

    await withDatabase(async (pushDb) => {
      await pushDb.exec(renderPushSql(final));

      const migrateSnapshot = await introspectPublicSchema(migrateDb);
      const pushSnapshot = await introspectPublicSchema(pushDb);
      assertSameStructure(migrateSnapshot, pushSnapshot, { aLabel: "migrate-path", bLabel: "push-path" });
    });
  });
});

if (failures > 0) {
  console.error(`\nmigrator replay-from-zero: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator replay-from-zero: all green");
