/**
 * @indigodb/cli — `resolveStudioReadOnly` resolution suite.
 *
 * `isReadOnlyEnv` no longer exists: its lenient exact-match-or-false shape
 * was absorbed into `resolveStudioReadOnly`, whose env branch now mirrors
 * `resolveStudioAuditLog`'s accepted-set shape (`"1"`/`"true"` enable,
 * `"0"`/`"false"` disable, anything else throws) instead of silently
 * leaving read-only off on a malformed value — see design.md for
 * `studio-readonly-env-strictness`.
 *
 * Plain Node, no test framework (mirrors `studio-audit-preflight.mjs`).
 * Exercises the exported pure resolver directly for most checks — the
 * exact logic `index.ts`'s `studio` action runs after `loadEnv()` — plus
 * one `spawnSync` check that runs the built CLI end-to-end, because the
 * resolver throwing is inert unless `index.ts` actually catches it.
 */

import { strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStudioReadOnly } from "../dist/util.js";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli resolveStudioReadOnly: resolution suite");

// ─── Exact-match "on" env values enable ────────────────────────────────────

check('resolveStudioReadOnly(undefined, "1") -> true (env alone enables)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "1"), true);
});

check('resolveStudioReadOnly(undefined, "true") -> true (env alone enables)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "true"), true);
});

check("resolveStudioReadOnly(undefined, undefined) -> false (unset env, no flag, default off)", () => {
  strictEqual(resolveStudioReadOnly(undefined, undefined), false);
});

// ─── Exact-match "off" env values keep read-only disabled (accepted-disable, unchanged) ───

check('resolveStudioReadOnly(undefined, "0") -> false (accepted-disable)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "0"), false);
});

check('resolveStudioReadOnly(undefined, "false") -> false (accepted-disable)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "false"), false);
});

// ─── Malformed env values THROW (no fuzzy truthy coercion) ────────────────

for (const malformed of ["TRUE", "True", "yes", "", " 1 ", "1.0", "on"]) {
  check(
    `resolveStudioReadOnly(undefined, ${JSON.stringify(malformed)}) -> throws (malformed, rejected)`,
    () => {
      throws(() => resolveStudioReadOnly(undefined, malformed), /INDIGODB_STUDIO_READONLY/);
    },
  );
}

check("rejection message names all four accepted values", () => {
  throws(() => resolveStudioReadOnly(undefined, "yes"), /must be "1", "0", "true", or "false"/);
});

check("rejection message echoes the offending value quoted via JSON.stringify", () => {
  throws(() => resolveStudioReadOnly(undefined, " 1 "), /" 1 "/);
});

// ─── resolveStudioReadOnly: --read-only flag OR exact-match env var ────────

check("resolveStudioReadOnly(true, undefined) -> true (flag alone enables)", () => {
  strictEqual(resolveStudioReadOnly(true, undefined), true);
});

check('resolveStudioReadOnly(undefined, "1") -> true (env alone enables, combo set)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "1"), true);
});

check('resolveStudioReadOnly(undefined, "true") -> true (env alone enables, combo set)', () => {
  strictEqual(resolveStudioReadOnly(undefined, "true"), true);
});

check('resolveStudioReadOnly(false, "1") -> true (env still enables even when flag is explicitly false)', () => {
  strictEqual(resolveStudioReadOnly(false, "1"), true);
});

check("resolveStudioReadOnly(undefined, undefined) -> false (combo set)", () => {
  strictEqual(resolveStudioReadOnly(undefined, undefined), false);
});

check("resolveStudioReadOnly(false, undefined) -> false", () => {
  strictEqual(resolveStudioReadOnly(false, undefined), false);
});

// ─── The flag never suppresses env validation ──────────────────────────────

check("resolveStudioReadOnly(true, \"yes\") -> throws (flag never suppresses a malformed env)", () => {
  throws(() => resolveStudioReadOnly(true, "yes"), /INDIGODB_STUDIO_READONLY/);
});

// ─── `isReadOnlyEnv` no longer exported ────────────────────────────────────

await checkAsync("isReadOnlyEnv is no longer exported from util.js", async () => {
  const m = await import("../dist/util.js");
  strictEqual(m.isReadOnlyEnv, undefined);
});

// ─── Wiring: a malformed env var exits 1 before Studio binds to a port ────
//
// No existing file under packages/cli/test spawns the built CLI — this is a
// new pattern, required here because the resolver throwing is inert unless
// index.ts's `studio` action actually catches it inside its try/catch. Runs
// in an empty temp cwd so `loadEnv()` cannot pick up a stray `.env`, and
// relies on `assertStudioAuthForHost` passing silently on the default
// loopback host plus the try/catch preceding `loadSchema` so this needs no
// schema file, no `.env`, and no database.

const cliDistDir = fileURLToPath(new URL("../dist", import.meta.url));
const cliEntry = join(cliDistDir, "index.js");
const tmpCwd = mkdtempSync(join(tmpdir(), "indigodb-studio-readonly-wiring-"));

try {
  check("malformed INDIGODB_STUDIO_READONLY exits non-zero before binding", () => {
    const result = spawnSync(process.execPath, [cliEntry, "studio"], {
      cwd: tmpCwd,
      env: { ...process.env, INDIGODB_STUDIO_READONLY: "yes" },
      encoding: "utf-8",
    });
    strictEqual(result.status, 1);
    if (!/INDIGODB_STUDIO_READONLY/.test(result.stderr ?? "")) {
      throw new Error(`expected stderr to mention INDIGODB_STUDIO_READONLY, got: ${result.stderr}`);
    }
  });
} finally {
  rmSync(tmpCwd, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncli resolveStudioReadOnly: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli resolveStudioReadOnly: all green");
