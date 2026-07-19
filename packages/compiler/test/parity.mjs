/**
 * TS↔Rust parity harness — the merge gate for the compiler port.
 *
 * Runs the legacy pipeline (Chevrotain parse + TS resolve/validate) and the
 * WASM pipeline over every fixture in fixtures/, deep-comparing AST,
 * ResolvedSchema and ValidationError[] after JSON normalization. For error
 * fixtures it compares failure/failure and the first error's line (message
 * texts intentionally differ — Rust's are better).
 *
 * Works before AND after the switch: prefers the `legacy/` builds of parser
 * and core when they exist (post-switch), else uses their main dist
 * (pre-switch, when they still ARE the legacy implementation).
 */

import { readdirSync, readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../../../fixtures");

async function importFirst(paths) {
  for (const p of paths) {
    try {
      return await import(p);
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    }
  }
  throw new Error(`none of the candidate modules exist: ${paths.join(", ")}`);
}

const legacyParser = await importFirst([
  "../../parser/dist/legacy/index.js",
  "../../parser/dist/index.js",
]);
const legacyCore = await importFirst([
  "../../core/dist/legacy/index.js",
  "../../core/dist/index.js",
]);
const wasm = await import("../dist/index.node.js");

const norm = (x) => JSON.parse(JSON.stringify(x));

function legacyPipeline(source) {
  try {
    const schema = legacyParser.parse(source);
    return {
      schema: norm(schema),
      resolved: norm(legacyCore.resolve(schema)),
      validation: norm(legacyCore.validate(schema)),
    };
  } catch (err) {
    if (err.name === "IndigoParseError") return { parseErrors: norm(err.errors) };
    throw err;
  }
}

function wasmPipeline(source) {
  const r = wasm.parseSchema(source);
  if ("errors" in r) return { parseErrors: norm(r.errors) };
  return {
    schema: norm(r.schema),
    resolved: norm(wasm.resolveSchema(r.schema)),
    validation: norm(wasm.validateSchema(r.schema)),
  };
}

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
console.log(`parity: ${valid.length} valid fixtures`);
for (const file of valid) {
  const source = readFileSync(join(fixturesDir, file), "utf8");
  const legacy = legacyPipeline(source);
  const rust = wasmPipeline(source);
  check(`${file} parses in both`, () => {
    if ("parseErrors" in legacy) throw new Error(`legacy failed: ${JSON.stringify(legacy.parseErrors)}`);
    if ("parseErrors" in rust) throw new Error(`rust failed: ${JSON.stringify(rust.parseErrors)}`);
  });
  if ("parseErrors" in legacy || "parseErrors" in rust) continue;
  check(`${file} AST`, () => deepStrictEqual(rust.schema, legacy.schema));
  check(`${file} ResolvedSchema`, () => deepStrictEqual(rust.resolved, legacy.resolved));
  check(`${file} ValidationError[]`, () => deepStrictEqual(rust.validation, legacy.validation));
}

const errorsDir = join(fixturesDir, "errors");
const errorFixtures = readdirSync(errorsDir).filter((f) => f.endsWith(".indigo")).sort();
console.log(`parity: ${errorFixtures.length} error fixtures`);
for (const file of errorFixtures) {
  const source = readFileSync(join(errorsDir, file), "utf8");
  const legacy = legacyPipeline(source);
  const rust = wasmPipeline(source);
  check(`errors/${file} fails in both`, () => {
    if (!("parseErrors" in legacy)) throw new Error("legacy parsed successfully");
    if (!("parseErrors" in rust)) throw new Error("rust parsed successfully");
    const legacyLine = legacy.parseErrors[0]?.line;
    const rustLine = rust.parseErrors[0]?.line;
    if (legacyLine != null && legacyLine !== rustLine) {
      throw new Error(`first error line: legacy=${legacyLine} rust=${rustLine}`);
    }
  });
}

if (failures > 0) {
  console.error(`\nparity: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nparity: all green");
