/**
 * @indigodb/client — GetPayload checkpoint (tasks.md 2.1/2.3).
 *
 * Runs `tsc --noEmit` over `fixtures/typecheck-fixture.ts`, which exercises
 * `Payload<Row, Rel, A>` narrowing against the real `ModelDelegate` generic.
 * Every `// @ts-expect-error` in the fixture only compiles clean if
 * TypeScript genuinely raises an error there, so a clean exit here IS the
 * checkpoint passing — no separate assertion needed.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tsc = join(here, "..", "node_modules", ".bin", "tsc");
const tsconfig = join(here, "tsconfig.typecheck.json");

console.log("GetPayload checkpoint: tsc --noEmit over typecheck-fixture.ts");

try {
  execFileSync(tsc, ["--noEmit", "-p", tsconfig], { stdio: "pipe" });
  console.log("  ok   Payload<Row, Rel, A> narrowing holds (real conditional types, no fallback needed)");
  console.log("\n@indigodb/client typecheck: all checks passed");
} catch (err) {
  console.error("  FAIL Payload<Row, Rel, A> narrowing checkpoint");
  console.error(err.stdout ? err.stdout.toString() : String(err));
  console.error("\n@indigodb/client typecheck: 1 failure(s)");
  process.exit(1);
}
