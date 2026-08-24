/**
 * @indigodb/generator — golden regression: `$auth` emission (design.md
 * Decision #16, tasks.md C4.1).
 *
 * `generateClient` must emit a typed `$auth` override on `IndigoClient`,
 * next to `$transaction`, that widens `IndigoClientBase.$auth` (protected,
 * hands `fn` the raw session `Executor`) to a public method handing `fn`
 * the same typed `TransactionClient` `$transaction` uses — built on the
 * SAME `__delegates` factory, never a second parallel delegate-construction
 * path. Reuses `transaction-emission.indigo` (one plain model, one
 * `@@realtime` model) — `$auth` has no `@@allow`-specific emission shape of
 * its own, so no dedicated fixture is needed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/transaction-emission.indigo"), "utf8");
const schema = resolve(parse(source));
const output = generateClient(schema);

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("generator regression: $auth emission");

check("emits a typed $auth override on IndigoClient", () => {
  deepStrictEqual(
    output.includes(
      "  $auth<T>(ctx: { userId: string | number }, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {",
    ),
    true,
  );
});

check(
  "$auth delegates to this.$authSession (IndigoClientBase's protected helper — NOT super.$auth, since $auth is a new method, not an override), never reimplements set_config/transaction handling",
  () => {
    deepStrictEqual(
      output.includes("    return this.$authSession(ctx, (exec) => fn(__delegates(exec, this.$realtime).tx));"),
      true,
    );
  },
);

check("$auth is emitted inside the IndigoClient class body, after $transaction", () => {
  const transactionIdx = output.indexOf("  $transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;");
  const authIdx = output.indexOf("  $auth<T>(ctx: { userId: string | number }");
  deepStrictEqual(transactionIdx >= 0 && authIdx > transactionIdx, true);
});

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all $auth emission cases passed.");
}
