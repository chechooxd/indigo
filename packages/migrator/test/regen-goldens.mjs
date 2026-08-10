/**
 * Regenerates the golden `expected.json` files in `test/fixtures/` from the
 * current migrator output. Run ONLY after an INTENTIONAL contract or
 * behaviour change — the diff between old and new golden IS the review
 * artifact (see the migration-golden-tests spec).
 */

import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { computeActual } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const cases = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const name of cases) {
  const dir = join(fixturesDir, name);
  const actual = computeActual(dir);
  writeFileSync(join(dir, "expected.json"), JSON.stringify(actual, null, 2) + "\n");
  console.log("golden:", name);
}
