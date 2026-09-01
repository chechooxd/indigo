/**
 * @indigodb/generator — golden regression: `<Model>WhereInput` emission
 * (client-where-composition PR A, tasks.md A2.1/A2.2).
 *
 * `generateClient` must emit, per model, a self-contained `<Model>WhereInput`
 * interface with a `WhereValue<T>` predicate per scalar column plus
 * self-referential `AND?`/`OR?`/`NOT?` fields — replacing the flat generic
 * `WhereInput<Row>` as the concrete `Where` type argument wired through
 * `ModelDelegate`/`RealtimeModelDelegate` (design.md "Types stay per-model
 * and generated, mirroring CreateInput/UpdateInput"). Relation keys (PR B)
 * and JSON-typed keys (PR C) are explicitly NOT covered here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/where-emission.indigo"), "utf8");
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

// Balanced-brace slice, mirrors relation-emission.mjs's `block` helper.
function block(marker, from = 0) {
  const start = output.indexOf(marker, from);
  deepStrictEqual(start >= 0, true, `expected to find "${marker}"`);
  let depth = 1;
  let i = start + marker.length;
  for (; i < output.length && depth > 0; i++) {
    if (output[i] === "{") depth++;
    else if (output[i] === "}") depth--;
  }
  return output.slice(start, i);
}

console.log("generator regression: where-input emission");

check("emits UserWhereInput with a WhereValue predicate per scalar column", () => {
  const w = block("export interface UserWhereInput {");
  deepStrictEqual(w.includes("id?: WhereValue<number>;"), true);
  deepStrictEqual(w.includes("name?: WhereValue<string>;"), true);
  deepStrictEqual(w.includes("bio?: WhereValue<string | null>;"), true);
});

check("emits self-referential AND?/OR?/NOT? on UserWhereInput", () => {
  const w = block("export interface UserWhereInput {");
  deepStrictEqual(w.includes("AND?: UserWhereInput[];"), true);
  deepStrictEqual(w.includes("OR?: UserWhereInput[];"), true);
  deepStrictEqual(w.includes("NOT?: UserWhereInput;"), true);
});

check("emits PostWhereInput with its own scalar predicates and self-references", () => {
  const w = block("export interface PostWhereInput {");
  deepStrictEqual(w.includes("title?: WhereValue<string>;"), true);
  deepStrictEqual(w.includes("archived?: WhereValue<boolean>;"), true);
  deepStrictEqual(w.includes("authorId?: WhereValue<number>;"), true);
  deepStrictEqual(w.includes("AND?: PostWhereInput[];"), true);
  deepStrictEqual(w.includes("OR?: PostWhereInput[];"), true);
  deepStrictEqual(w.includes("NOT?: PostWhereInput;"), true);
});

check("PR B: emits a RelationFilter<Target> key for a to-many relation on WhereInput", () => {
  const wUser = block("export interface UserWhereInput {");
  deepStrictEqual(wUser.includes("posts?: RelationFilter<PostWhereInput>;"), true);
});

check("PR B: does NOT emit a relation filter key for a to-one relation on WhereInput", () => {
  const w = block("export interface PostWhereInput {");
  deepStrictEqual(w.includes("author?:"), false);
});

check("imports RelationFilter type from @indigodb/client", () => {
  deepStrictEqual(/import type \{[^}]*RelationFilter[^}]*\} from "@indigodb\/client";/.test(output), true);
});

check("no flat generic WhereInput<Row> type is emitted for a model", () => {
  deepStrictEqual(output.includes("export type UserWhereInput ="), false);
  deepStrictEqual(output.includes("export type PostWhereInput ="), false);
});

check("ModelDelegate/RealtimeModelDelegate instantiations reference <Model>WhereInput as the 5th generic", () => {
  deepStrictEqual(
    output.includes(
      "new ModelDelegate<User, UserCreateInput, UserUpdateInput, UserRelations, UserWhereInput, UserCreateManyInput, UserCursorInput, UserNumericFields, UserWhereUniqueInput>(",
    ),
    true,
  );
  deepStrictEqual(
    output.includes(
      "readonly post: ModelDelegate<Post, PostCreateInput, PostUpdateInput, PostRelations, PostWhereInput, PostCreateManyInput, PostCursorInput, PostNumericFields, PostWhereUniqueInput>;",
    ),
    true,
  );
});

check("imports WhereValue type from @indigodb/client", () => {
  deepStrictEqual(/import type \{[^}]*WhereValue[^}]*\} from "@indigodb\/client";/.test(output), true);
});

check("PR C: sets json: true on __meta field metadata for a Json/jsonb column", () => {
  const meta = block('"Post": {');
  deepStrictEqual(/metadata["']?\s*:\s*\{[^}]*json:\s*true[^}]*\}/.test(meta), true, `unexpected __meta: ${meta}`);
});

check("PR C: does NOT set json: true on a non-Json column's field metadata", () => {
  const meta = block('"Post": {');
  const titleField = /"title":\s*\{[^}]*\}/.exec(meta)?.[0] ?? "";
  deepStrictEqual(titleField.includes("json"), false, `unexpected __meta: ${titleField}`);
});

check("PR C: types a Json/jsonb column as JsonFilter on PostWhereInput", () => {
  const w = block("export interface PostWhereInput {");
  deepStrictEqual(w.includes("metadata?: JsonFilter;"), true, `unexpected WhereInput: ${w}`);
});

check("imports JsonFilter type from @indigodb/client", () => {
  deepStrictEqual(/import type \{[^}]*JsonFilter[^}]*\} from "@indigodb\/client";/.test(output), true);
});

if (failures > 0) {
  console.error(`\ngenerator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngenerator regression: all green");
