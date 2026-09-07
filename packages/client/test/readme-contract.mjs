/**
 * @indigodb/client — README content-assertion suite (`client-browser-usage-docs`
 * spec, design.md T41, tasks.md 4.1-4.4).
 *
 * Plain Node, no test framework, mirroring `realtime-entry.mjs`'s
 * `check()`/`assert()` style. This suite is a literal-string / structure
 * check against `README.md` itself — the "code" under test is prose, so the
 * assertions are string/regex matches against the browser-usage section
 * rather than runtime behavior.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const readmePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../README.md");
const readme = readFileSync(readmePath, "utf8");

/**
 * The browser-usage section: from the heading that introduces browser usage
 * up to (but not including) the next top-level (`##`) heading, or EOF.
 * Scoped this way — rather than a bare full-file substring search — so
 * tasks.md 4.1's mutation (keep the string but move the heading OUT of the
 * section) actually fails: the string would still be present in the file,
 * just no longer inside the section this assertion scopes to.
 */
function extractSection(markdown, headingPattern) {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => /^##\s/.test(line) && headingPattern.test(line));
  assert(startIndex !== -1, `no top-level heading matching ${headingPattern} found in README.md`);
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

// ─── tasks.md 4.1: names the browser entry point ───────────────────────────

await check("browser section names the @indigodb/client/realtime entry point", () => {
  const browserSection = extractSection(readme, /browser/i);
  assert(
    browserSection.includes("@indigodb/client/realtime"),
    "expected the literal string `@indigodb/client/realtime` inside the browser-usage section",
  );
});

// ─── tasks.md 4.2: states the wake-only contract ───────────────────────────

await check("browser section states the wake-only, no-row-data contract", () => {
  const browserSection = extractSection(readme, /browser/i);
  assert(
    /no row data/i.test(browserSection) && /wake/i.test(browserSection),
    "expected the browser section to explicitly state the SSE stream carries no row data, only a wake signal",
  );
});

// ─── tasks.md 4.3: states the query non-goal ───────────────────────────────

await check("browser section states the query non-goal and points to the app's own backend", () => {
  const browserSection = extractSection(readme, /browser/i);
  assert(
    /own backend/i.test(browserSection),
    "expected the browser section to state that browser code cannot query IndigoDB directly and must use the app's own backend",
  );
});

// ─── tasks.md 4.4: TanStack recipe wires onWake to invalidateQueries ───────

await check("TanStack recipe calls createLiveSubscription with onWake invalidating queries", () => {
  const codeBlocks = [...readme.matchAll(/```(?:ts|tsx)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const recipe = codeBlocks.find(
    (block) => block.includes("createLiveSubscription") && block.includes("invalidateQueries"),
  );
  assert(recipe !== undefined, "expected a code sample calling both createLiveSubscription and invalidateQueries");
  assert(
    /onWake\s*:\s*\(\s*\)\s*=>\s*\{?[\s\S]*?queryClient\.invalidateQueries/.test(recipe) ||
      /onWake\s*\(\s*\)\s*\{[\s\S]*?queryClient\.invalidateQueries/.test(recipe),
    "expected the recipe's `onWake` callback to call `queryClient.invalidateQueries`, not `refetch()` or anything else",
  );
  assert(!/\bonWake\s*:[^,}]*\brefetch\s*\(/.test(recipe), "onWake must not call refetch() directly — invalidateQueries composes with the app's own data library");
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nall readme-contract checks passed");
}
