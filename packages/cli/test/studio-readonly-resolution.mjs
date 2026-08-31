/**
 * @indigodb/cli — `resolveStudioReadOnly`/`isReadOnlyEnv` resolution suite.
 *
 * Closes the coverage gap identified by `sdd-verify` for the
 * `studio-readonly-mode` change: the `studio` command's `--read-only`
 * option and `INDIGODB_STUDIO_READONLY` env resolution
 * (`packages/cli/src/index.ts`) were never exercised at runtime by
 * `studio-readonly.mjs`, which drives `startStudio()` directly with a
 * boolean and bypasses this resolution path entirely.
 *
 * Plain Node, no test framework (mirrors `studio-auth-preflight.mjs`).
 * Exercises the exported pure resolver — the exact logic `index.ts`'s
 * `studio` action runs after `loadEnv()` — rather than spawning the built
 * CLI, keeping this fast and dependency-free like its siblings.
 */

import { strictEqual } from "node:assert";
import { isReadOnlyEnv, resolveStudioReadOnly } from "../dist/util.js";

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

console.log("cli isReadOnlyEnv / resolveStudioReadOnly: resolution suite");

// ─── isReadOnlyEnv: exact-match only, no fuzzy truthy coercion ─────────────

check('isReadOnlyEnv("1") -> true', () => {
  strictEqual(isReadOnlyEnv("1"), true);
});

check('isReadOnlyEnv("true") -> true', () => {
  strictEqual(isReadOnlyEnv("true"), true);
});

check("isReadOnlyEnv(undefined) -> false", () => {
  strictEqual(isReadOnlyEnv(undefined), false);
});

for (const malformed of ["TRUE", "True", "yes", "0", "false", "", " 1 ", "1.0", "on"]) {
  check(`isReadOnlyEnv(${JSON.stringify(malformed)}) -> false (malformed, no coercion)`, () => {
    strictEqual(isReadOnlyEnv(malformed), false);
  });
}

// ─── resolveStudioReadOnly: --read-only flag OR exact-match env var ────────

check("resolveStudioReadOnly(true, undefined) -> true (flag alone enables)", () => {
  strictEqual(resolveStudioReadOnly(true, undefined), true);
});

check('resolveStudioReadOnly(undefined, "1") -> true (env alone enables)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "1"), true);
});

check('resolveStudioReadOnly(undefined, "true") -> true (env alone enables)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "true"), true);
});

check('resolveStudioReadOnly(false, "1") -> true (env still enables even when flag is explicitly false)', () => {
  strictEqual(resolveStudioReadOnly(false, "1"), true);
});

check("resolveStudioReadOnly(undefined, undefined) -> false (default off)", () => {
  strictEqual(resolveStudioReadOnly(undefined, undefined), false);
});

check("resolveStudioReadOnly(false, undefined) -> false", () => {
  strictEqual(resolveStudioReadOnly(false, undefined), false);
});

for (const malformed of ["TRUE", "yes", "0", "false", "", " 1 "]) {
  check(
    `resolveStudioReadOnly(undefined, ${JSON.stringify(malformed)}) -> false (malformed env does not enable read-only mode)`,
    () => {
      strictEqual(resolveStudioReadOnly(undefined, malformed), false);
    },
  );
}

if (failures > 0) {
  console.error(`\ncli isReadOnlyEnv / resolveStudioReadOnly: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli isReadOnlyEnv / resolveStudioReadOnly: all green");
