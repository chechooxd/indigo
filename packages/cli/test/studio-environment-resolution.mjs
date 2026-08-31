/**
 * @indigodb/cli — `resolveStudioEnvironment` resolution suite.
 *
 * Plain Node, no test framework (mirrors `studio-readonly-resolution.mjs`
 * and `studio-query-resolution.mjs`). Exercises the exported pure resolver —
 * the exact logic `index.ts`'s `studio` action runs after `loadEnv()` — for
 * design rows 1–13.
 */

import { strictEqual, throws } from "node:assert";
import { resolveStudioEnvironment } from "../dist/util.js";

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

console.log("cli resolveStudioEnvironment: resolution suite");

// ─── Precedence (rows 1–3) ──────────────────────────────────────────────────

check("row 1: --env beats INDIGODB_ENV when both are set", () => {
  strictEqual(resolveStudioEnvironment("production", "staging"), "production");
});

check("row 2: INDIGODB_ENV used when the flag is absent", () => {
  strictEqual(resolveStudioEnvironment(undefined, "staging"), "staging");
});

check("row 3: both absent -> undefined (never \"development\")", () => {
  strictEqual(resolveStudioEnvironment(undefined, undefined), undefined);
});

// ─── Recognised labels accepted verbatim (rows 4–6) ────────────────────────

check('row 4: "production" accepted verbatim', () => {
  strictEqual(resolveStudioEnvironment("production", undefined), "production");
});

check('row 5: "staging" accepted verbatim', () => {
  strictEqual(resolveStudioEnvironment("staging", undefined), "staging");
});

check('row 6: "development" accepted verbatim', () => {
  strictEqual(resolveStudioEnvironment("development", undefined), "development");
});

// ─── Open label set (row 7) ─────────────────────────────────────────────────

check('row 7: "qa" (unrecognised but valid) accepted, not thrown', () => {
  strictEqual(resolveStudioEnvironment("qa", undefined), "qa");
});

// ─── Structurally invalid: empty / whitespace-only (rows 8–9) ──────────────

check('row 8: "" throws, naming --env', () => {
  throws(() => resolveStudioEnvironment("", undefined), /--env/);
});

check('row 8: "" throws, naming INDIGODB_ENV (env path)', () => {
  throws(() => resolveStudioEnvironment(undefined, ""), /INDIGODB_ENV/);
});

check('row 9: "   " (whitespace-only) throws', () => {
  throws(() => resolveStudioEnvironment("   ", undefined), /--env/);
});

// ─── Length boundary (row 10) ───────────────────────────────────────────────

check("row 10: 33 chars throws", () => {
  throws(() => resolveStudioEnvironment("a".repeat(33), undefined));
});

check("row 10: exactly 32 chars accepted (inclusive boundary)", () => {
  const label = "a".repeat(32);
  strictEqual(resolveStudioEnvironment(label, undefined), label);
});

// ─── Interior control characters (row 11) ───────────────────────────────────

check("row 11: interior newline throws", () => {
  throws(() => resolveStudioEnvironment("prod\nuction", undefined));
});

check("row 11: interior tab throws", () => {
  throws(() => resolveStudioEnvironment("prod\tuction", undefined));
});

// ─── Trim (row 12) ───────────────────────────────────────────────────────────

check('row 12: " staging " -> "staging" (trim applied)', () => {
  strictEqual(resolveStudioEnvironment(" staging ", undefined), "staging");
});

// ─── Verbatim casing (row 13) ────────────────────────────────────────────────

check('row 13: "Production" accepted and returned as "Production" (verbatim, not lowered)', () => {
  strictEqual(resolveStudioEnvironment("Production", undefined), "Production");
});

if (failures > 0) {
  console.error(`\ncli resolveStudioEnvironment: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli resolveStudioEnvironment: all green");
