/**
 * @indigodb/migrator — golden regression harness.
 *
 * Mirrors `@indigodb/compiler`'s `test/parity.mjs`: plain Node, no test
 * framework, golden files in `test/fixtures/<case>/expected.json` are the
 * review artifact. Each fixture is a schema pair — `prev.indigo` (optional;
 * absent means "no prior schema") and `next.indigo` — plus one approved
 * `expected.json` capturing the exact statement/diagnostic output.
 *
 * Regenerate goldens (only after an INTENTIONAL contract/behaviour change):
 *   node test/regen-goldens.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeActual, loadFixture } from "./lib.mjs";
import { splitMigrationSql, scanRequiresForce, REQUIRES_FORCE_MARKER, planMigration, renderMigrationSql } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const norm = (x) => JSON.parse(JSON.stringify(x));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

const cases = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

console.log(`migrator regression: ${cases.length} fixtures`);
for (const name of cases) {
  const dir = join(fixturesDir, name);
  const expectedPath = join(dir, "expected.json");
  check(`${name}: expected.json exists`, () => {
    if (!existsSync(expectedPath)) {
      throw new Error(`missing golden — run: node test/regen-goldens.mjs`);
    }
  });
  if (!existsSync(expectedPath)) continue;
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  const actual = norm(computeActual(dir));
  check(`${name}: statements`, () => deepStrictEqual(actual.statements, expected.statements));
  check(`${name}: diagnostics`, () => deepStrictEqual(actual.diagnostics, expected.diagnostics));
  check(`${name}: migrationSql`, () => deepStrictEqual(actual.migrationSql, expected.migrationSql));
  check(`${name}: pushSql`, () => deepStrictEqual(actual.pushSql, expected.pushSql));
}

// ─── Destructive-statement classification (risk / impact / marker) ──────────
//
// Golden deep-equal above already covers `risk`/`impact` byte-for-byte once
// the goldens are regenerated; these checks assert the SPECIFIC taxonomy
// decisions by name so a future emit-site regression fails with a readable
// message instead of an opaque JSON diff.

function planFor(name) {
  const { prev, next } = loadFixture(join(fixturesDir, name));
  return planMigration(prev, next);
}

function findStatement(statements, substring) {
  const stmt = statements.find((s) => s.sql.includes(substring));
  if (!stmt) throw new Error(`no statement contains "${substring}"`);
  return stmt;
}

console.log("\ndestructive-statement classification: named checks");

check("drop-table: DROP TABLE tagged requires-force", () => {
  const plan = planFor("drop-table");
  const stmt = findStatement(plan.statements, "DROP TABLE");
  deepStrictEqual(stmt.risk, "requires-force");
  deepStrictEqual(stmt.impact, "DROP TABLE Post");
});

check("drop-column: DROP COLUMN tagged requires-force", () => {
  const plan = planFor("drop-column");
  const stmt = findStatement(plan.statements, "DROP COLUMN");
  deepStrictEqual(stmt.risk, "requires-force");
  deepStrictEqual(stmt.impact, "DROP COLUMN User.email");
});

check("column-type-narrowed: ALTER COLUMN TYPE tagged requires-force", () => {
  const plan = planFor("column-type-narrowed");
  const stmt = findStatement(plan.statements, "TYPE");
  deepStrictEqual(stmt.risk, "requires-force");
  deepStrictEqual(stmt.impact, "ALTER COLUMN TYPE User.age (String → Int)");
});

check("set-not-null: SET NOT NULL requires-force, DROP NOT NULL safe", () => {
  const plan = planFor("set-not-null");
  const setStmt = findStatement(plan.statements, "SET NOT NULL");
  deepStrictEqual(setStmt.risk, "requires-force");
  deepStrictEqual(setStmt.impact, "SET NOT NULL User.nickname");
  const dropStmt = findStatement(plan.statements, "DROP NOT NULL");
  deepStrictEqual(dropStmt.risk, "safe");
  deepStrictEqual("impact" in dropStmt, false);
});

check("pk-change: DROP CONSTRAINT ..._pkey requires-force, ADD PRIMARY KEY safe", () => {
  const plan = planFor("pk-change");
  const dropStmt = findStatement(plan.statements, "DROP CONSTRAINT");
  deepStrictEqual(dropStmt.risk, "requires-force");
  deepStrictEqual(dropStmt.impact, "DROP PRIMARY KEY Item (Item_pkey)");
  const addStmt = findStatement(plan.statements, "ADD PRIMARY KEY");
  deepStrictEqual(addStmt.risk, "safe");
});

check("fk-actions-changed: DROP CONSTRAINT requires-force, ADD CONSTRAINT safe", () => {
  const plan = planFor("fk-actions-changed");
  const dropStmt = findStatement(plan.statements, "DROP CONSTRAINT");
  deepStrictEqual(dropStmt.risk, "requires-force");
  deepStrictEqual(dropStmt.impact, "DROP CONSTRAINT Post.Post_authorId_fkey");
  const addStmt = findStatement(plan.statements, "ADD CONSTRAINT");
  deepStrictEqual(addStmt.risk, "safe");
});

check("every statement in purely-additive fixtures is safe", () => {
  for (const name of [
    "optional-column-added",
    "enum-add-value",
    "index-method-added",
    "index-name-added",
  ]) {
    const plan = planFor(name);
    for (const stmt of plan.statements) {
      if (stmt.risk !== "safe") {
        throw new Error(`${name}: expected every statement safe, got "${stmt.risk}" for: ${stmt.sql}`);
      }
    }
  }
});

check("renderMigrationSql: marker line directly above each requires-force statement, nowhere else", () => {
  const plan = planFor("drop-column");
  const sql = renderMigrationSql(plan);
  const lines = sql.split("\n");
  const forcedStatements = plan.statements.filter((s) => s.risk === "requires-force");
  deepStrictEqual(forcedStatements.length > 0, true);
  for (const stmt of forcedStatements) {
    const stmtLineIndex = lines.findIndex((l) => l === stmt.sql);
    if (stmtLineIndex < 0) throw new Error(`statement not found verbatim in rendered sql: ${stmt.sql}`);
    deepStrictEqual(lines[stmtLineIndex - 1], `${REQUIRES_FORCE_MARKER}${stmt.impact}`);
  }
  const markerCount = lines.filter((l) => l.startsWith(REQUIRES_FORCE_MARKER)).length;
  deepStrictEqual(markerCount, forcedStatements.length);
});

check("scanRequiresForce: round-trips rendered impacts in file order", () => {
  const plan = planFor("set-not-null");
  const sql = renderMigrationSql(plan);
  const expectedImpacts = plan.statements
    .filter((s) => s.risk === "requires-force")
    .map((s) => s.impact);
  deepStrictEqual(scanRequiresForce(sql), expectedImpacts);
});

check("scanRequiresForce: legacy file with no marker returns []", () => {
  const sql = '-- Generated by IndigoDB migrate (PostgreSQL)\n\nALTER TABLE "Post" ADD COLUMN "slug" text;\n';
  deepStrictEqual(scanRequiresForce(sql), []);
});

check("not-null-no-default: still a diagnostic, still zero statements (unreachable requires-force scenario)", () => {
  const plan = planFor("not-null-no-default");
  deepStrictEqual(plan.statements, []);
  deepStrictEqual(plan.diagnostics.length, 1);
  deepStrictEqual(plan.diagnostics[0].code, "required-column-without-default");
});

// ─── splitMigrationSql — direct unit coverage ────────────────────────────────
//
// Not exercised through a golden fixture: no plan produced in this slice
// ever tags a statement `"pre-transaction"` (that starts in PR2, with enum
// `ADD VALUE`), so these prove the contract directly against synthetic
// input built from the exact marker text `renderMigrationSql` emits.

console.log("\nsplitMigrationSql: unit cases");

check("no marker block: transactional is returned byte-identical, no pre-transaction", () => {
  const sql =
    '-- Generated by IndigoDB migrate (PostgreSQL)\n\nALTER TABLE "Post" ADD COLUMN "slug" text;\n';
  const result = splitMigrationSql(sql);
  deepStrictEqual(result.preTransaction, []);
  deepStrictEqual(result.transactional, sql);
});

check("one marker block: statement extracted, comment stripped, block excluded from transactional", () => {
  const sql = [
    "-- Generated by IndigoDB migrate (PostgreSQL)",
    "",
    "-- indigo:begin no-transaction",
    "-- PostgreSQL cannot apply this statement inside a transaction block.",
    "ALTER TYPE \"Status\" ADD VALUE IF NOT EXISTS 'pending';",
    "-- indigo:end no-transaction",
    "",
    'ALTER TABLE "Post" ADD COLUMN "slug" text;',
    "",
  ].join("\n");
  const result = splitMigrationSql(sql);
  deepStrictEqual(result.preTransaction, ["ALTER TYPE \"Status\" ADD VALUE IF NOT EXISTS 'pending';"]);
  deepStrictEqual(
    result.transactional,
    '-- Generated by IndigoDB migrate (PostgreSQL)\n\nALTER TABLE "Post" ADD COLUMN "slug" text;\n',
  );
});

check("empty sql: both empty, no crash on the no-changes case", () => {
  const result = splitMigrationSql("");
  deepStrictEqual(result.preTransaction, []);
  deepStrictEqual(result.transactional, "");
});

check(
  "marker block is the LAST block (single-statement migration): still detected, not swallowed by the file's trailing newline",
  () => {
    const sql = [
      "-- Generated by IndigoDB migrate (PostgreSQL)",
      "",
      "-- indigo:begin no-transaction",
      "ALTER TYPE \"Status\" ADD VALUE IF NOT EXISTS 'PENDING';",
      "-- indigo:end no-transaction",
      "",
    ].join("\n");
    const result = splitMigrationSql(sql);
    deepStrictEqual(result.preTransaction, ["ALTER TYPE \"Status\" ADD VALUE IF NOT EXISTS 'PENDING';"]);
    deepStrictEqual(result.transactional, "-- Generated by IndigoDB migrate (PostgreSQL)");
  },
);

if (failures > 0) {
  console.error(`\nmigrator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator regression: all green");
