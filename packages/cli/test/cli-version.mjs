import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgRoot = join(import.meta.dirname, "..");
const expectedVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
const cliEntry = join(pkgRoot, "dist", "index.js");

const output = execFileSync(process.execPath, [cliEntry, "--version"], {
  encoding: "utf8",
}).trim();

assert.equal(
  output,
  expectedVersion,
  `indigodb --version (${output}) must match packages/cli/package.json (${expectedVersion})`,
);

console.log(`cli-version: OK (${output})`);
