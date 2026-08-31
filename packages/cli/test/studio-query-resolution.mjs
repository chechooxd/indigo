/**
 * @indigodb/cli — query guardrail resolution suite.
 *
 * Plain Node, no test framework (mirrors `studio-readonly-resolution.mjs`).
 * Exercises the exported pure resolvers, preamble builder, and cursor
 * eligibility classifier directly — the exact logic `index.ts`'s `studio`
 * action and `studio-server.ts`'s `/api/query` handler run — rather than
 * spawning the built CLI or a real database.
 */

import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { parseGuardrailInt, resolveQueryTimeoutMs, resolveQueryRowCap } from "../dist/util.js";
import { readOnlyPreamble, isCursorEligible } from "../dist/studio-server.js";

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

console.log("cli query guardrail resolution: resolution suite");

// ─── parseGuardrailInt: exact-match digits only ────────────────────────────

check('parseGuardrailInt("1000") -> 1000', () => {
  strictEqual(parseGuardrailInt("1000"), 1000);
});

check('parseGuardrailInt("0") -> 0', () => {
  strictEqual(parseGuardrailInt("0"), 0);
});

check("parseGuardrailInt(undefined) -> null", () => {
  strictEqual(parseGuardrailInt(undefined), null);
});

for (const malformed of ["abc", "-1", "1.5", " 100 ", "", "1e3", "Infinity"]) {
  check(`parseGuardrailInt(${JSON.stringify(malformed)}) -> null (malformed, no coercion)`, () => {
    strictEqual(parseGuardrailInt(malformed), null);
  });
}

// ─── resolveQueryTimeoutMs / resolveQueryRowCap: flag > env > default ──────

check("resolveQueryTimeoutMs: flag takes precedence over env", () => {
  strictEqual(resolveQueryTimeoutMs("9000", "5000"), 9000);
});

check("resolveQueryRowCap: flag takes precedence over env", () => {
  strictEqual(resolveQueryRowCap("50", "250"), 50);
});

check("resolveQueryTimeoutMs: env used when flag absent", () => {
  strictEqual(resolveQueryTimeoutMs(undefined, "5000"), 5000);
});

check("resolveQueryRowCap: env used when flag absent", () => {
  strictEqual(resolveQueryRowCap(undefined, "250"), 250);
});

check("resolveQueryTimeoutMs: falls back to built-in default (30000) when both absent", () => {
  strictEqual(resolveQueryTimeoutMs(undefined, undefined), 30000);
});

check("resolveQueryRowCap: falls back to built-in default (1000) when both absent", () => {
  strictEqual(resolveQueryRowCap(undefined, undefined), 1000);
});

// ─── 0 is the disabled sentinel for both ───────────────────────────────────

check("resolveQueryTimeoutMs: flag '0' disables the guardrail (returns 0)", () => {
  strictEqual(resolveQueryTimeoutMs("0", undefined), 0);
});

check("resolveQueryRowCap: env '0' disables the guardrail (returns 0)", () => {
  strictEqual(resolveQueryRowCap(undefined, "0"), 0);
});

// ─── Malformed values throw, naming the offending flag ─────────────────────

for (const malformed of ["abc", "-1", "1.5", " 100 ", "", "1e3", "Infinity"]) {
  check(`resolveQueryTimeoutMs(${JSON.stringify(malformed)}, undefined) throws naming --query-timeout`, () => {
    throws(() => resolveQueryTimeoutMs(malformed, undefined), /--query-timeout/);
  });
  check(`resolveQueryRowCap(${JSON.stringify(malformed)}, undefined) throws naming --query-row-cap`, () => {
    throws(() => resolveQueryRowCap(malformed, undefined), /--query-row-cap/);
  });
}

check("resolveQueryTimeoutMs: malformed env (flag absent) throws naming INDIGODB_STUDIO_QUERY_TIMEOUT_MS", () => {
  throws(() => resolveQueryTimeoutMs(undefined, "abc"), /INDIGODB_STUDIO_QUERY_TIMEOUT_MS/);
});

check("resolveQueryRowCap: malformed env (flag absent) throws naming INDIGODB_STUDIO_QUERY_ROW_CAP", () => {
  throws(() => resolveQueryRowCap(undefined, "-1"), /INDIGODB_STUDIO_QUERY_ROW_CAP/);
});

// ─── readOnlyPreamble ───────────────────────────────────────────────────────

check("readOnlyPreamble(30000) -> READ ONLY + SET LOCAL statement_timeout = 30000", () => {
  deepStrictEqual(readOnlyPreamble(30000), [
    "SET TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout = 30000",
  ]);
});

check("readOnlyPreamble(0) still emits the 0 form (no special-casing)", () => {
  deepStrictEqual(readOnlyPreamble(0), [
    "SET TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout = 0",
  ]);
});

// ─── isCursorEligible: capability classifier, fail-open ────────────────────

for (const eligible of [
  "SELECT * FROM t",
  "select * from t",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "TABLE t",
  "VALUES (1)",
  "  \n  SELECT 1",
  "-- a leading comment\nSELECT 1",
  "/* block comment */ SELECT 1",
  "(SELECT 1)",
  "((SELECT 1))",
  "Select 1",
]) {
  check(`isCursorEligible(${JSON.stringify(eligible)}) -> true`, () => {
    strictEqual(isCursorEligible(eligible), true);
  });
}

for (const ineligible of ["EXPLAIN SELECT 1", "SHOW server_version", "DELETE FROM t", "INSERT INTO t VALUES (1)"]) {
  check(`isCursorEligible(${JSON.stringify(ineligible)}) -> false`, () => {
    strictEqual(isCursorEligible(ineligible), false);
  });
}

if (failures > 0) {
  console.error(`\ncli query guardrail resolution: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli query guardrail resolution: all green");
