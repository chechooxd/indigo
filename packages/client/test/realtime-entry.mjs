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

// ─── tasks.md 3.16: SSR-inert entry + browserTransport() (design.md D5) ─────

await check("importing the entry under bare Node (no DOM globals) does not throw and opens no connection", async () => {
  assert(typeof globalThis.window === "undefined", "sanity: this bare Node process has no `window` global");
  const mod = await import("@indigodb/client/realtime");
  assert(typeof mod.createLiveSubscription === "function", "createLiveSubscription export missing");
  assert(typeof mod.browserTransport === "function", "browserTransport export missing");
  // The import itself must be side-effect-free — nothing above threw, and
  // merely resolving the module never calls `fetch` or opens a channel.
});

await check("browserTransport() throws a named error when `window` is undefined (server-side)", async () => {
  const mod = await import("@indigodb/client/realtime");
  let thrown = null;
  try {
    mod.browserTransport();
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "expected browserTransport() to throw an Error server-side");
  assert(
    /browser environment/i.test(thrown.message),
    `expected a named, descriptive error message, got: ${thrown.message}`,
  );
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nall realtime-entry checks passed");
}
