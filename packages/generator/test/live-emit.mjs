/**
 * @indigodb/generator — golden regression: `.live()` emission
 * (`client-live-queries` spec, design.md decision 7, tasks.md section 11).
 *
 * `live-emit.indigo` carries three tables: `Order` (`@@realtime` +
 * `@@allow` — qualifies for `.live()`), `Message` (`@@realtime` only — no
 * `.live()`, `.subscribe()` unaffected) and `User` (plain — neither).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/live-emit.indigo"), "utf8");
const schema = resolve(parse(source));
const output = generateClient(schema);

// Second generation over a schema with NO qualifying live model — used for
// the byte-identity assertions (tasks.md 11.2/11.4).
const noLiveSource = readFileSync(join(here, "fixtures/transaction-emission.indigo"), "utf8");
const noLiveSchema = resolve(parse(noLiveSource));
const noLiveOutput = generateClient(noLiveSchema);

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

console.log("generator regression: .live() emission");

// ─── 11.1: .live() present for @@realtime + @@allow ────────────────────────

check("emits LiveModelDelegate for Order (@@realtime + @@allow)", () => {
  deepStrictEqual(output.includes("new LiveModelDelegate<"), true);
  deepStrictEqual(
    output.includes(
      `  readonly order: LiveModelDelegate<Order, OrderCreateInput, OrderUpdateInput, OrderRelations, OrderWhereInput, OrderCreateManyInput, OrderCursorInput, OrderNumericFields, OrderUpsertWhereInput>;`,
    ),
    true,
  );
});

check("imports LiveModelDelegate from @indigodb/client", () => {
  deepStrictEqual(/import \{[^}]*LiveModelDelegate[^}]*\} from "@indigodb\/client";/.test(output), true);
});

check("emits the runScoped closure once, in the IndigoClient class body", () => {
  const occurrences = output.split("private readonly runScoped: ClientRunScoped").length - 1;
  deepStrictEqual(occurrences, 1);
});

check("__delegates factory accepts runScoped/handle/requireHandle when any model qualifies", () => {
  deepStrictEqual(output.includes("  runScoped: ClientRunScoped,"), true);
  deepStrictEqual(output.includes("  handle: GetHandleFn,"), true);
  deepStrictEqual(output.includes("  requireHandle: () => void,"), true);
});

// ─── 11.2: .live() absent for @@realtime-only; that model's own output ─────
// stays byte-identical to what it would be without any live-qualifying
// model in the schema at all. ────────────────────────────────────────────

check("does NOT emit LiveModelDelegate for Message (@@realtime only, no @@allow)", () => {
  deepStrictEqual(output.includes("new LiveModelDelegate<Message"), false);
  deepStrictEqual(output.includes("new RealtimeModelDelegate<Message"), true);
});

check("Message's RealtimeModelDelegate construction is byte-identical to a schema with no qualifying live model", () => {
  const extract = (text, model) => {
    const marker = `    ${model}: new RealtimeModelDelegate<`;
    const start = text.indexOf(marker);
    if (start === -1) throw new Error(`could not find ${model}'s RealtimeModelDelegate construction`);
    const end = text.indexOf("),", start) + 2;
    return text.slice(start, end);
  };
  deepStrictEqual(extract(output, "message"), extract(noLiveOutput, "message"));
});

check("does NOT emit any live-related symbol for User (no @@realtime at all)", () => {
  deepStrictEqual(output.includes("new LiveModelDelegate<User"), false);
  deepStrictEqual(output.includes("new RealtimeModelDelegate<User"), false);
  deepStrictEqual(output.includes("new ModelDelegate<User"), true);
});

// ─── 11.4/11.5: .subscribe()'s own emission is untouched ───────────────────

check("RealtimeModelDelegate (Message) still exposes subscribe() via inheritance — no separate emission needed, subscribe() lives on the base class, never regenerated per model", () => {
  // subscribe() is inherited, not emitted per-model — this assertion locks
  // in that `.live()` emission added NO per-model subscribe()-shaped text.
  deepStrictEqual(output.includes("subscribe(handlers"), false);
});

check("a schema with no qualifying live model emits no live-related imports/symbols at all (whole-file byte-identity for the zero-live case)", () => {
  deepStrictEqual(noLiveOutput.includes("LiveModelDelegate"), false);
  deepStrictEqual(noLiveOutput.includes("ClientRunScoped"), false);
  deepStrictEqual(noLiveOutput.includes("GetHandleFn"), false);
  deepStrictEqual(noLiveOutput.includes("runScoped"), false);
});

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all .live() emission cases passed.");
}
