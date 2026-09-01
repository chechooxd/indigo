/**
 * Repo-wide npm tarball guard.
 *
 * Every publishable workspace package MUST declare a `files` allowlist, and its
 * packed tarball MUST contain nothing outside that allowlist plus npm's own
 * automatic inclusions. Without `files`, npm falls back to ignore-file rules
 * that do NOT consult the monorepo root `.gitignore` — so `dist/` still ships,
 * but so does everything else in the package directory: `src/`, `test/`,
 * `tsconfig.json`, Turbo's `.turbo/*.log` build output (one was 75 kB of test
 * logs), and stray tool directories. That is how `@indigodb/migrator` came to
 * pack 191 files / 642 kB when 25 files / 222 kB is the whole package.
 *
 * `apps/studio/test/pack-contents.mjs` guards Studio the same way, per-package,
 * from the `unblock-publishing` change. This script generalises that guard to
 * the whole workspace — notably covering `@indigodb/ast` and `@indigodb/parser`,
 * which have no `test` script of their own and so cannot host a per-package
 * check. Run from the repo root AFTER a build, since it inspects `dist/`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** npm always packs these regardless of `files`; they are never violations. */
const ALWAYS_INCLUDED = /^(package\.json|README(\..*)?|LICEN[CS]E(\..*)?|CHANGELOG(\..*)?)$/i;

function workspacePackages() {
  const out = [];
  for (const dir of ["packages", "apps"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, "package.json");
      if (existsSync(manifest)) out.push({ dir: join(base, entry), manifest });
    }
  }
  return out;
}

let failures = 0;
function fail(pkg, message) {
  failures++;
  console.error(`  FAIL ${pkg}: ${message}`);
}

console.log("workspace pack-contents guard");

for (const { dir, manifest } of workspacePackages()) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private) {
    console.log(`  skip ${pkg.name} (private, never published)`);
    continue;
  }

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail(
      pkg.name,
      'no `files` allowlist — the tarball would ship src/, test/, .turbo/ logs and tool ' +
        'directories. Add one (e.g. ["dist"]) matching what this package actually needs at runtime.',
    );
    continue;
  }

  let packed;
  try {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    packed = JSON.parse(raw)[0]?.files?.map((f) => f.path) ?? [];
  } catch {
    fail(pkg.name, "`npm pack --dry-run --json` failed to run or returned unparseable output");
    continue;
  }

  if (packed.length === 0) {
    fail(pkg.name, "packed tarball is empty — dist/ may be missing or stale. Run `pnpm build` first.");
    continue;
  }

  // A path is allowed when it sits under one of the declared allowlist roots,
  // or is one of npm's automatic inclusions.
  const roots = pkg.files.map((f) => f.replace(/^\.\//, "").replace(/\/+$/, ""));
  const strays = packed.filter(
    (p) => !ALWAYS_INCLUDED.test(p) && !roots.some((r) => p === r || p.startsWith(`${r}/`)),
  );

  if (strays.length > 0) {
    fail(
      pkg.name,
      `packed tarball contains ${strays.length} path(s) outside [${roots.join(", ")}]:\n` +
        strays.map((p) => `         ${p}`).join("\n"),
    );
    continue;
  }

  // "Nothing extra shipped" is only half the contract: an allowlist pointing at
  // the wrong directory (e.g. ["src"]) would produce no strays and still pass.
  // So also require that what the package actually resolves at runtime is IN
  // the tarball. This doubles as a stale/empty-dist check.
  const entryPoints = [pkg.main, ...Object.values(pkg.bin ?? {})]
    .filter(Boolean)
    .map((e) => e.replace(/^\.\//, ""));
  const missing = entryPoints.filter((e) => !packed.includes(e));
  if (missing.length > 0) {
    fail(
      pkg.name,
      `allowlist [${roots.join(", ")}] does not ship its own entry point(s): ${missing.join(", ")}. ` +
        "Either the allowlist points at the wrong directory, or dist/ is stale — run `pnpm build`.",
    );
    continue;
  }

  console.log(`  ok   ${pkg.name} (${packed.length} files, all under ${roots.join(" + ")})`);
}

if (failures > 0) {
  console.error(`\nworkspace pack-contents guard: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nworkspace pack-contents guard: all green");
