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
const erasableTsconfig = join(here, "tsconfig.erasable.json");

console.log("GetPayload checkpoint: tsc --noEmit over typecheck-fixture.ts");

let failures = 0;

try {
  execFileSync(tsc, ["--noEmit", "-p", tsconfig], { stdio: "pipe" });
  console.log(
    "  ok   Payload<Row, Rel, A> narrowing holds (real conditional types, no fallback needed); " +
      "const-object enum compiles in both value and type position (fixtures/typecheck-fixture.ts)",
  );
} catch (err) {
  failures++;
  console.error("  FAIL Payload<Row, Rel, A> narrowing checkpoint");
  console.error(err.stdout ? err.stdout.toString() : String(err));
}

// client-query-type-safety spec "Enum-bearing model compiles under
// erasableSyntaxOnly" — a separate, narrower tsconfig (see tsconfig.erasable.json)
// so unrelated non-erasable syntax elsewhere in the package (e.g.
// delegate.ts's constructor parameter properties) never masks this proof.
try {
  execFileSync(tsc, ["--noEmit", "-p", erasableTsconfig], { stdio: "pipe" });
  console.log("  ok   generated const-object enum compiles under erasableSyntaxOnly");
} catch (err) {
  failures++;
  console.error("  FAIL erasableSyntaxOnly enum checkpoint");
  console.error(err.stdout ? err.stdout.toString() : String(err));
}

if (failures > 0) {
  console.error(`\n@indigodb/client typecheck: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client typecheck: all checks passed");
}
