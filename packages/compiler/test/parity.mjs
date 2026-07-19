/**
 * Compiler regression harness.
 *
 * During the Rust port this file compared the legacy Chevrotain/TS pipeline
 * against the WASM one (100% green before the switch). The legacy
 * implementation is gone now; the reference is the golden snapshots in
 * fixtures/snapshots/, frozen from that parity-verified output.
 *
 * Regenerate snapshots (only after an INTENTIONAL contract change):
 *   node test/regen-snapshots.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../../../fixtures");
const wasm = await import("../dist/index.node.js");

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

const valid = readdirSync(fixturesDir).filter((f) => f.endsWith(".indigo")).sort();
console.log(`regression: ${valid.length} fixtures vs golden snapshots`);
for (const file of valid) {
  const source = readFileSync(join(fixturesDir, file), "utf8");
  const golden = JSON.parse(
    readFileSync(join(fixturesDir, "snapshots", file.replace(".indigo", ".json")), "utf8"),
  );
  const r = wasm.parseSchema(source);
  check(`${file} parses`, () => {
    if ("errors" in r) throw new Error(`parse failed: ${JSON.stringify(r.errors)}`);
  });
  if ("errors" in r) continue;
  check(`${file} AST`, () => deepStrictEqual(norm(r.schema), golden.schema));
  check(`${file} ResolvedSchema`, () =>
    deepStrictEqual(norm(wasm.resolveSchema(r.schema)), golden.resolved));
  check(`${file} ValidationError[]`, () =>
    deepStrictEqual(norm(wasm.validateSchema(r.schema)), golden.validation));
}

const errorsDir = join(fixturesDir, "errors");
const errorFixtures = readdirSync(errorsDir).filter((f) => f.endsWith(".indigo")).sort();
console.log(`regression: ${errorFixtures.length} error fixtures`);
for (const file of errorFixtures) {
  const source = readFileSync(join(errorsDir, file), "utf8");
  check(`errors/${file} fails with positioned errors`, () => {
    const r = wasm.parseSchema(source);
    if (!("errors" in r)) throw new Error("parsed successfully");
    if (r.errors.length === 0) throw new Error("empty error list");
    for (const e of r.errors) {
      if (!(e.line >= 1)) throw new Error(`error without line: ${JSON.stringify(e)}`);
    }
  });
}

if (failures > 0) {
  console.error(`\nregression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nregression: all green");
