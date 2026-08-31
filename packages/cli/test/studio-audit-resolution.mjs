/**
 * @indigodb/cli — `studio-audit-log` pure-layer suite (PR 1 of 2).
 *
 * Plain Node, no test framework (mirrors `studio-readonly-resolution.mjs`
 * and `studio-environment-resolution.mjs`). Exercises the exported pure
 * resolver/correlator/formatter — design.md's Testing Strategy rows 1–16.
 * Row 17 (the `pk: Record<string, string>` compile-time guarantee) is
 * verified by `pnpm lint`, not here — see the doc comment on
 * `StudioAuditEntry` in `packages/cli/src/util.ts`.
 */

import { strictEqual, notStrictEqual, throws } from "node:assert";
import { randomBytes } from "node:crypto";
import {
  resolveStudioAuditLog,
  deriveSessionCorrelator,
  formatAuditLine,
  formatPkValue,
} from "../dist/util.js";

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

console.log("cli studio-audit-log: pure-layer suite");

// ─── resolveStudioAuditLog: flag > env > default true (rows 1–6) ───────────

check("row 1: --audit-log beats INDIGODB_STUDIO_AUDIT_LOG=false", () => {
  strictEqual(resolveStudioAuditLog(true, "false"), true);
});

check("row 2: --no-audit-log beats INDIGODB_STUDIO_AUDIT_LOG=true", () => {
  strictEqual(resolveStudioAuditLog(false, "true"), false);
});

check('row 3: env alone "1"/"true" -> true', () => {
  strictEqual(resolveStudioAuditLog(undefined, "1"), true);
  strictEqual(resolveStudioAuditLog(undefined, "true"), true);
});

check('row 3: env alone "0"/"false" -> false', () => {
  strictEqual(resolveStudioAuditLog(undefined, "0"), false);
  strictEqual(resolveStudioAuditLog(undefined, "false"), false);
});

check("row 4: both absent -> true (default on)", () => {
  strictEqual(resolveStudioAuditLog(undefined, undefined), true);
});

for (const malformed of ["no", "", "TRUE", " true", "nope", "1.0", "yes"]) {
  check(
    `row 5: env ${JSON.stringify(malformed)} throws naming INDIGODB_STUDIO_AUDIT_LOG`,
    () => {
      throws(() => resolveStudioAuditLog(undefined, malformed), /INDIGODB_STUDIO_AUDIT_LOG/);
    },
  );
}

check("row 6: the malformed-env throw is a plain Error, not process.exit", () => {
  let threw = false;
  let caught;
  try {
    resolveStudioAuditLog(undefined, "nope");
  } catch (err) {
    threw = true;
    caught = err;
  }
  strictEqual(threw, true);
  strictEqual(caught instanceof Error, true);
});

// ─── deriveSessionCorrelator: HMAC keyed, truncated hex (rows 7–11) ─────────

const keyA = randomBytes(32);
const keyB = randomBytes(32);

check("row 7: correlator is exactly 12 lowercase hex chars", () => {
  const correlator = deriveSessionCorrelator("some-cookie-token", keyA);
  strictEqual(typeof correlator, "string");
  strictEqual(/^[0-9a-f]{12}$/.test(correlator), true);
});

check("row 8: same token + same key -> same correlator (deterministic)", () => {
  const a = deriveSessionCorrelator("token-x", keyA);
  const b = deriveSessionCorrelator("token-x", keyA);
  strictEqual(a, b);
});

check("row 8: different token + same key -> different correlator (discrimination)", () => {
  const a = deriveSessionCorrelator("token-x", keyA);
  const b = deriveSessionCorrelator("token-y", keyA);
  notStrictEqual(a, b);
});

check("row 9: different keys over the SAME token -> different correlators (proves keying)", () => {
  const a = deriveSessionCorrelator("same-token", keyA);
  const b = deriveSessionCorrelator("same-token", keyB);
  notStrictEqual(a, b);
});

check("row 10: the token is not a substring of the correlator, and correlator !== token", () => {
  const token = "distinctive-raw-cookie-token-value";
  const correlator = deriveSessionCorrelator(token, keyA);
  notStrictEqual(correlator, token);
  strictEqual(correlator.includes(token), false);
  strictEqual(token.includes(correlator), false);
});

check('row 11: token === null -> undefined (never "anonymous"/null)', () => {
  strictEqual(deriveSessionCorrelator(null, keyA), undefined);
});

// ─── formatAuditLine / formatPkValue: log injection + cap (rows 12–14) ─────

check("row 12: formatAuditLine escapes \\n/\\r/space in a hostile table name", () => {
  const line = formatAuditLine({
    ts: new Date().toISOString(),
    kind: "studio.audit.write",
    op: "insert",
    table: "evil\ntable\r name",
    count: 1,
    outcome: "ok",
  });
  strictEqual(line.includes("\n"), false);
  strictEqual(line.includes("\r"), false);
  strictEqual(line.split("\n").length, 1);
  const parsed = JSON.parse(line);
  strictEqual(parsed.table, "evil\ntable\r name");
});

check("row 13: formatAuditLine escapes \\n/\\r/space in a hostile PK value", () => {
  const line = formatAuditLine({
    ts: new Date().toISOString(),
    kind: "studio.audit.write",
    op: "update",
    table: "t",
    pk: { id: "evil\nvalue\r here" },
    count: 1,
    outcome: "ok",
  });
  strictEqual(line.includes("\n"), false);
  strictEqual(line.includes("\r"), false);
  strictEqual(line.split("\n").length, 1);
  const parsed = JSON.parse(line);
  strictEqual(parsed.pk.id, "evil\nvalue\r here");
});

check("row 14: formatPkValue(number) stringifies verbatim", () => {
  strictEqual(formatPkValue(42), "42");
});

check("row 14: formatPkValue(null) -> \"null\"", () => {
  strictEqual(formatPkValue(null), "null");
});

check("row 14: formatPkValue(undefined) -> \"undefined\"", () => {
  strictEqual(formatPkValue(undefined), "undefined");
});

check("row 14: formatPkValue(Date) -> ISO string", () => {
  const d = new Date("2026-01-01T00:00:00.000Z");
  strictEqual(formatPkValue(d), d.toISOString());
});

check("row 14: formatPkValue caps a 500-char string at 128 chars", () => {
  const long = "x".repeat(500);
  const capped = formatPkValue(long);
  strictEqual(capped.length, 128);
  strictEqual(capped, long.slice(0, 128));
});

// ─── Entry shape: session omission + exact key sets (rows 15–16) ───────────

check("row 15: session: undefined omits the key entirely (not null)", () => {
  const line = formatAuditLine({
    ts: new Date().toISOString(),
    kind: "studio.audit.write",
    op: "insert",
    table: "t",
    count: 1,
    outcome: "ok",
    session: undefined,
  });
  const parsed = JSON.parse(line);
  strictEqual("session" in parsed, false);
});

check("row 16: outcome \"ok\" line carries exactly its populated keys, no extras", () => {
  const line = formatAuditLine({
    ts: "2026-01-01T00:00:00.000Z",
    kind: "studio.audit.write",
    op: "insert",
    table: "t",
    pk: { id: "1" },
    columns: ["email"],
    count: 1,
    outcome: "ok",
  });
  const parsed = JSON.parse(line);
  const keys = Object.keys(parsed).sort();
  const expected = ["columns", "count", "kind", "op", "outcome", "pk", "table", "ts"].sort();
  strictEqual(JSON.stringify(keys), JSON.stringify(expected));
});

check("row 16: outcome \"denied\" line carries exactly its populated keys, no pk/columns", () => {
  const line = formatAuditLine({
    ts: "2026-01-01T00:00:00.000Z",
    kind: "studio.audit.write",
    op: "insert",
    table: "t",
    count: 0,
    outcome: "denied",
    reason: "read-only",
  });
  const parsed = JSON.parse(line);
  const keys = Object.keys(parsed).sort();
  const expected = ["count", "kind", "op", "outcome", "reason", "table", "ts"].sort();
  strictEqual(JSON.stringify(keys), JSON.stringify(expected));
});

check("row 16: outcome \"error\" line carries exactly its populated keys, including code", () => {
  const line = formatAuditLine({
    ts: "2026-01-01T00:00:00.000Z",
    kind: "studio.audit.write",
    op: "update",
    table: "t",
    count: 0,
    outcome: "error",
    reason: "db-error",
    code: "23505",
  });
  const parsed = JSON.parse(line);
  const keys = Object.keys(parsed).sort();
  const expected = ["code", "count", "kind", "op", "outcome", "reason", "table", "ts"].sort();
  strictEqual(JSON.stringify(keys), JSON.stringify(expected));
});

if (failures > 0) {
  console.error(`\ncli studio-audit-log pure-layer: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli studio-audit-log pure-layer: all green");
