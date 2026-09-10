// Runs every test file in this directory and reports ALL of their outcomes.
//
// This package's `test` script used to be one long `&&` chain. That chain does
// not merely stop at the first failure — it hides every file after it. When
// `migrate-runner.mjs` started failing on a dangling path, the two files behind
// it in the chain never ran at all, and nothing said so: the output looked like
// a single failure when it was really one failure plus unknown evidence.
//
// A run that cannot tell you "the rest passed" from "the rest never executed"
// is not a test run. So: run every file, keep going after a failure, and print
// a summary that names each outcome.
//
// Files run sequentially, not in parallel. Several of them bind ports and stand
// up databases, and overlapping runs make failures depend on timing.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const here = import.meta.dirname;
const self = "run-all.mjs";

// `*-harness.mjs` files are shared helper modules (migrate-harness, studio-harness,
// pg-timeout-harness), not suites. Executing one directly proves nothing and can
// leave a server or database bound.
const isHarness = (name) => name.endsWith("-harness.mjs");

const files = readdirSync(here)
  .filter((name) => name.endsWith(".mjs") && name !== self && !isHarness(name))
  .sort();

if (files.length === 0) {
  console.error("run-all: no test files found — that is a bug in the runner, not a pass");
  process.exit(1);
}

/** @param {string} file */
function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: "inherit" });
    child.on("error", (error) => resolve({ file, code: 1, error: error.message }));
    child.on("close", (code, signal) =>
      resolve({ file, code: code ?? 1, signal: signal ?? undefined }),
    );
  });
}

const results = [];
for (const file of files) {
  console.log(`\n──── ${file} ────`);
  results.push(await runFile(file));
}

const failed = results.filter((result) => result.code !== 0);

console.log(`\n──── summary: ${results.length - failed.length}/${results.length} files passed ────`);
for (const result of results) {
  const status = result.code === 0 ? "pass" : "FAIL";
  const detail = result.error
    ? ` (${result.error})`
    : result.signal
      ? ` (signal ${result.signal})`
      : result.code === 0
        ? ""
        : ` (exit ${result.code})`;
  console.log(`  ${status}  ${result.file}${detail}`);
}

if (failed.length > 0) {
  console.error(`\nrun-all: ${failed.length} of ${results.length} test files failed`);
  process.exit(1);
}
