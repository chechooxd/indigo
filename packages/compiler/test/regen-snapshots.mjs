/**
 * Regenerates the golden snapshots in fixtures/snapshots/ from the current
 * WASM compiler output. Run ONLY after an intentional contract change (new
 * IR field, new attribute) — the diff is the review artifact.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../../../fixtures");
const wasm = await import("../dist/index.node.js");

mkdirSync(join(fixturesDir, "snapshots"), { recursive: true });
for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".indigo")).sort()) {
  const source = readFileSync(join(fixturesDir, file), "utf8");
  const r = wasm.parseSchema(source);
  if ("errors" in r) throw new Error(`${file} failed to parse: ${JSON.stringify(r.errors)}`);
  const out = {
    schema: r.schema,
    resolved: wasm.resolveSchema(r.schema),
    validation: wasm.validateSchema(r.schema),
  };
  writeFileSync(
    join(fixturesDir, "snapshots", file.replace(".indigo", ".json")),
    JSON.stringify(out, null, 2) + "\n",
  );
  console.log("snapshot:", file);
}
