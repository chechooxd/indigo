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
import { computeActual } from "./lib.mjs";

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
  check(`${name}: migrationSql`, () => deepStrictEqual(actual.migrationSql, expected.migrationSql));
  check(`${name}: pushSql`, () => deepStrictEqual(actual.pushSql, expected.pushSql));
}

if (failures > 0) {
  console.error(`\nmigrator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator regression: all green");
