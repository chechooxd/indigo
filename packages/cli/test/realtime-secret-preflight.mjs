/**
 * @indigodb/cli — `assertRealtimeSecretPresent` preflight suite
 * (`realtime-live-endpoint` task B2.2).
 *
 * Mirrors `preflight.mjs`'s style: plain Node, no test framework,
 * `process.exit`/`console.error` captured (never really exits the test
 * process). Hand-built minimal `ResolvedSchema`-shaped fixtures — no real
 * schema parse needed, only `.tables[].realtime`/`.allow` matter to this
 * check.
 *
 * Per spec (`Requirement: Daemon startup preflight requires the signing
 * secret`), the check is SCHEMA-CONDITIONAL: it fails only when a resolved
 * model is BOTH `@@realtime` and `@@allow`, not unconditionally whenever the
 * env var happens to be unset (that broader unconditional form was PR A's
 * intentional safe-direction deviation — this PR narrows it to match spec).
 */

import { strictEqual, ok } from "node:assert";
import { assertRealtimeSecretPresent } from "../dist/util.js";

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

console.log("cli assertRealtimeSecretPresent: preflight suite");

/** Runs `fn`, capturing `process.exit`/`console.error` — mirrors `preflight.mjs`. */
function captureExit(fn) {
  const prevExit = process.exit;
  const prevError = console.error;
  const errors = [];
  let exitCode;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  console.error = (...args) => errors.push(args.join(" "));
  try {
    fn();
  } catch (err) {
    if (err.message !== "__exit__") throw err;
  } finally {
    process.exit = prevExit;
    console.error = prevError;
  }
  return { exitCode, errors };
}

function schemaWith(tables) {
  return { tables };
}

check("schema with a @@realtime+@@allow model, secret UNSET: exits 1 naming the missing env var", () => {
  const schema = schemaWith([{ name: "Order", realtime: true, allow: [{ action: "read" }] }]);
  const { exitCode, errors } = captureExit(() => assertRealtimeSecretPresent(schema, undefined));
  strictEqual(exitCode, 1);
  ok(
    errors.some((l) => l.includes("INDIGODB_REALTIME_SECRET")),
    `expected an error naming the missing env var, got: ${errors.join("\n")}`,
  );
});

check("schema with a @@realtime+@@allow model, secret SET: does not exit", () => {
  const schema = schemaWith([{ name: "Order", realtime: true, allow: [{ action: "read" }] }]);
  const { exitCode } = captureExit(() => assertRealtimeSecretPresent(schema, "a-real-secret"));
  strictEqual(exitCode, undefined);
});

check("schema with NO model combining @@realtime and @@allow, secret UNSET: does not exit", () => {
  const schema = schemaWith([
    { name: "Post", realtime: true },
    { name: "Draft", allow: [{ action: "read" }] },
  ]);
  const { exitCode } = captureExit(() => assertRealtimeSecretPresent(schema, undefined));
  strictEqual(exitCode, undefined);
});

check(
  "schema with a create-only @@allow + @@realtime model, secret UNSET: STILL exits (any @@allow block counts, not just read)",
  () => {
    const schema = schemaWith([{ name: "Invoice", realtime: true, allow: [{ action: "create" }] }]);
    const { exitCode } = captureExit(() => assertRealtimeSecretPresent(schema, undefined));
    strictEqual(exitCode, 1);
  },
);

if (failures > 0) {
  console.error(`\ncli assertRealtimeSecretPresent: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli assertRealtimeSecretPresent: all green");
