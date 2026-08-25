/**
 * @indigodb/migrator — `computeBuckets` unit matrix (`realtime-shape-log`
 * PR B, design decisions 8-11, tasks.md B1.1-B1.3).
 *
 * Hand-constructed `ResolvedTable`/`AllowRule` fixtures — NEVER a compiled
 * `.indigo` source file (B1.3): the `@@realtime` + `@@allow` compiler guard
 * (`crates/.../validate.rs:86-97`) makes that combination unreachable
 * through real schema source until slice 4 lifts the guard, so every
 * non-`NULL`/non-empty `buckets` case in this file is exercised against an
 * in-memory IR fixture built directly, exactly like `rls.mjs`.
 */

import { deepStrictEqual } from "node:assert";
import { computeBuckets } from "../dist/index.js";

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

/** Minimal `ResolvedTable` builder — `columns`/`primaryKey`/etc are not read
 * by `computeBuckets` (it works purely off `table.allow` + the row data),
 * but are included for shape fidelity with the real IR. */
function table(overrides = {}) {
  return {
    name: "Post",
    dbName: "Post",
    columns: [],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
    relations: [],
    ...overrides,
  };
}

const claim = { kind: "claim", name: "userId" };
const field = (name) => ({ kind: "field", name });
const str = (value) => ({ kind: "string", value });
const num = (value) => ({ kind: "number", value });
const bool = (value) => ({ kind: "boolean", value });

console.log("migrator buckets: computeBuckets unit matrix (B1.1-B1.3, hand-built IR only)");

// ─── B1.1: no @@allow block at all -> NULL (public) ────────────────────────

check("table.allow === undefined (no @@allow block at all) -> null (public — real table has no RLS enabled either)", () => {
  const t = table(); // no `allow` key at all
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), null);
});

// ─── B1.1: @@allow present but no `read` rule -> [] (deny-all, NOT null) ───

check("@@allow rules exist but none is action:read (e.g. create-only) -> [] (deny-all, not null)", () => {
  const t = table({ allow: [{ action: "create", left: claim, right: field("ownerId") }] });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), []);
});

check("@@allow: [] (rules array present but empty) -> [] (deny-all)", () => {
  const t = table({ allow: [] });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), []);
});

// ─── claim-vs-field / field-vs-claim: contributes a bucket value ──────────

check("single field == claim rule -> [row[field]]", () => {
  const t = table({ allow: [{ action: "read", left: field("ownerId"), right: claim }] });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), ["u1"]);
});

check("claim == field (operand order reversed) contributes the same bucket — order-independent", () => {
  const t = table({ allow: [{ action: "read", left: claim, right: field("ownerId") }] });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), ["u1"]);
});

check("multiple field == claim rules on distinct fields union", () => {
  const t = table({
    allow: [
      { action: "read", left: field("ownerId"), right: claim },
      { action: "read", left: field("teamId"), right: claim },
    ],
  });
  deepStrictEqual(
    computeBuckets(t, { ownerId: "u1", teamId: "t2" }).sort(),
    ["t2", "u1"],
  );
});

check("a NULL field value contributes no element (decision 10)", () => {
  const t = table({
    allow: [
      { action: "read", left: field("ownerId"), right: claim },
      { action: "read", left: field("teamId"), right: claim },
    ],
  });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1", teamId: null }), ["u1"]);
});

check("read rules exist but none is satisfiable (every claim-field value is NULL) -> [] (deny-all)", () => {
  const t = table({ allow: [{ action: "read", left: field("ownerId"), right: claim }] });
  deepStrictEqual(computeBuckets(t, { ownerId: null }), []);
});

check("action filtering: only action:read rules contribute — a create rule alongside a read rule is ignored", () => {
  const t = table({
    allow: [
      { action: "read", left: field("ownerId"), right: claim },
      { action: "create", left: field("teamId"), right: claim },
    ],
  });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1", teamId: "t2" }), ["u1"]);
});

// ─── field-vs-field: caller-independent, EXCLUDED from bucket contribution,
// but a row it SATISFIES collapses the whole result to null (decision 9) ───

check("field == field (caller-independent) contributes no claim value by itself", () => {
  const t = table({ allow: [{ action: "read", left: field("a"), right: field("b") }] });
  // Neither side matches -> the rule is unsatisfied by this row -> no
  // collapse, and the rule itself never adds a text value (it isn't
  // claim-dependent) -> empty result -> deny-all.
  deepStrictEqual(computeBuckets(t, { a: "x", b: "y" }), []);
});

check("field == field satisfied by the row (a === b) collapses the WHOLE result to null — PERMISSIVE OR grants public read", () => {
  const t = table({ allow: [{ action: "read", left: field("a"), right: field("b") }] });
  deepStrictEqual(computeBuckets(t, { a: "same", b: "same" }), null);
});

check("field == field: a NULL side never satisfies (SQL NULL semantics) — no collapse, deny-all", () => {
  const t = table({ allow: [{ action: "read", left: field("a"), right: field("b") }] });
  deepStrictEqual(computeBuckets(t, { a: null, b: null }), []);
});

// ─── field-vs-literal: caller-independent, same collapse-or-nothing rule ───

check("field == literal NOT satisfied by the row -> no collapse, no bucket contribution", () => {
  const t = table({ allow: [{ action: "read", left: field("status"), right: str("published") }] });
  deepStrictEqual(computeBuckets(t, { status: "draft" }), []);
});

check("field == literal SATISFIED by the row collapses the whole result to null (caller-independent PERMISSIVE grant)", () => {
  const t = table({ allow: [{ action: "read", left: field("status"), right: str("published") }] });
  deepStrictEqual(computeBuckets(t, { status: "published" }), null);
});

check("literal == field (operand order reversed) behaves identically — order-independent", () => {
  const t = table({ allow: [{ action: "read", left: str("published"), right: field("status") }] });
  deepStrictEqual(computeBuckets(t, { status: "published" }), null);
});

check("field == number literal satisfied collapses to null", () => {
  const t = table({ allow: [{ action: "read", left: field("priority"), right: num(1) }] });
  deepStrictEqual(computeBuckets(t, { priority: 1 }), null);
});

check("field == boolean literal satisfied collapses to null", () => {
  const t = table({ allow: [{ action: "read", left: field("isPublic"), right: bool(true) }] });
  deepStrictEqual(computeBuckets(t, { isPublic: true }), null);
});

// ─── literal-vs-literal: caller-independent constant, EXCLUDED from bucket
// contribution (never a claim value); satisfied unconditionally by every
// row (same value both sides) collapses to null ─────────────────────────

check("literal == literal, equal values -> always satisfied -> collapses to null regardless of row", () => {
  const t = table({ allow: [{ action: "read", left: str("x"), right: str("x") }] });
  deepStrictEqual(computeBuckets(t, { anything: "irrelevant" }), null);
});

check("literal == literal, unequal values -> never satisfied -> no collapse, no contribution", () => {
  const t = table({ allow: [{ action: "read", left: str("x"), right: str("y") }] });
  deepStrictEqual(computeBuckets(t, {}), []);
});

check("literal == literal, different operand kinds (string vs number) -> never equal -> no collapse", () => {
  const t = table({ allow: [{ action: "read", left: str("1"), right: num(1) }] });
  deepStrictEqual(computeBuckets(t, {}), []);
});

// ─── claim-vs-claim: caller-independent, always satisfied (self-compare of
// the same closed claim vocabulary), EXCLUDED from bucket contribution but
// collapses to null unconditionally ─────────────────────────────────────

check("claim == claim -> always satisfied (self-compare) -> collapses to null", () => {
  const t = table({ allow: [{ action: "read", left: claim, right: claim }] });
  deepStrictEqual(computeBuckets(t, {}), null);
});

// ─── claim-vs-literal: rejected by the compiler (validate.rs:837-858) —
// defended defensively here, never reached through a real compiled schema ─

check("claim == literal (compiler-rejected combination, defended defensively) -> no crash, no contribution", () => {
  const t = table({ allow: [{ action: "read", left: claim, right: str("x") }] });
  deepStrictEqual(computeBuckets(t, {}), []);
});

check("literal == claim (reversed, compiler-rejected) -> no crash, no contribution", () => {
  const t = table({ allow: [{ action: "read", left: str("x"), right: claim }] });
  deepStrictEqual(computeBuckets(t, {}), []);
});

// ─── UPDATE: union of new (row) and old — decision 11 ──────────────────────

check("UPDATE: claim-field bucket is the union of row (new) and old field values", () => {
  const t = table({ allow: [{ action: "read", left: field("ownerId"), right: claim }] });
  deepStrictEqual(
    computeBuckets(t, { ownerId: "u2" }, { ownerId: "u1" }).sort(),
    ["u1", "u2"],
  );
});

check("UPDATE: caller-independent rule satisfied only by OLD (not new) still collapses to null — the losing tuple's PERMISSIVE grant still ORs in", () => {
  const t = table({ allow: [{ action: "read", left: field("status"), right: str("published") }] });
  deepStrictEqual(computeBuckets(t, { status: "draft" }, { status: "published" }), null);
});

check("UPDATE: field == field satisfied only in OLD collapses to null", () => {
  const t = table({ allow: [{ action: "read", left: field("a"), right: field("b") }] });
  deepStrictEqual(
    computeBuckets(t, { a: "x", b: "y" }, { a: "same", b: "same" }),
    null,
  );
});

check("UPDATE: no old passed (INSERT/DELETE shape) — only row's own value contributes", () => {
  const t = table({ allow: [{ action: "read", left: field("ownerId"), right: claim }] });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1" }), ["u1"]);
});

// ─── Combined: a claim-dependent rule union'd alongside a satisfied
// caller-independent rule -> the caller-independent collapse wins (null) ──

check("a satisfiable caller-independent rule alongside a claim-dependent rule collapses the WHOLE result to null, discarding any partial claim bucket already accumulated", () => {
  const t = table({
    allow: [
      { action: "read", left: field("ownerId"), right: claim },
      { action: "read", left: field("isPublic"), right: bool(true) },
    ],
  });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1", isPublic: true }), null);
});

check("a claim-dependent rule union'd with an UNSATISFIED caller-independent rule keeps the claim bucket intact", () => {
  const t = table({
    allow: [
      { action: "read", left: field("ownerId"), right: claim },
      { action: "read", left: field("isPublic"), right: bool(true) },
    ],
  });
  deepStrictEqual(computeBuckets(t, { ownerId: "u1", isPublic: false }), ["u1"]);
});

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all computeBuckets unit cases passed.");
}
