/**
 * @indigodb/cli — `indigodb realtime` daemon fail-fast suite (RSC-12).
 *
 * Mirrors `studio-readonly-resolution.mjs`'s wiring-check style: no existing
 * file under `packages/cli/test` previously spawned the built CLI's
 * `realtime` command, so this is a new pattern. `resolveConnectionString`
 * throwing/exiting is inert unless `index.ts`'s `realtime` action actually
 * catches a REJECTED `engine.start()` and exits before `server.listen` — a
 * unit test against `assertRealtimeSecretPresent` or similar cannot prove
 * that wiring, only a real subprocess against an unroutable Postgres can.
 *
 * `postgres://127.0.0.1:1/db` is an unroutable port, not a DNS-dependent
 * hostname (resolver-dependent and slow) — matches the design's own choice
 * for the seam-level RSC-6 check.
 */

import { strictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("cli realtime: fail-fast suite (RSC-12)");

const SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
  url = "postgres://127.0.0.1:1/db"
}

Table Post {
  id    Int    @id @default(autoincrement())
  title String

  @@realtime
}
`;

const cliDistDir = fileURLToPath(new URL("../dist", import.meta.url));
const cliEntry = join(cliDistDir, "index.js");
const tmpCwd = mkdtempSync(join(tmpdir(), "indigodb-realtime-fail-fast-"));
const schemaPath = join(tmpCwd, "schema.indigo");
writeFileSync(schemaPath, SCHEMA_SOURCE);

// A fixed, unbound port for the daemon to (not) listen on — chosen well
// outside common ephemeral ranges to avoid flaky collisions.
const DAEMON_PORT = 48173;

try {
  check(
    "a rejected engine.start() exits non-zero, prints the driver error, and never binds the port",
    () => {
      const result = spawnSync(process.execPath, [cliEntry, "realtime", "--schema", "schema.indigo", "--port", String(DAEMON_PORT)], {
        cwd: tmpCwd,
        env: { ...process.env, INDIGODB_REALTIME_SECRET: "" },
        encoding: "utf-8",
        timeout: 20_000,
      });

      const stderr = result.stderr ?? "";
      ok(result.status !== 0, `expected a non-zero exit, got status=${result.status}, stderr=${stderr}`);
      ok(
        /ECONNREFUSED|connect|refused/i.test(stderr),
        `expected stderr to contain the underlying driver/connection error, got: ${stderr}`,
      );
      ok(stderr.includes("Realtime failed to start"), `expected the fail-fast message, got: ${stderr}`);
    },
  );

  // MUST be `checkAsync`: `check` is synchronous, so an async fn would hand
  // it a promise it never awaits — the assertion below would run orphaned
  // and the case would report `ok` unconditionally.
  await checkAsync("the daemon's port was never bound", async () => {
    const stillFree = await new Promise((resolvePromise) => {
      const probe = net.createConnection({ host: "127.0.0.1", port: DAEMON_PORT }, () => {
        probe.destroy();
        resolvePromise(false);
      });
      probe.on("error", () => resolvePromise(true));
    });
    strictEqual(stillFree, true, "expected the daemon's port to remain unbound after a rejected start()");
  });
} finally {
  rmSync(tmpCwd, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncli realtime fail-fast: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli realtime fail-fast: all green");
