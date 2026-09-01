/**
 * `realtime-column-projection` reachability guard (RCP-13, tasks.md 5.2).
 *
 * Every scenario in this capability's tests MUST pass in a default checkout
 * (`INDIGODB_TEST_DATABASE_URL` unset) — a DB-gated-only test for a secrets
 * leak is worse than none. This script asserts the new/modified realtime
 * projection test files contain NO reference to `INDIGODB_TEST_DATABASE_URL`
 * at all, so this guarantee cannot silently regress into a skip-by-default
 * check later. Run from the repo root; exits non-zero on a violation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUARDED_FILES = [
  "packages/realtime/test/wal-source.mjs",
  "packages/realtime/test/dispatch.mjs",
  "packages/client/test/realtime-projection.mjs",
];

const NEEDLE = "INDIGODB_TEST_DATABASE_URL";

let failed = false;
for (const relPath of GUARDED_FILES) {
  const absPath = join(repoRoot, relPath);
  const contents = readFileSync(absPath, "utf8");
  if (contents.includes(NEEDLE)) {
    failed = true;
    console.error(
      `FAIL: ${relPath} references ${NEEDLE} — this file must run unconditionally in a default checkout (RCP-13).`,
    );
  } else {
    console.log(`ok - ${relPath} carries no ${NEEDLE} reference`);
  }
}

if (failed) {
  console.error("\ncheck-realtime-projection-db-gate: FAILED");
  process.exit(1);
}
console.log("\ncheck-realtime-projection-db-gate: PASSED");
