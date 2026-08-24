/**
 * @indigodb/cli — `assertLogicalReplication` preflight suite.
 *
 * Mirrors `pull.mjs`'s style: plain Node, no test framework, `process.exit`
 * captured (never really exits the test process). A fake client double
 * satisfies `ReplicationPreflightClient` — no real Postgres connection
 * needed here (that proof lives against real Postgres in
 * `packages/realtime/test/pg-harness.mjs`-gated suites, when available).
 */

import { strictEqual, ok } from "node:assert";
import { assertLogicalReplication } from "../dist/util.js";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli assertLogicalReplication: preflight suite");

/** Builds a fake `ReplicationPreflightClient` from canned per-query responses. */
function fakeClient({ walLevel = "logical", roleOk = true, roleName = "app_user" } = {}) {
  return {
    query: async (sql) => {
      if (sql.includes("wal_level")) return { rows: [{ wal_level: walLevel }] };
      if (sql.includes("pg_roles")) return { rows: [{ ok: roleOk, name: roleName }] };
      throw new Error(`fakeClient: unexpected query: ${sql}`);
    },
  };
}

/** Runs `fn`, capturing `process.exit`/`console.error` — mirrors `pull.mjs`. */
async function captureExit(fn) {
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
    await fn();
  } catch (err) {
    if (err.message !== "__exit__") throw err;
  } finally {
    process.exit = prevExit;
    console.error = prevError;
  }
  return { exitCode, errors };
}

await check("wal_level = logical and REPLICATION privilege present: resolves, nothing applied/exited", async () => {
  const client = fakeClient({ walLevel: "logical", roleOk: true });
  const { exitCode } = await captureExit(() => assertLogicalReplication(client));
  strictEqual(exitCode, undefined);
});

await check("wal_level != logical: exits 1 naming ALTER SYSTEM SET wal_level = logical + restart", async () => {
  const client = fakeClient({ walLevel: "replica" });
  const { exitCode, errors } = await captureExit(() => assertLogicalReplication(client));
  strictEqual(exitCode, 1);
  ok(
    errors.some((l) => l.includes("wal_level")),
    `expected an error naming wal_level, got: ${errors.join("\n")}`,
  );
  ok(
    errors.some((l) => l.includes("ALTER SYSTEM SET wal_level = logical")),
    `expected the exact remediation command, got: ${errors.join("\n")}`,
  );
  ok(
    errors.some((l) => l.toLowerCase().includes("restart")),
    `expected the restart requirement to be named, got: ${errors.join("\n")}`,
  );
});

await check("role lacks REPLICATION/superuser: exits 1 naming ALTER ROLE <user> REPLICATION", async () => {
  const client = fakeClient({ walLevel: "logical", roleOk: false, roleName: "app_user" });
  const { exitCode, errors } = await captureExit(() => assertLogicalReplication(client));
  strictEqual(exitCode, 1);
  ok(
    errors.some((l) => l.includes("REPLICATION")),
    `expected an error naming REPLICATION, got: ${errors.join("\n")}`,
  );
  ok(
    errors.some((l) => l.includes("ALTER ROLE app_user REPLICATION")),
    `expected the exact remediation command naming the connecting role, got: ${errors.join("\n")}`,
  );
});

await check("wal_level check runs BEFORE the role check: a wal_level failure never queries pg_roles", async () => {
  let roleQueried = false;
  const client = {
    query: async (sql) => {
      if (sql.includes("wal_level")) return { rows: [{ wal_level: "replica" }] };
      if (sql.includes("pg_roles")) {
        roleQueried = true;
        return { rows: [{ ok: true, name: "app_user" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await captureExit(() => assertLogicalReplication(client));
  strictEqual(roleQueried, false, "pg_roles must not be queried once wal_level already failed");
});

if (failures > 0) {
  console.error(`\ncli assertLogicalReplication: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli assertLogicalReplication: all green");
