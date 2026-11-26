// Guards the published tarball shape for @indigodb/studio.
//
// A package carrying "private": true can never be packed at all, and a
// package missing a "files" allowlist (or with a stale/empty dist/) would
// silently ship the wrong contents. This script runs `npm pack --dry-run`
// against the current package state and asserts the packed file set is
// only `dist/**` plus npm's automatic metadata files (`package.json`,
// `README*`, `LICEN[CS]E*`, `CHANGELOG*`), matching `studio-package-publishability`
// and `scripts/check-pack-contents.mjs`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALWAYS_INCLUDED = /^(package\.json|README(\..*)?|LICEN[CS]E(\..*)?|CHANGELOG(\..*)?)$/i;

function runNpmPack() {
  let stdout;
  try {
    stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } catch (error) {
    console.error("pack-contents: `npm pack --dry-run --json` failed to run.");
    console.error(error.stderr ?? error.message);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    console.error("pack-contents: could not parse `npm pack --dry-run --json` output as JSON.");
    console.error(stdout);
    process.exit(1);
  }

  const entry = parsed[0];
  if (!entry || !Array.isArray(entry.files)) {
    console.error("pack-contents: unexpected `npm pack --dry-run --json` shape (no files[]).");
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }

  return entry.files.map((file) => file.path);
}

const paths = runNpmPack();

const offending = paths.filter((p) => !ALWAYS_INCLUDED.test(p) && !p.startsWith("dist/"));

if (offending.length > 0) {
  console.error("pack-contents: packed tarball contains paths outside dist/ and npm metadata:");
  for (const p of offending) {
    console.error(`  - ${p}`);
  }
  process.exit(1);
}

if (!paths.includes("dist/index.html")) {
  console.error(
    "pack-contents: packed tarball is missing dist/index.html — dist/ may be empty or stale. Run `pnpm build` first.",
  );
  console.error("Packed paths:", paths);
  process.exit(1);
}

console.log(`pack-contents: OK (${paths.length} files packed, all under dist/ or npm metadata)`);
process.exit(0);
