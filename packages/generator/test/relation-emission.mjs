/**
 * @indigodb/generator — golden regression: relation metadata & `include` types.
 *
 * `generateClient` must emit, per model, a plain `<Model>Relations` interface
 * and an `<Model>IncludeInput` alias, plus a `relations` map on `__meta`
 * shaped `{ target, from, to, list }` with `from`/`to` translated from the
 * IR's PHYSICAL fk/ref column names to FIELD names, and normalized so the
 * holder and inverse sides of the same relation agree on a single
 * direction-agnostic rule (see design.md, Decision #1).
 *
 * Composite-key relations (more than one fk/ref column) are rejected at
 * codegen time per tasks.md 1.4 — see the "composite-key decision" checks
 * below and the inline comment at the rejection site in `client.ts`.
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

// Balanced-brace slice from `marker` (which must end just after an opening
// `{`) through its matching closing `}` — plain `indexOf("}")` breaks on
// `__meta` entries, which nest a `fields: { ... }` object before `relations`.
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

console.log("generator regression: relation emission");

// ─── 1.1 — __meta.<Model>.relations shape ─────────────────────────────────

check("holder side (Post.author): from/to are FIELD names, not physical", () => {
  const metaBlock = block('"Post": {');
  deepStrictEqual(
    metaBlock.includes(
      '"author": { target: "User", from: "authorId", to: "id", list: false, fkSide: true, optional: false, optionalFk: false }',
    ),
    true,
  );
});

check("inverse side (User.posts): from/to normalized to the same direction-agnostic shape", () => {
  const metaBlock = block('"User": {');
  deepStrictEqual(
    metaBlock.includes(
      '"posts": { target: "Post", from: "id", to: "authorId", list: true, fkSide: false, optional: false, optionalFk: false }',
    ),
    true,
  );
});

check("@map'd fk column: `from` uses the FIELD name (authorId), never the physical column (author_id)", () => {
  const relationsBlock = block("relations: {", output.indexOf('"Post": {'));
  deepStrictEqual(relationsBlock.includes('"author_id"'), false);
  deepStrictEqual(relationsBlock.includes('from: "authorId"'), true);
});

check("nullable N-1 (Post.editor): still emits from/to/list, list is false", () => {
  const metaBlock = block('"Post": {');
  deepStrictEqual(
    metaBlock.includes(
      '"editor": { target: "User", from: "editorId", to: "id", list: false, fkSide: true, optional: true, optionalFk: true }',
    ),
    true,
  );
});

check("1-1 pair (Profile.user / User.profile) resolves symmetric from/to", () => {
  const profileMeta = block('"Profile": {');
  deepStrictEqual(
    profileMeta.includes(
      '"user": { target: "User", from: "userId", to: "id", list: false, fkSide: true, optional: false, optionalFk: false }',
    ),
    true,
  );
  const userMeta = block('"User": {');
  deepStrictEqual(
    userMeta.includes(
      '"profile": { target: "Profile", from: "id", to: "userId", list: false, fkSide: false, optional: true, optionalFk: false }',
    ),
    true,
  );
});

// ─── 1.2 — <Model>Relations interface + IncludeInput ──────────────────────

check("emits <Model>Relations interface with list vs nullable member types", () => {
  const rel = block("export interface UserRelations {");
  deepStrictEqual(rel.includes("posts: Post[];"), true);
  deepStrictEqual(rel.includes("profile: Profile | null;"), true);
});

check("mandatory to-one relation member has no `| null`", () => {
  const rel = block("export interface ProfileRelations {");
  deepStrictEqual(rel.includes("user: User;"), true);
});

check("optional to-one relation member is `Target | null`", () => {
  const rel = block("export interface PostRelations {");
  deepStrictEqual(rel.includes("editor: User | null;"), true);
});

check("emits <Model>IncludeInput alias per model", () => {
  deepStrictEqual(output.includes("export type UserIncludeInput = IncludeInput<UserRelations>;"), true);
  deepStrictEqual(output.includes("export type PostIncludeInput = IncludeInput<PostRelations>;"), true);
});

check("imports IncludeInput type from @indigodb/client", () => {
  deepStrictEqual(/import type \{[^}]*IncludeInput[^}]*\} from "@indigodb\/client";/.test(output), true);
});

// ─── 1.3/1.4 — composite-key relation rejection ───────────────────────────

check("composite-key relation (LineItem.order) is OMITTED from <Model>Relations (compile-time rejection)", () => {
  const rel = block("export interface LineItemRelations {");
  deepStrictEqual(rel.includes("order"), false);
});

check("composite-key relation still recorded in __meta with `composite: true`, no from/to/list", () => {
  const metaBlock = block('"LineItem": {');
  deepStrictEqual(metaBlock.includes('"order": { target: "Order", composite: true }'), true);
});

if (failures > 0) {
  console.error(`\ngenerator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngenerator regression: all green");
