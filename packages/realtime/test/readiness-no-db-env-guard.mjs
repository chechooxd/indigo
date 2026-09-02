/**
 * RWS-10b — readiness tests must pass without `INDIGODB_TEST_DATABASE_URL`.
 *
 * Executable, not prose: asserts neither readiness suite references the
 * DB-gating env var at all, so a future edit that silently makes one of
 * them DB-gated (and therefore SKIP by default, shrinking default-checkout
 * coverage without failing anything) is caught here instead.
 *
 * Implemented as a `readFileSync` string search rather than shelling out to
 * `rg` — same substitution already made for RSC-11b in
 * `source-contract.mjs` (an external binary dependency inside a test isn't
 * this repo's convention, and a plain string search is exactly as
 * RED-sensitive for "does this file contain that literal string").
 */
import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// The two suites that must keep running unconditionally in a default
// checkout (RWS-10): the WalSource unit/integration suite and the
// seam-level contract suite.
const READINESS_FILES = ["wal-source.mjs", "source-contract.mjs"];

for (const file of READINESS_FILES) {
  await check(`RWS-10b: ${file} does not reference INDIGODB_TEST_DATABASE_URL`, () => {
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
    const source = readFileSync(path, "utf8");
    ok(
      !source.includes("INDIGODB_TEST_DATABASE_URL"),
      `${file} must stay DB-independent — it must never reference INDIGODB_TEST_DATABASE_URL`,
    );
  });
}

console.log(`\n${passed} passed`);
strictEqual(
  passed,
  READINESS_FILES.length,
  `expected exactly ${READINESS_FILES.length} checks to pass — an omitted or silently-skipped case must shrink this count and fail loudly`,
);
if (process.exitCode) process.exit(process.exitCode);
