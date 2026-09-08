/**
 * `@indigodb/react` — browser-safety guard (design.md D8, tasks.md 5a.3, T37).
 *
 * Four slices of this change are undone by one wrong import: if
 * `@indigodb/react` ever reaches `@indigodb/client`'s ROOT entry (or any
 * other package's root entry that carries a Node-only runtime import), it
 * drags `pg` and `node:async_hooks`/`node:http`/etc. into every consumer's
 * browser bundle. This mirrors `packages/client/test/realtime-entry.mjs`'s
 * reachable-specifier scan (per the standing obligation in tasks.md: extend
 * the existing scan pattern rather than hand-rolling a new one), generalized
 * to resolve ANY `@indigodb/*` workspace specifier — not just one hardcoded
 * subpath — so it also catches a mistaken root import of a package this one
 * does not intend to depend on directly (e.g. `@indigodb/realtime`).
 *
 * Named RED mutation (tasks.md 5a.3): make `src/index.ts` value-import the
 * root `@indigodb/realtime` package instead of `@indigodb/realtime/protocol`
 * — the scan must fail, and the failure message must name both the
 * forbidden specifier and the file path that reached it.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { builtinModules } from "node:module";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const FORBIDDEN = ["pg", /^node:/];
// `node:fs` and a bare `fs` are the same module to Node, so a `/^node:/` rule
// alone leaves the entire standard library reachable through its unprefixed
// form. Sourced from Node rather than hand-kept so it cannot drift.
// Tradeoff: a few builtin names (`process`, `util`, `punycode`) also exist as
// browser-safe npm shims; flagging them here is the safe default for a browser
// package, and a false positive is visible and one line to waive.
const NODE_BUILTINS = new Set(builtinModules);

function isForbidden(specifier) {
  if (NODE_BUILTINS.has(specifier)) return true;
  return FORBIDDEN.some((rule) => (rule instanceof RegExp ? rule.test(specifier) : rule === specifier));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * Resolves a bare `@indigodb/<pkg>` or `@indigodb/<pkg>/<subpath>` specifier
 * to the absolute `dist/*.js` file it points to, by reading that package's
 * OWN `package.json` (`exports` map, falling back to `main`). Returns null
 * for anything that isn't an `@indigodb/*` workspace specifier.
 */
function resolveWorkspaceSpecifier(specifier) {
  const match = specifier.match(/^@indigodb\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const [, pkgName, subpath] = match;
  const pkgDir = path.join(repoRoot, "packages", pkgName);
  const manifestPath = path.join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exportKey = subpath ? `.${subpath}` : ".";
  const entry = manifest.exports?.[exportKey]?.import ?? (exportKey === "." ? manifest.main : undefined);
  if (!entry) return null;
  return path.resolve(pkgDir, entry);
}

/**
 * Recursively collects every static import/export specifier reachable from
 * `entryFile`, following relative specifiers within the same file tree and
 * `@indigodb/*` workspace specifiers into their resolved `dist/*.js`,
 * without executing any module. Records, per specifier, the first file that
 * reached it — so a failure can name a real location, not just a bare
 * specifier string.
 */
function collectReachable(entryFile, seenFiles = new Set(), foundAt = new Map()) {
  const abs = path.resolve(entryFile);
  if (seenFiles.has(abs)) return foundAt;
  seenFiles.add(abs);

  if (!existsSync(abs)) {
    throw new Error(`browser-safety scan: expected file does not exist: ${abs} (run \`pnpm build\` first?)`);
  }

  const source = readFileSync(abs, "utf8");
  const importRe = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  const bareImportRe = /import\s+["']([^"']+)["']/g;
  // A static grep over `from "..."` never sees `import("pg")`, which the
  // compiled output executes identically.
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const specs = new Set();
  for (const re of [importRe, bareImportRe, dynamicImportRe]) {
    let m;
    while ((m = re.exec(source))) specs.add(m[1]);
  }

  for (const spec of specs) {
    if (!foundAt.has(spec)) foundAt.set(spec, abs);

    if (spec.startsWith(".")) {
      const resolved = path.resolve(path.dirname(abs), spec);
      collectReachable(resolved, seenFiles, foundAt);
      continue;
    }

    const workspaceEntry = resolveWorkspaceSpecifier(spec);
    if (workspaceEntry) {
      collectReachable(workspaceEntry, seenFiles, foundAt);
    }
  }

  return foundAt;
}

check("packages/react's reachable import graph carries no forbidden specifier", () => {
  const entry = path.resolve(here, "../dist/index.js");
  const foundAt = collectReachable(entry);

  const offenders = [...foundAt.entries()].filter(([spec]) => isForbidden(spec));
  assert(
    offenders.length === 0,
    offenders
      .map(
        ([spec, file]) =>
          `forbidden import "${spec}" is reachable from packages/react's import graph, ` +
          `reached via ${path.relative(repoRoot, file)}`,
      )
      .join("\n"),
  );
});
