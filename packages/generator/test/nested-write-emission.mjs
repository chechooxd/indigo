/**
 * @indigodb/generator — golden regression: nested-write metadata plumbing.
 *
 * PR A (nested-writes, tasks.md A1.1/A1.2) — `generateClient` must emit,
 * per relation, `fkSide`/`optional`/`optionalFk` on `__meta.<Model>.relations`
 * and `name` on `__meta.<Model>` itself, so `ModelDelegate`'s future write
 * planner (PR B/C) can order phases and gate disconnect/set without any new
 * SQL construction path. This PR emits metadata ONLY — no planner logic.
 *
 * `fkSide` = `!rel.inverse` (design.md Decision "`list` is insufficient to
 * order writes"). `optionalFk` = nullability of the PHYSICAL FK column
 * backing the pair, wherever it physically lives (holder table when
 * `fkSide`, target table when not).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/relation-emission.indigo"), "utf8");
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

// Balanced-brace slice from `marker` through its matching closing `}`.
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

console.log("generator regression: nested-write metadata emission");

// ─── A1.1 — ModelMeta.name ─────────────────────────────────────────────────

check("__meta.<Model> carries its own model name", () => {
  const userMeta = block('"User": {');
  deepStrictEqual(userMeta.includes('name: "User"'), true);
  const postMeta = block('"Post": {');
  deepStrictEqual(postMeta.includes('name: "Post"'), true);
});

// ─── A1.1 — RelationMeta.fkSide ─────────────────────────────────────────────

check("holder side (Post.author): fkSide is true", () => {
  const metaBlock = block('"Post": {');
  deepStrictEqual(/"author":\s*\{[^}]*fkSide:\s*true/.test(metaBlock), true);
});

check("inverse side (User.posts): fkSide is false", () => {
  const metaBlock = block('"User": {');
  deepStrictEqual(/"posts":\s*\{[^}]*fkSide:\s*false/.test(metaBlock), true);
});

// ─── A1.1 — RelationMeta.optional ───────────────────────────────────────────

check("required to-one (Post.author): optional is false", () => {
  const metaBlock = block('"Post": {');
  deepStrictEqual(/"author":\s*\{[^}]*optional:\s*false/.test(metaBlock), true);
});

check("optional to-one (Post.editor): optional is true", () => {
  const metaBlock = block('"Post": {');
  deepStrictEqual(/"editor":\s*\{[^}]*optional:\s*true/.test(metaBlock), true);
});

// ─── A1.1 — RelationMeta.optionalFk ─────────────────────────────────────────

check("required FK column (authorId NOT NULL): optionalFk is false on both sides of the pair", () => {
  const postMeta = block('"Post": {');
  deepStrictEqual(/"author":\s*\{[^}]*optionalFk:\s*false/.test(postMeta), true);
  const userMeta = block('"User": {');
  deepStrictEqual(/"posts":\s*\{[^}]*optionalFk:\s*false/.test(userMeta), true);
});

check("nullable FK column (editorId NULLABLE): optionalFk is true on the holder side", () => {
  const postMeta = block('"Post": {');
  deepStrictEqual(/"editor":\s*\{[^}]*optionalFk:\s*true/.test(postMeta), true);
});

check("1-1 pair (Profile.user / User.profile): required FK -> optionalFk false on both sides", () => {
  const profileMeta = block('"Profile": {');
  deepStrictEqual(/"user":\s*\{[^}]*optionalFk:\s*false/.test(profileMeta), true);
  const userMeta = block('"User": {');
  deepStrictEqual(/"profile":\s*\{[^}]*optionalFk:\s*false/.test(userMeta), true);
});

// ─── A1.1 — composite-key relations stay untouched ──────────────────────────

check("composite-key relation meta unchanged: still only { target, composite: true }", () => {
  const metaBlock = block('"LineItem": {');
  deepStrictEqual(metaBlock.includes('"order": { target: "Order", composite: true }'), true);
});

check("to-one fkSide required FK allows passing relation op without scalar FK in CreateInput", () => {
  deepStrictEqual(output.includes("export interface PostCreateBase {"), true);
  deepStrictEqual(output.includes("export type PostCreateInput = PostCreateBase &"), true);
  deepStrictEqual(output.includes("authorId?: undefined; author: ToOneRelationInput<UserCreateInput, WhereInput<User>>"), true);
});

check("non-fkSide User.posts omits both child FK scalar and its fkSide relation from child create input", () => {
  const userCreate = block("export interface UserCreateInput {");
  deepStrictEqual(userCreate.includes("PostCreateBase"), true);
  deepStrictEqual(userCreate.includes("authorId"), false);
});

if (failures > 0) {
  console.error(`\ngenerator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngenerator regression: all green");
