/**
 * Fixture-based proof for the `dependency-audit-gate` capability
 * (`.githooks/pre-push`'s `pnpm audit --audit-level=high` block).
 *
 * Builds a **temp fixture workspace** — its own `package.json` + lockfile,
 * pinning a real, known-advisory dependency, with marker-only `build`/
 * `lint`/`test` scripts (each just writes a marker file) — and invokes the
 * REAL `.githooks/pre-push` against it with synthetic stdin ref lines. The
 * repo's own lockfile and dependency tree are never touched; teardown
 * removes the tempdir after each scenario.
 *
 * Needs the network (real `pnpm audit` calls). Follows the
 * `INDIGODB_TEST_DATABASE_URL` precedent (`packages/realtime/test/pg-harness.mjs`):
 * gated on an opt-in `INDIGODB_TEST_AUDIT=1` env var — unset, this prints
 * `SKIP` and exits 0, so `pnpm test` stays network-free by default.
 *
 *   INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs
 *
 * Fixture dependencies (chosen because each carries EXACTLY one advisory,
 * so `ignoreCves` proofs are unambiguous):
 *   - HIGH:     ansi-regex@3.0.0  (GHSA-93q8-gq69-wqmw, high, no critical)
 *   - MODERATE: xml2js@0.4.19     (GHSA-776f-qx25-q3cc, moderate only —
 *               negative control for `--audit-level=high`)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(repoRoot, ".githooks", "pre-push");

if (process.env.INDIGODB_TEST_AUDIT !== "1") {
  console.log(
    "SKIP - test-audit-gate: INDIGODB_TEST_AUDIT is unset — audit-gate fixture suite " +
      "skipped (needs network for real `pnpm audit` calls). Set the var for full coverage.",
  );
  process.exit(0);
}

const HIGH_DEP = { name: "ansi-regex", version: "3.0.0" };
const MODERATE_DEP = { name: "xml2js", version: "0.4.19" };
const HIGH_ADVISORY_CVE = "CVE-2021-3807"; // ansi-regex@3.0.0's one advisory

let passed = 0;
let ran = 0;
function report(name, ok, detail) {
  ran++;
  if (ok) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

function markerScript(marker) {
  return `node -e "require('fs').writeFileSync('${marker}', '1')"`;
}

/** Builds a fresh, isolated fixture workspace pinning one dependency. */
function buildFixture(dep, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "indigo-audit-fixture-"));
  const pkg = {
    name: "indigo-audit-fixture",
    version: "1.0.0",
    private: true,
    scripts: {
      build: markerScript("BUILD_MARKER"),
      lint: markerScript("LINT_MARKER"),
      test: markerScript("TEST_MARKER"),
    },
    dependencies: { [dep.name]: dep.version },
    ...extra,
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const install = spawnSync("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (install.status !== 0) {
    throw new Error(`fixture install failed in ${dir}: ${install.stderr}`);
  }
  return dir;
}

function teardown(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function clearMarkers(dir) {
  for (const m of ["BUILD_MARKER", "LINT_MARKER", "TEST_MARKER"]) {
    rmSync(join(dir, m), { force: true });
  }
}

function marker(dir, name) {
  return existsSync(join(dir, name));
}

/**
 * Runs the real `.githooks/pre-push` hook with cwd set to the fixture
 * directory (so `pnpm audit`/`build`/`lint`/`test` all act on the fixture's
 * own manifest and lockfile, never the repo's) and synthetic stdin ref
 * lines simulating what `git push` feeds a pre-push hook.
 */
function runHook(dir, { refLines, env = {} } = {}) {
  const stdin = refLines.map((l) => l.join(" ")).join("\n") + (refLines.length ? "\n" : "");
  const result = spawnSync("bash", [hookPath], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result;
}

const zero = "0".repeat(40);
const contentPush = [["refs/heads/main", "abc123", "refs/heads/main", zero]];
const deletionOnlyPush = [["refs/heads/gone", zero, "refs/heads/gone", "def456"]];
const emptyStdinPush = [];
const firstPushAllZeroRemote = [["refs/heads/main", "abc123", "refs/heads/main", zero]];

// --- Row 1: high advisory × content push → exit 1, build marker absent ---
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, { refLines: contentPush });
    report(
      "row 1: high advisory + content push aborts before build",
      res.status !== 0 && !marker(dir, "BUILD_MARKER"),
      `exit=${res.status} buildMarker=${marker(dir, "BUILD_MARKER")}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 2: high advisory × deletion-only refs → exit 0, audit never runs ---
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, { refLines: deletionOnlyPush });
    const skippedCleanly = res.status === 0 && /nothing to verify/.test(res.stdout);
    report(
      "row 2: high advisory + deletion-only refs short-circuits before audit",
      skippedCleanly,
      `exit=${res.status} stdout=${res.stdout.trim()}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 3: high advisory × SKIP_PREPUSH=1 → exit 0, skip message, audit never runs ---
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, { refLines: contentPush, env: { SKIP_PREPUSH: "1" } });
    const skipped = res.status === 0 && /skipped \(SKIP_PREPUSH=1\)/.test(res.stdout);
    report(
      "row 3: high advisory + SKIP_PREPUSH=1 skips audit",
      skipped,
      `exit=${res.status} stdout=${res.stdout.trim()}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 4: moderate-only advisory × content push → exit 0 (negative control) ---
{
  const dir = buildFixture(MODERATE_DEP);
  try {
    const res = runHook(dir, { refLines: contentPush });
    report(
      "row 4: moderate-only advisory + content push passes `--audit-level=high` (negative control)",
      res.status === 0 && marker(dir, "BUILD_MARKER") && marker(dir, "LINT_MARKER") && marker(dir, "TEST_MARKER"),
      `exit=${res.status} stderr=${res.stderr.slice(0, 300)}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 5: clean tree × content push → all four steps run, in order ---
{
  const dir = buildFixture({ name: "left-pad", version: "1.3.0" });
  try {
    const res = runHook(dir, { refLines: contentPush });
    report(
      "row 5: clean tree runs audit -> build -> lint -> test",
      res.status === 0 && marker(dir, "BUILD_MARKER") && marker(dir, "LINT_MARKER") && marker(dir, "TEST_MARKER"),
      `exit=${res.status} stderr=${res.stderr.slice(0, 300)}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 6: ignoreCves entry × the matching high advisory → exit 0; removing it restores exit 1 ---
{
  const dir = buildFixture(HIGH_DEP, { pnpm: { auditConfig: { ignoreCves: [HIGH_ADVISORY_CVE] } } });
  try {
    const withIgnore = runHook(dir, { refLines: contentPush });
    report(
      "row 6a: ignoreCves entry suppresses the matching advisory",
      withIgnore.status === 0,
      `exit=${withIgnore.status} stderr=${withIgnore.stderr.slice(0, 300)}`,
    );

    // Same fixture, same advisory — remove the entry and rerun.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "indigo-audit-fixture",
          version: "1.0.0",
          private: true,
          scripts: {
            build: markerScript("BUILD_MARKER"),
            lint: markerScript("LINT_MARKER"),
            test: markerScript("TEST_MARKER"),
          },
          dependencies: { [HIGH_DEP.name]: HIGH_DEP.version },
        },
        null,
        2,
      ),
    );
    clearMarkers(dir);
    const withoutIgnore = runHook(dir, { refLines: contentPush });
    report(
      "row 6b: removing the ignoreCves entry restores exit 1 (same advisory, same run)",
      withoutIgnore.status !== 0 && !marker(dir, "BUILD_MARKER"),
      `exit=${withoutIgnore.status}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Row 7: registry unreachable × content push → exit 1, message names ignoreCves and SKIP_PREPUSH ---
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, {
      refLines: contentPush,
      env: { npm_config_registry: "http://127.0.0.1:1/does-not-exist" },
    });
    const message = res.stdout + res.stderr;
    report(
      "row 7: unreachable registry fails closed and names both exits",
      res.status !== 0 && message.includes("ignoreCves") && message.includes("SKIP_PREPUSH=1"),
      `exit=${res.status}`,
    );
  } finally {
    teardown(dir);
  }
}

// --- Threat matrix: empty stdin and first-push (all-zero remote sha) ref shapes ---
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, { refLines: emptyStdinPush });
    report(
      "threat matrix: empty stdin does not run audit or the build/lint/test loop",
      res.status === 0 && !marker(dir, "BUILD_MARKER"),
      `exit=${res.status}`,
    );
  } finally {
    teardown(dir);
  }
}
{
  const dir = buildFixture(HIGH_DEP);
  try {
    const res = runHook(dir, { refLines: firstPushAllZeroRemote });
    report(
      "threat matrix: first push (all-zero remote sha) still runs audit and aborts on the high advisory",
      res.status !== 0 && !marker(dir, "BUILD_MARKER"),
      `exit=${res.status}`,
    );
  } finally {
    teardown(dir);
  }
}

console.log(`\ntest-audit-gate: ${passed}/${ran} passed`);
if (passed !== ran) {
  console.error("test-audit-gate: FAILED");
  process.exit(1);
}
console.log("test-audit-gate: PASSED");
