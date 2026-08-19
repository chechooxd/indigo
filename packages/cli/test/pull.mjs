/**
 * @indigodb/cli — `db pull` suite.
 *
 * Mirrors `studio-server.mjs`'s style: plain Node, no test framework.
 *
 * `resolveBareConnectionString` and `writePulledSchema` are exercised
 * directly (no real DB connection needed here — that proof lives in
 * `packages/migrator/test/pull-roundtrip.mjs`, the real PGlite-backed
 * introspect -> print -> parse -> resolve -> planMigration cycle). This
 * suite covers connection-resolution precedence, output-path resolution,
 * unconditional overwrite with a visible warning, `--print` writing
 * nothing to disk, the never-write-credentials datasource synthesis, and
 * the FK-comments-not-regenerated-by-migrate-dev banner.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictEqual, ok, notStrictEqual } from "node:assert";
import { parse, resolve as resolveSchema } from "@indigodb/core";
import { resolveBareConnectionString, writePulledSchema } from "../dist/util.js";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli db pull: connection resolution + write-path suite");

/** Builds a minimal resolved schema (no datasource) for write-path tests. */
function minimalResolved() {
  const source = `Table User {\n  id Int @id @default(autoincrement())\n  name String\n}\n`;
  return resolveSchema(parse(source));
}

/** Captures stdout `console.log` calls for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// ─── connection resolution precedence ────────────────────────────────────────

await check("--url wins over DATABASE_URL", () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://env-wins-should-not/db";
  try {
    const result = resolveBareConnectionString({ url: "postgres://flag-wins/db" });
    strictEqual(result, "postgres://flag-wins/db");
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

await check("DATABASE_URL used when --url absent", () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://from-env/db";
  try {
    const result = resolveBareConnectionString({});
    strictEqual(result, "postgres://from-env/db");
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

await check("neither --url nor DATABASE_URL: exits 1 naming both missing inputs", () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const prevExit = process.exit;
  const prevError = console.error;
  const errors = [];
  let exitCode;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  console.error = (...args) => errors.push(args.join(" "));
  try {
    try {
      resolveBareConnectionString({});
    } catch (err) {
      if (err.message !== "__exit__") throw err;
    }
    strictEqual(exitCode, 1);
    ok(
      errors.some((l) => l.includes("--url") && l.includes("DATABASE_URL")),
      `expected an error naming both --url and DATABASE_URL, got: ${errors.join("\n")}`,
    );
  } finally {
    process.exit = prevExit;
    console.error = prevError;
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

// ─── output path resolution ──────────────────────────────────────────────────

await check("default output path: writes to schema.indigo in the target dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const result = writePulledSchema(minimalResolved(), { schema: target });
    strictEqual(result.path, target);
    ok(existsSync(target), "expected schema.indigo to be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("custom --schema path: writes to the given path, creating parent dirs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "custom", "path.indigo");
    const result = writePulledSchema(minimalResolved(), { schema: target });
    strictEqual(result.path, target);
    ok(existsSync(target), "expected custom/path.indigo to be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── never write credentials ──────────────────────────────────────────────────

await check("datasource always prints as env(\"DATABASE_URL\"), never a literal credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const resolved = minimalResolved();
    const result = writePulledSchema(resolved, { schema: target });
    ok(result.text.includes('url = env("DATABASE_URL")'), "expected env(DATABASE_URL) datasource");
    ok(!result.text.includes("postgres://"), "expected no literal connection string in the output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── overwrite by default ────────────────────────────────────────────────────

await check("existing schema.indigo is overwritten silently, with a visible warning log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    writeFileSync(target, "// old content\n");

    const logs = await captureLogs(() => {
      const result = writePulledSchema(minimalResolved(), { schema: target });
      ok(result.overwrote, "expected overwrote: true");
    });

    const written = readFileSync(target, "utf-8");
    notStrictEqual(written, "// old content\n");
    ok(
      logs.some((l) => l.includes("Overwrote") && l.includes(target)),
      `expected an overwrite warning log line, got: ${logs.join("\n")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("no existing file: overwrote is false, no overwrite warning logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const logs = await captureLogs(() => {
      const result = writePulledSchema(minimalResolved(), { schema: target });
      strictEqual(result.overwrote, false);
    });
    ok(!logs.some((l) => l.includes("Overwrote")), "did not expect an overwrite warning line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── --print writes nothing to disk ──────────────────────────────────────────

await check("--print: writes nothing to disk, output goes to stdout only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const logs = await captureLogs(() => {
      const result = writePulledSchema(minimalResolved(), { schema: target, print: true });
      strictEqual(result.path, undefined);
      ok(result.text.length > 0);
    });
    ok(!existsSync(target), "expected --print to write no file");
    ok(logs.some((l) => l.includes("Table User")), "expected the schema text printed to stdout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── FK-not-regenerated-by-migrate-dev warning banner ────────────────────────

await check("successful (non-print) pull logs the FK-comments warning banner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const logs = await captureLogs(() => {
      writePulledSchema(minimalResolved(), { schema: target });
    });
    ok(
      logs.some((l) => l.includes("migrate dev") && l.toLowerCase().includes("foreign key")),
      `expected an FK/migrate dev warning banner, got: ${logs.join("\n")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("--print: does NOT log the FK warning banner (no write happened)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-pull-"));
  try {
    const target = join(dir, "schema.indigo");
    const logs = await captureLogs(() => {
      writePulledSchema(minimalResolved(), { schema: target, print: true });
    });
    ok(!logs.some((l) => l.includes("migrate dev")), "did not expect the FK warning banner on --print");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.error(`\ncli db pull: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli db pull: all green");
