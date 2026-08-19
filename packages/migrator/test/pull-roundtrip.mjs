/**
 * @indigodb/migrator — `db pull` real-DB round trip.
 *
 * Mirrors `introspect.mjs`'s style: plain Node, no test framework, PGlite
 * (`@electric-sql/pglite`) as the real PostgreSQL engine.
 *
 * The `db pull` cycle is: `renderPushSql(original)` -> apply to a real
 * database -> `introspectResolvedSchema` -> `printSchema` -> `parse` +
 * `resolve` the printed text -> compare against `original` via
 * `planMigration`. Everything round-trips losslessly EXCEPT foreign keys,
 * which the printer emits as structured comments (design decision 2,
 * `sdd/indigo-schema-printer/design`) rather than `@relation(...)` fields —
 * so `planMigration(printedThenResolved, original)` is expected to plan
 * ONLY FK-related statements/diagnostics (the "missing" FKs), never any
 * column/table/index/enum drift.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ok } from "node:assert";
import { parse, resolve, printSchema } from "@indigodb/core";
import { withDatabase, assertApplies } from "./pg-harness.mjs";
import { introspectResolvedSchema, planMigration, renderPushSql } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 60).join("\n"));
  }
}

console.log("migrator pull-roundtrip: db pull real-DB cycle (renderPushSql -> PGlite -> introspect -> print -> parse+resolve -> planMigration)");

function queryOf(db) {
  return (sql, params) => db.query(sql, params);
}

/**
 * Runs the full `db pull` cycle against `original` (a resolved schema) over
 * a fresh PGlite instance, returning the plan comparing the pulled-then-
 * reparsed schema against `original`.
 */
async function pullCycle(original) {
  return withDatabase(async (db) => {
    await assertApplies(db, renderPushSql(original));
    const introspected = await introspectResolvedSchema(queryOf(db));
    // `introspectResolvedSchema` never populates `schema.datasource` (design
    // decision 4) — mirror what `@indigodb/cli`'s `writePulledSchema` does:
    // synthesize it pointing at `env("DATABASE_URL")`, never a literal.
    introspected.datasource = {
      name: "db",
      provider: "postgresql",
      url: { kind: "function", name: "env", args: [{ kind: "string", value: "DATABASE_URL" }] },
    };
    const text = printSchema(introspected);
    const pulled = resolve(parse(text));
    return { text, plan: planMigration(pulled, original) };
  });
}

// ─── fk-unchanged: the load-bearing case ─────────────────────────────────────
//
// User/Post with one @relation FK (onDelete/onUpdate: Cascade). This is the
// simplest fixture that isolates "everything round-trips except the FK" —
// no renames, no enums, no composite keys muddying the diff.

await check("fk-unchanged: printed text has no synthesized @relation, has an @fk comment", async () => {
  const source = readFileSync(join(fixturesDir, "fk-unchanged", "next.indigo"), "utf8");
  const original = resolve(parse(source));
  const { text } = await pullCycle(original);
  ok(!text.includes("@relation"), `expected no synthesized @relation(...) in printed output:\n${text}`);
  ok(text.includes("@fk("), `expected a structured // @fk(...) comment in printed output:\n${text}`);
  ok(
    text.includes('url = env("DATABASE_URL")'),
    `expected the synthesized env(DATABASE_URL) datasource in printed output:\n${text}`,
  );
});

await check(
  "fk-unchanged: planMigration(pulled, original) plans ONLY FK-related statements/diagnostics",
  async () => {
    const source = readFileSync(join(fixturesDir, "fk-unchanged", "next.indigo"), "utf8");
    const original = resolve(parse(source));
    const { plan, text } = await pullCycle(original);

    const nonFkStatements = plan.statements.filter((s) => !/foreign key|constraint/i.test(s.sql));
    const nonFkDiagnostics = plan.diagnostics.filter((d) => !/foreign key|fk|constraint/i.test(d.message));

    if (nonFkStatements.length > 0 || nonFkDiagnostics.length > 0) {
      const stmts = nonFkStatements.map((s) => s.sql).join("\n");
      const diags = nonFkDiagnostics.map((d) => d.message).join("\n");
      throw new Error(
        `expected only FK-related plan output, got non-FK statement(s)/diagnostic(s):\n${stmts}\n${diags}\n\n--- printed schema ---\n${text}`,
      );
    }

    // At least one FK-related statement/diagnostic IS expected — the FK
    // genuinely "goes missing" relative to `original` because the printer
    // never synthesizes @relation(...). An empty plan here would mean the
    // test isn't actually exercising the documented gap.
    const totalFkRelated =
      plan.statements.length - nonFkStatements.length + (plan.diagnostics.length - nonFkDiagnostics.length);
    ok(
      totalFkRelated > 0,
      `expected at least one FK-related statement/diagnostic (documented FK-comment-only gap), got an empty plan:\n${text}`,
    );
  },
);

// ─── fk-self-reference: a second, structurally different FK shape ───────────

await check("fk-self-reference: cycle completes and plans only FK-related output", async () => {
  const source = readFileSync(join(fixturesDir, "fk-self-reference", "next.indigo"), "utf8");
  const original = resolve(parse(source));
  const { plan, text } = await pullCycle(original);

  const nonFkStatements = plan.statements.filter((s) => !/foreign key|constraint/i.test(s.sql));
  const nonFkDiagnostics = plan.diagnostics.filter((d) => !/foreign key|fk|constraint/i.test(d.message));

  if (nonFkStatements.length > 0 || nonFkDiagnostics.length > 0) {
    const stmts = nonFkStatements.map((s) => s.sql).join("\n");
    const diags = nonFkDiagnostics.map((d) => d.message).join("\n");
    throw new Error(
      `expected only FK-related plan output, got non-FK statement(s)/diagnostic(s):\n${stmts}\n${diags}\n\n--- printed schema ---\n${text}`,
    );
  }
});

if (failures > 0) {
  console.error(`\nmigrator pull-roundtrip: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator pull-roundtrip: all green");
