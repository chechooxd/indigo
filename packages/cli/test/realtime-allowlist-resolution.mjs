/**
 * @indigodb/cli — `resolveAllowedOrigins` resolution suite (D7, task 1.8).
 *
 * Plain Node, no test framework (mirrors `studio-environment-resolution.mjs`
 * / `studio-readonly-resolution.mjs`). Exercises the exported pure resolver
 * `index.ts`'s `realtime` and `studio` actions run after `loadEnv()`:
 * `--allow-origin` (repeatable) MERGES with the comma-separated
 * `INDIGODB_REALTIME_ALLOWED_ORIGINS` into ONE array — neither source
 * overwrites the other.
 */

import { deepStrictEqual } from "node:assert";
import { resolveAllowedOrigins } from "../dist/util.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli resolveAllowedOrigins: resolution suite");

check("both absent -> empty array (closed default)", () => {
  deepStrictEqual(resolveAllowedOrigins(undefined, undefined), []);
});

check("flag only -> the flag's origins, in order", () => {
  deepStrictEqual(
    resolveAllowedOrigins(["https://app.example.com", "https://admin.example.com"], undefined),
    ["https://app.example.com", "https://admin.example.com"],
  );
});

check("env only (comma-separated) -> split into an array", () => {
  deepStrictEqual(
    resolveAllowedOrigins(undefined, "https://app.example.com,https://admin.example.com"),
    ["https://app.example.com", "https://admin.example.com"],
  );
});

check("flag AND env both present -> MERGED into one array, neither source overwrites the other", () => {
  deepStrictEqual(
    resolveAllowedOrigins(["https://app.example.com"], "https://admin.example.com,https://ops.example.com"),
    ["https://app.example.com", "https://admin.example.com", "https://ops.example.com"],
  );
});

check("env entries are trimmed and empty segments dropped", () => {
  deepStrictEqual(
    resolveAllowedOrigins(undefined, " https://app.example.com , , https://admin.example.com "),
    ["https://app.example.com", "https://admin.example.com"],
  );
});

check("duplicate origins across flag+env are de-duplicated", () => {
  deepStrictEqual(
    resolveAllowedOrigins(["https://app.example.com"], "https://app.example.com,https://admin.example.com"),
    ["https://app.example.com", "https://admin.example.com"],
  );
});

check("empty flag array + absent env -> empty array", () => {
  deepStrictEqual(resolveAllowedOrigins([], undefined), []);
});

if (failures > 0) {
  console.error(`\ncli resolveAllowedOrigins: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli resolveAllowedOrigins: all green");
