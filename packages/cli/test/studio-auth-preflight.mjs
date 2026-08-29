/**
 * @indigodb/cli — `assertStudioAuthForHost` preflight suite
 * (`studio-session-auth` task 2.1/2.2).
 *
 * Mirrors `realtime-secret-preflight.mjs`'s style: plain Node, no test
 * framework, `process.exit`/`console.error` captured (never really exits the
 * test process).
 *
 * Per design ("Preflight (`util.ts`, `process.exit(1)` like its siblings)"),
 * the check is HOST-CONDITIONAL: it fails only when the Studio is bound
 * beyond loopback (`--host` anything other than `127.0.0.1`/`::1`/
 * `localhost`) AND no `INDIGODB_STUDIO_PASSWORD` is configured.
 */

import { strictEqual, ok } from "node:assert";
import { assertStudioAuthForHost } from "../dist/util.js";

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

console.log("cli assertStudioAuthForHost: preflight suite");

/** Runs `fn`, capturing `process.exit`/`console.error` — mirrors `realtime-secret-preflight.mjs`. */
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

check("non-loopback host, no password: exits 1 naming INDIGODB_STUDIO_PASSWORD", () => {
  const { exitCode, errors } = captureExit(() => assertStudioAuthForHost("0.0.0.0", undefined));
  strictEqual(exitCode, 1);
  ok(
    errors.some((l) => l.includes("INDIGODB_STUDIO_PASSWORD")),
    `expected an error naming the missing env var, got: ${errors.join("\n")}`,
  );
  ok(
    errors.some((l) => l.includes("--host")),
    `expected the error to name --host as the trigger, got: ${errors.join("\n")}`,
  );
});

check("non-loopback host (LAN IP), no password: exits 1", () => {
  const { exitCode } = captureExit(() => assertStudioAuthForHost("192.168.1.50", undefined));
  strictEqual(exitCode, 1);
});

check("non-loopback host, empty-string password: exits 1 (falsy, not just undefined)", () => {
  const { exitCode } = captureExit(() => assertStudioAuthForHost("0.0.0.0", ""));
  strictEqual(exitCode, 1);
});

check("loopback host (127.0.0.1), no password: does not exit", () => {
  const { exitCode } = captureExit(() => assertStudioAuthForHost("127.0.0.1", undefined));
  strictEqual(exitCode, undefined);
});

check("loopback host (::1), no password: does not exit", () => {
  const { exitCode } = captureExit(() => assertStudioAuthForHost("::1", undefined));
  strictEqual(exitCode, undefined);
});

check("loopback host (localhost), no password: does not exit", () => {
  const { exitCode } = captureExit(() => assertStudioAuthForHost("localhost", undefined));
  strictEqual(exitCode, undefined);
});

check("non-loopback host, password set: does not exit", () => {
  const { exitCode } = captureExit(() =>
    assertStudioAuthForHost("0.0.0.0", "correct horse battery staple"),
  );
  strictEqual(exitCode, undefined);
});

if (failures > 0) {
  console.error(`\ncli assertStudioAuthForHost: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli assertStudioAuthForHost: all green");
