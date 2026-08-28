/**
 * WASM freshness guard — proves the committed artifact was built from the
 * Rust sources currently in the tree.
 *
 * `packages/compiler/wasm/` is a COMMITTED build artifact so TypeScript-only
 * contributors never need a Rust toolchain. The cost of that trade is a rule:
 * change `crates/`, rebuild the artifact, commit both. `.github/workflows/`'s
 * `wasm-drift` job used to enforce it by rebuilding on every push — but that
 * workflow is disabled (moved to `workflows-disabled/`), so nothing enforced
 * it any more. The failure mode is silent and nasty: edit the Rust, forget the
 * rebuild, and `pnpm test` still passes — because every TypeScript test runs
 * against the STALE artifact. Green, and wrong.
 *
 * This guard restores the rule without CI and without a Rust toolchain.
 *
 * ## Why it hashes sources instead of the artifact
 *
 * It cannot diff the `.wasm` bytes: they are not reproducible across machines.
 * `rust-toolchain.toml` documents this at length — identical
 * rustc/wasm-pack/wasm-bindgen still emit different bytes on Linux vs macOS
 * from low-level codegen ordering, which is exactly why CI, not a laptop
 * rebuild, was made the source of truth for those bytes.
 *
 * So it hashes the INPUTS instead. "Were these the sources the artifact was
 * built from?" is a deterministic question with a host-independent answer,
 * while "are these the same bytes?" is not. This catches the only failure that
 * actually matters here — sources moved, artifact didn't — and it runs
 * anywhere Node runs, with no cargo installed.
 *
 * It deliberately does NOT prove the artifact is byte-correct, only that it is
 * not stale. Byte-level verification needs a hermetic build and stays out of
 * scope, same conclusion `rust-toolchain.toml` reached.
 *
 * ## Usage
 *
 *   node test/wasm-freshness.mjs           # verify (exits 1 on drift)
 *   node test/wasm-freshness.mjs --write   # re-stamp after a rebuild
 *
 * `--write` is wired into `build:wasm`, so a normal rebuild re-stamps itself
 * and the stamp cannot drift from the artifact it describes.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "../..");
const STAMP_PATH = join(pkgRoot, "wasm-sources.sha256");

/**
 * Files whose content can change the emitted artifact. `Cargo.lock` is in here
 * because it, not the caret range in `Cargo.toml`, is what actually pins
 * `wasm-bindgen`; `rust-toolchain.toml` because the compiler version is an
 * input too.
 */
const ROOTS = [join(repoRoot, "crates")];
const EXTRA_FILES = [join(repoRoot, "rust-toolchain.toml")];
const SOURCE_EXT = [".rs", ".toml", ".lock"];

/** Directories that hold build output, never sources. */
const IGNORED_DIRS = new Set(["target", "node_modules", "pkg", ".git"]);

/** Every source file under `dir`, recursively, sorted for a stable digest. */
function collect(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collect(full, found);
    } else if (SOURCE_EXT.some((ext) => entry.name.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * sha256 over every source path AND its content. Paths are included (and
 * normalised to forward slashes) so that adding, renaming or deleting a file
 * changes the digest even when the remaining bytes are untouched.
 */
function digestSources() {
  const files = [...ROOTS.flatMap((r) => collect(r)), ...EXTRA_FILES.filter(existsSync)]
    .map((f) => relative(repoRoot, f).split(sep).join("/"))
    .sort();

  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(repoRoot, rel)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), count: files.length };
}

const { digest, count } = digestSources();

if (process.argv.includes("--write")) {
  writeFileSync(
    STAMP_PATH,
    `${digest}\n# ${count} Rust source files. Written by build:wasm — do not edit by hand.\n`,
  );
  console.log(`  ok   wasm freshness stamp written (${count} sources)`);
  process.exit(0);
}

if (!existsSync(STAMP_PATH)) {
  console.error("  FAIL wasm freshness: no stamp found at packages/compiler/wasm-sources.sha256");
  console.error("       Rebuild the artifact to create it:");
  console.error("         pnpm --filter @indigodb/compiler build:wasm");
  process.exit(1);
}

const recorded = readFileSync(STAMP_PATH, "utf8").split("\n")[0].trim();

if (recorded !== digest) {
  console.error("  FAIL wasm freshness: crates/ changed but the WASM artifact was not rebuilt.");
  console.error("");
  console.error(`       recorded: ${recorded}`);
  console.error(`       actual:   ${digest}   (${count} source files)`);
  console.error("");
  console.error("       The committed artifact in packages/compiler/wasm/ no longer matches the");
  console.error("       Rust sources, so every TypeScript test above is running against a stale");
  console.error("       compiler. Rebuild and commit both:");
  console.error("");
  console.error("         pnpm --filter @indigodb/compiler build:wasm");
  console.error("");
  console.error("       Requires cargo + the wasm32-unknown-unknown target + wasm-pack.");
  console.error("       If the schema contract changed on purpose, also regenerate snapshots:");
  console.error("         node packages/compiler/test/regen-snapshots.mjs");
  process.exit(1);
}

console.log(`  ok   wasm freshness: artifact matches ${count} Rust sources`);
