/**
 * @indigodb/generator — golden regression: generated client enum mapping.
 *
 * First test for this package. `generateClient` must emit each enum
 * member's PHYSICAL (`@map`) label as the TS enum's VALUE, and the LOGICAL
 * name as its key — never the logical name as the value. The generated
 * client sends this value verbatim to PostgreSQL, and `@indigodb/migrator`
 * now creates the enum type's labels from `dbName` too (`fix-migrator-
 * correctness`), so a mismatch here fails every insert/update against a
 * `@map`'d enum with `invalid input value for enum`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/enum-mapping.indigo"), "utf8");
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

console.log("generator regression: enum mapping");

check("mapped member: logical name as key, @map dbName as value", () => {
  deepStrictEqual(output.includes('ACTIVE: "active",'), true);
});

check("unmapped member: logical name as both key and value", () => {
  deepStrictEqual(output.includes('INACTIVE: "INACTIVE",'), true);
});

check("enum block is well-formed: const object plus paired type, not a nominal enum", () => {
  const start = output.indexOf("export const Status = {");
  const end = output.indexOf("as const;", start) + "as const;".length;
  deepStrictEqual(
    output.slice(start, end),
    'export const Status = {\n  ACTIVE: "active",\n  INACTIVE: "INACTIVE",\n} as const;',
  );
  deepStrictEqual(
    output.includes("export type Status = (typeof Status)[keyof typeof Status];"),
    true,
  );
  deepStrictEqual(output.includes("export enum Status"), false);
});

check("BigInt scalar column emits `string`, not `bigint`, in the generated Row interface", () => {
  deepStrictEqual(output.includes("views: string;"), true);
  deepStrictEqual(output.includes("views: bigint;"), false);
});

if (failures > 0) {
  console.error(`\ngenerator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngenerator regression: all green");
