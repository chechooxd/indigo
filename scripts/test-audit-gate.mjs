/**
 * Fixture-based proof for the `dependency-audit-gate` capability
 * (`.githooks/pre-push`'s `pnpm audit --audit-level=high` block).
 *
 * Builds isolated temp fixture workspaces pinning real known-advisory
 * dependencies, with marker-only `build`/`lint`/`test` scripts, and invokes
 * the REAL `.githooks/pre-push` against each fixture with synthetic stdin ref
 * lines. The repo's own lockfile is never touched.
 *
 * Needs the network (real `pnpm audit` calls). Follows the
 * `INDIGODB_TEST_DATABASE_URL` precedent: gated on `INDIGODB_TEST_AUDIT=1` —
 * unset, prints `SKIP` and exits 0 so `pnpm test` stays network-free by default.
 *
 *   INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(repoRoot, ".githooks", "pre-push");

if (process.env.INDIGODB_TEST_AUDIT !== "1") {
  console.log(
    "SKIP - test-audit-gate: INDIGODB_TEST_AUDIT is unset — audit-gate fixture suite " +
      "skipped (needs network for real `pnpm audit` calls). Set INDIGODB_TEST_AUDIT=1 for full coverage.",
  );
  process.exit(0);
}

const NON_DELETION_REF =
  "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 0000000000000000000000000000000000000000\n";
const DELETION_REF =
  "(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111\n";

const HIGH_CVE_DEP = { name: "ansi-regex", version: "3.0.0" };
const HIGH_CVE_ID = "CVE-2021-3807";

// js-yaml@4.1.0 carries GHSA-5p4m-2wfm-xmqj which has cves: [] (GHSA-only),
// alongside GHSA-52cp-r559-cp3m and GHSA-2883-xcg3-v3hh.
const GHSA_ONLY_DEP = { name: "js-yaml", version: "4.1.0" };
const GHSA_ONLY_ALL_GHSAS = [
  "GHSA-5p4m-2wfm-xmqj",
  "GHSA-52cp-r559-cp3m",
  "GHSA-2883-xcg3-v3hh",
];
const GHSA_ONLY_CVES_ONLY = ["CVE-2026-59869", "CVE-2026-84375"];

const MODERATE_DEP = { name: "xml2js", version: "0.4.19" };

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

function withFixture(dep, extra, fn) {
  const dir = mkdtempSync(join(tmpdir(), "indigo-audit-fixture-"));
  try {
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
    const install = spawnSync("pnpm", ["install", "--lockfile-only"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (install.status !== 0) {
      throw new Error(`lockfile generation failed for ${dep.name}@${dep.version}: ${install.stderr}`);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(cwd, { stdin = NON_DELETION_REF, env = {} } = {}) {
  return spawnSync("bash", [hookPath], {
    cwd,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, SKIP_PREPUSH: "", ...env },
  });
}

// 1. Seeded high-severity advisory fails fast before build starts
withFixture(HIGH_CVE_DEP, {}, (dir) => {
  const res = runHook(dir);
  const buildRan = existsSync(join(dir, "BUILD_MARKER"));
  report(
    "high advisory aborts push before build starts",
    res.status !== 0 && !buildRan,
    `exit=${res.status}, buildRan=${buildRan}`,
  );
});

// 2. Same high advisory suppressed via ignoreCves proceeds through build/lint/test
withFixture(
  HIGH_CVE_DEP,
  { pnpm: { auditConfig: { ignoreCves: [HIGH_CVE_ID] } } },
  (dir) => {
    const res = runHook(dir);
    const allRan =
      existsSync(join(dir, "BUILD_MARKER")) &&
      existsSync(join(dir, "LINT_MARKER")) &&
      existsSync(join(dir, "TEST_MARKER"));
    report(
      "ignoreCves suppresses CVE-bearing advisory and proceeds to build/lint/test",
      res.status === 0 && allRan,
      `exit=${res.status}, allRan=${allRan}, out=${(res.stdout + res.stderr).slice(-200)}`,
    );
  },
);

// 3. GHSA-only advisory cannot be suppressed by ignoreCves alone, CAN be suppressed by ignoreGhsas
withFixture(
  GHSA_ONLY_DEP,
  { pnpm: { auditConfig: { ignoreCves: GHSA_ONLY_CVES_ONLY } } },
  (dir) => {
    const res = runHook(dir);
    const buildRan = existsSync(join(dir, "BUILD_MARKER"));
    report(
      "GHSA-only advisory (cves: []) still fails when only ignoreCves is set",
      res.status !== 0 && !buildRan,
      `exit=${res.status}, buildRan=${buildRan}`,
    );
  },
);

withFixture(
  GHSA_ONLY_DEP,
  { pnpm: { auditConfig: { ignoreGhsas: GHSA_ONLY_ALL_GHSAS } } },
  (dir) => {
    const res = runHook(dir);
    const allRan =
      existsSync(join(dir, "BUILD_MARKER")) &&
      existsSync(join(dir, "LINT_MARKER")) &&
      existsSync(join(dir, "TEST_MARKER"));
    report(
      "ignoreGhsas suppresses GHSA-only advisory and proceeds to build/lint/test",
      res.status === 0 && allRan,
      `exit=${res.status}, allRan=${allRan}, out=${(res.stdout + res.stderr).slice(-200)}`,
    );
  },
);

// 4. Moderate-only advisory passes --audit-level=high and runs build/lint/test
withFixture(MODERATE_DEP, {}, (dir) => {
  const res = runHook(dir);
  const allRan =
    existsSync(join(dir, "BUILD_MARKER")) &&
    existsSync(join(dir, "LINT_MARKER")) &&
    existsSync(join(dir, "TEST_MARKER"));
  report(
    "moderate-only advisory passes --audit-level=high and runs build/lint/test",
    res.status === 0 && allRan,
    `exit=${res.status}, allRan=${allRan}`,
  );
});

// 5. SKIP_PREPUSH=1 skips audit and build/lint/test
withFixture(HIGH_CVE_DEP, {}, (dir) => {
  const res = runHook(dir, { env: { SKIP_PREPUSH: "1" } });
  const buildRan = existsSync(join(dir, "BUILD_MARKER"));
  report(
    "SKIP_PREPUSH=1 bypasses audit and build/lint/test",
    res.status === 0 && !buildRan && res.stdout.includes("skipped"),
    `exit=${res.status}, buildRan=${buildRan}, stdout=${res.stdout.trim()}`,
  );
});

// 6. Deletion-only push skips audit and build/lint/test
withFixture(HIGH_CVE_DEP, {}, (dir) => {
  const res = runHook(dir, { stdin: DELETION_REF });
  const buildRan = existsSync(join(dir, "BUILD_MARKER"));
  report(
    "deletion-only push skips audit and build/lint/test",
    res.status === 0 && !buildRan && res.stdout.includes("nothing to verify"),
    `exit=${res.status}, buildRan=${buildRan}, stdout=${res.stdout.trim()}`,
  );
});

console.log(`\ntest-audit-gate: ${passed}/${ran} passed`);
