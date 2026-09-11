/**
 * Version-parity guard for the release-engineering fixed group.
 *
 * `.changeset/config.json` declares one `fixed` group covering all 11
 * publishable units (`release-versioning`), so `changeset version` bumps
 * them in lockstep — but nothing enforced that guarantee until now. This
 * script re-asserts it independently of the changesets tool: every
 * non-private workspace package MUST carry the identical `version` field.
 * A hand-edited manifest, a rebase that only touched one package, or a
 * changesets misconfiguration that silently dropped a unit from the fixed
 * group would otherwise ship a version-drifted cohort with no signal until
 * `@indigodb/cli`'s runtime `workspace:*` dependency on `@indigodb/studio`
 * (`packages/cli/package.json:32`) breaks for a consumer.
 *
 * Version parity alone is not sufficient: a 12th publishable package added
 * to the workspace and forgotten in `.changeset/config.json`'s `fixed`
 * array would still carry a matching version today (it just wouldn't be
 * bumped by the NEXT `changeset version`), so the parity check above would
 * print PASSED right up until the next release silently left it behind.
 * This script also cross-checks the discovered publishable set against the
 * declared `fixed` group by name, in both directions: a publishable package
 * missing from `fixed`, and a `fixed` entry with no matching publishable
 * package (e.g. renamed or removed), are both failures.
 *
 * Resolves the repo root from `import.meta.url` (precedent:
 * `scripts/check-pack-contents.mjs:25`, read-only reference), so it is
 * cwd-independent. Run from anywhere; exits 1 naming both sides of any
 * mismatch.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function workspacePackages() {
  const out = [];
  for (const dir of ["packages", "apps"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const manifestPath = join(base, entry, "package.json");
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      out.push({ name: pkg.name, version: pkg.version, private: !!pkg.private, manifestPath });
    }
  }
  return out;
}

function fixedGroup() {
  const configPath = join(repoRoot, ".changeset", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const group = Array.isArray(config.fixed) ? config.fixed[0] : undefined;
  return { group: Array.isArray(group) ? group : [], configPath };
}

console.log("release cohort version-parity guard");

const publishable = workspacePackages().filter((p) => !p.private);

if (publishable.length === 0) {
  console.error("FAIL: no non-private workspace packages found — nothing to guard.");
  process.exit(1);
}

let failed = false;

const reference = publishable[0];
const drifted = publishable.filter((p) => p.version !== reference.version);

if (drifted.length > 0) {
  failed = true;
  for (const pkg of drifted) {
    console.error(
      `  FAIL ${pkg.name}: version ${pkg.version} does not match ${reference.name}'s ` +
        `${reference.version} — the release cohort must bump in lockstep (release-versioning).`,
    );
  }
}

const { group: fixed, configPath } = fixedGroup();
const publishableNames = new Set(publishable.map((p) => p.name));
const fixedNames = new Set(fixed);

const missingFromFixed = publishable
  .map((p) => p.name)
  .filter((name) => !fixedNames.has(name));
const extraInFixed = fixed.filter((name) => !publishableNames.has(name));

if (missingFromFixed.length > 0 || extraInFixed.length > 0) {
  failed = true;
  for (const name of missingFromFixed) {
    console.error(
      `  FAIL ${name}: publishable workspace package is missing from the fixed group in ` +
        `${configPath} — it will not be bumped by \`changeset version\`.`,
    );
  }
  for (const name of extraInFixed) {
    console.error(
      `  FAIL ${name}: listed in the fixed group in ${configPath} but no publishable ` +
        `workspace package with that name exists — renamed, removed, or a typo.`,
    );
  }
}

if (failed) {
  console.error("\ncheck-release-cohort: FAILED");
  process.exit(1);
}

for (const pkg of publishable) {
  console.log(`  ok ${pkg.name}@${pkg.version}`);
}
console.log("\ncheck-release-cohort: PASSED");
