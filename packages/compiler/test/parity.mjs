/**
 * Compiler regression harness.
 *
 * During the Rust port this file compared the legacy Chevrotain/TS pipeline
 * against the WASM one (100% green before the switch). The legacy
 * implementation is gone now; the reference is the golden snapshots in
 * fixtures/snapshots/, frozen from that parity-verified output.
 *
 * Regenerate snapshots (only after an INTENTIONAL contract change):
 *   node test/regen-snapshots.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../../../fixtures");
const wasm = await import("../dist/index.node.js");

const norm = (x) => JSON.parse(JSON.stringify(x));
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

// `22-non-ascii.indigo` (ast-source-spans slice 1) is span-only: it
// deliberately has no `fixtures/snapshots/22-non-ascii.json` and is never
// part of the golden-snapshot comparison — see its file header. Excluding
// it here is what keeps "all 21 golden snapshots byte-identical, zero
// regeneration" true (task 1.10): this loop still only ever touches 21.
const SPAN_ONLY_FIXTURES = new Set(["22-non-ascii.indigo"]);

const valid = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".indigo") && !SPAN_ONLY_FIXTURES.has(f))
  .sort();
console.log(`regression: ${valid.length} fixtures vs golden snapshots`);
for (const file of valid) {
  const source = readFileSync(join(fixturesDir, file), "utf8");
  const golden = JSON.parse(
    readFileSync(join(fixturesDir, "snapshots", file.replace(".indigo", ".json")), "utf8"),
  );
  const r = wasm.parseSchema(source);
  check(`${file} parses`, () => {
    if ("errors" in r) throw new Error(`parse failed: ${JSON.stringify(r.errors)}`);
  });
  if ("errors" in r) continue;
  check(`${file} AST`, () => deepStrictEqual(norm(r.schema), golden.schema));
  check(`${file} ResolvedSchema`, () =>
    deepStrictEqual(norm(wasm.resolveSchema(r.schema)), golden.resolved));
  check(`${file} ValidationError[]`, () =>
    deepStrictEqual(norm(wasm.validateSchema(r.schema)), golden.validation));
  // Task 1.6: `parseSchemaWithSpans` is a pure side channel — `parseSchema`'s
  // own output must never gain a `spans` field just because that export
  // exists. Guards against a shared internal representation leaking one.
  check(`${file} parseSchema() output carries no span leakage`, () => {
    if ("spans" in r.schema) {
      throw new Error("parseSchema()'s output must not carry a spans field");
    }
  });
}

const errorsDir = join(fixturesDir, "errors");
const errorFixtures = readdirSync(errorsDir).filter((f) => f.endsWith(".indigo")).sort();
console.log(`regression: ${errorFixtures.length} error fixtures`);
for (const file of errorFixtures) {
  const source = readFileSync(join(errorsDir, file), "utf8");
  check(`errors/${file} fails with positioned errors`, () => {
    const r = wasm.parseSchema(source);
    if (!("errors" in r)) throw new Error("parsed successfully");
    if (r.errors.length === 0) throw new Error("empty error list");
    for (const e of r.errors) {
      if (!(e.line >= 1)) throw new Error(`error without line: ${JSON.stringify(e)}`);
    }
  });
}

// ─── Spans (ast-source-spans, slice 1) ─────────────────────────────────────

console.log("regression: spans");

check("parse_with_spans returns schema and spans together", () => {
  const source = readFileSync(join(fixturesDir, "05-relations.indigo"), "utf8");
  const out = wasm.parseSchemaWithSpans(source);
  if ("errors" in out) throw new Error(`parse failed: ${JSON.stringify(out.errors)}`);
  const plain = wasm.parseSchema(source);
  if ("errors" in plain) throw new Error("parseSchema() unexpectedly failed");
  deepStrictEqual(norm(out.schema), norm(plain.schema));
  if (out.spans.models.length !== out.schema.models.length) {
    throw new Error("spans.models must have one entry per model");
  }
});

check("an ASCII field span slices exactly the field's text in JS", () => {
  const source = "Table User {\n  id Int @id\n}\n";
  const out = wasm.parseSchemaWithSpans(source);
  if ("errors" in out) throw new Error("unexpected parse failure");
  const field = out.spans.models[0].fields[0];
  const sliced = source.slice(field.decl.start, field.decl.end);
  if (sliced !== "id Int @id") throw new Error(`got: ${JSON.stringify(sliced)}`);
  if (field.decl.line !== 2 || field.decl.column !== 3) {
    throw new Error(`unexpected line/column: ${JSON.stringify(field.decl)}`);
  }
});

check("a multi-line model spans from its keyword to its closing brace", () => {
  const source = readFileSync(join(fixturesDir, "01-cli-template.indigo"), "utf8");
  const out = wasm.parseSchemaWithSpans(source);
  if ("errors" in out) throw new Error("unexpected parse failure");
  const post = out.spans.models.find((m) => m.name === "Post");
  if (!post) throw new Error("expected a Post model span");
  const declLines = source.slice(post.decl.start, post.decl.end).split("\n").length;
  if (declLines <= 1) throw new Error("expected the decl span to cover multiple lines");
  if (post.decl.endLine <= post.decl.line) {
    throw new Error(`endLine must be past line: ${JSON.stringify(post.decl)}`);
  }
});

// Task 1.9: non-ASCII fixture — proves offsets are UTF-16 code units, not
// raw UTF-8 byte offsets. Mutation: reverting `SpanContext::span` to emit
// byte offsets makes this fail (either an out-of-range/garbage slice or a
// slice that lands on the wrong text) — proven in
// `crates/indigo-compiler/src/span.rs` and `tests/span_fixture.rs`.
check("a non-ASCII character before an edit point does not corrupt a later span (fixture 22)", () => {
  const source = readFileSync(join(fixturesDir, "22-non-ascii.indigo"), "utf8");
  const out = wasm.parseSchemaWithSpans(source);
  if ("errors" in out) throw new Error(`unexpected parse failure: ${JSON.stringify(out.errors)}`);
  const post = out.spans.models.find((m) => m.name === "Post");
  const title = post.fields.find((f) => f.name === "title");
  const sliced = source.slice(title.decl.start, title.decl.end);
  if (sliced !== "title String") {
    throw new Error(`UTF-16 slice landed on the wrong text: ${JSON.stringify(sliced)}`);
  }
  // `source.indexOf` is already UTF-16-indexed (JS strings are UTF-16), so
  // it can't stand in for the raw UTF-8 byte offset a buggy byte-offset
  // span would report — compute that separately via Buffer.
  const utf16Index = source.indexOf("title String");
  const byteOffset = Buffer.byteLength(source.slice(0, utf16Index), "utf8");
  if (title.decl.start === byteOffset) {
    throw new Error("UTF-16 offset must diverge from the raw byte offset on this fixture");
  }
});

// Task 1.11 (Node/WASM half — see `crates/indigo-compiler/tests/span_agreement.rs`
// for the identical native-Rust half over the same literal source).
check("span values agree with the Rust-side recorded values (span_agreement.rs)", () => {
  const source = "Table User {\n  id Int @id\n  name String @unique\n}\n";
  const out = wasm.parseSchemaWithSpans(source);
  if ("errors" in out) throw new Error("unexpected parse failure");
  const model = out.spans.models[0];
  deepStrictEqual(
    { start: model.decl.start, end: model.decl.end, line: model.decl.line, column: model.decl.column, endLine: model.decl.endLine, endColumn: model.decl.endColumn },
    { start: 0, end: 49, line: 1, column: 1, endLine: 4, endColumn: 2 },
  );
  deepStrictEqual({ start: model.nameToken.start, end: model.nameToken.end }, { start: 6, end: 10 });
  deepStrictEqual({ start: model.bodyOpen.start, end: model.bodyOpen.end }, { start: 11, end: 12 });
  deepStrictEqual({ start: model.bodyClose.start, end: model.bodyClose.end }, { start: 48, end: 49 });

  const [idField, nameField] = model.fields;
  deepStrictEqual(
    { start: idField.decl.start, end: idField.decl.end, line: idField.decl.line, column: idField.decl.column, endLine: idField.decl.endLine, endColumn: idField.decl.endColumn },
    { start: 15, end: 25, line: 2, column: 3, endLine: 2, endColumn: 13 },
  );
  deepStrictEqual({ start: idField.nameToken.start, end: idField.nameToken.end }, { start: 15, end: 17 });
  deepStrictEqual({ start: idField.typeToken.start, end: idField.typeToken.end }, { start: 18, end: 21 });
  deepStrictEqual(idField.attributes.map((a) => a.name), ["id"]);
  deepStrictEqual({ start: idField.attributes[0].span.start, end: idField.attributes[0].span.end }, { start: 22, end: 25 });

  deepStrictEqual(
    { start: nameField.decl.start, end: nameField.decl.end, line: nameField.decl.line, column: nameField.decl.column, endLine: nameField.decl.endLine, endColumn: nameField.decl.endColumn },
    { start: 28, end: 47, line: 3, column: 3, endLine: 3, endColumn: 22 },
  );
  deepStrictEqual({ start: nameField.nameToken.start, end: nameField.nameToken.end }, { start: 28, end: 32 });
  deepStrictEqual({ start: nameField.typeToken.start, end: nameField.typeToken.end }, { start: 33, end: 39 });
  deepStrictEqual(nameField.attributes.map((a) => a.name), ["unique"]);
  deepStrictEqual({ start: nameField.attributes[0].span.start, end: nameField.attributes[0].span.end }, { start: 40, end: 47 });
});

if (failures > 0) {
  console.error(`\nregression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nregression: all green");
