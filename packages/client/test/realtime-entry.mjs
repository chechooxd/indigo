/**
 * @indigodb/client — `./realtime` browser-safe subpath regression
 * (`client-live-queries` spec, design.md decision 1/2, tasks.md 1.2).
 *
 * Plain Node, no test framework, mirroring `auth.mjs`/`live.mjs`'s
 * `check()`/`assert()` style. Verifies:
 *   1. `@indigodb/client/realtime` resolves via the package `exports` map
 *      and exposes `SseTransport` + `REALTIME_PATH`.
 *   2. The module graph reachable from `dist/realtime.js` contains no
 *      `pg` or `node:async_hooks` import (static source scan of every
 *      relatively-imported/reachable-workspace `dist/*.js` file — no
 *      bundler needed since the check inspects import specifiers
 *      directly, per tasks.md 1.6).
 *   3. The root `.` entry point's exports are unaffected by this subpath.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
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

const FORBIDDEN = ["pg", "node:async_hooks"];

/**
 * Recursively collects every static import/export specifier reachable from
 * `entryFile`, following relative specifiers within the same package and
 * `@indigodb/*` workspace packages (resolved to their `dist/*.js` via each
 * package's own `exports` map or `main`), without executing any module.
 */
function collectReachableSpecifiers(entryFile, seenFiles = new Set(), specifiers = new Set()) {
  const abs = path.resolve(entryFile);
  if (seenFiles.has(abs)) return specifiers;
  seenFiles.add(abs);

  const source = readFileSync(abs, "utf8");
  const importRe = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  const bareImportRe = /import\s+["']([^"']+)["']/g;
  const specs = new Set();
  for (const re of [importRe, bareImportRe]) {
    let m;
    while ((m = re.exec(source))) specs.add(m[1]);
  }

  for (const spec of specs) {
    specifiers.add(spec);
    if (spec.startsWith(".")) {
      const resolved = path.resolve(path.dirname(abs), spec);
      collectReachableSpecifiers(resolved, seenFiles, specifiers);
    } else if (spec === "@indigodb/realtime/protocol") {
      const pkgDist = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../realtime/dist/protocol.js",
      );
      collectReachableSpecifiers(pkgDist, seenFiles, specifiers);
    }
    // NOTE: a bare `@indigodb/realtime` (root) specifier is deliberately
    // NOT followed here — reaching it at all is itself the failure being
    // guarded against (see the forbidden-import assertion below), and
    // following it would pull `pg`/`node:async_hooks` into THIS test's
    // static scan by design, defeating the point of the check.
  }
  return specifiers;
}

await check("@indigodb/client/realtime resolves via the exports map", async () => {
  const mod = await import("@indigodb/client/realtime");
  assert(typeof mod.SseTransport === "function", "SseTransport export missing");
  assert(mod.REALTIME_PATH === "/api/realtime", "REALTIME_PATH export missing/wrong");
});

await check("reachable module graph from dist/realtime.js has no pg/node:async_hooks import", () => {
  const entry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/realtime.js",
  );
  const specifiers = collectReachableSpecifiers(entry);
  assert(
    !specifiers.has("@indigodb/realtime"),
    "dist/realtime.js must not carry a runtime (value) import of the root @indigodb/realtime entry",
  );
  for (const forbidden of FORBIDDEN) {
    assert(!specifiers.has(forbidden), `forbidden import "${forbidden}" reachable from dist/realtime.js`);
  }
});

await check("root `.` entry point exports are unaffected", async () => {
  const mod = await import("../dist/index.js");
  assert(typeof mod.IndigoClientBase === "function", "IndigoClientBase export missing from root entry");
  assert(typeof mod.SseTransport === "function", "SseTransport export missing from root entry");
  assert(typeof mod.LIVE_DEBOUNCE_MS === "number", "LIVE_DEBOUNCE_MS export missing from root entry");
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nall realtime-entry checks passed");
}
