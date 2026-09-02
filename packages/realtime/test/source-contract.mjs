/**
 * Seam-level `RealtimeSource` contract checks (`realtime-source-contract`,
 * RSC-6/RSC-11). No DB, no per-implementation seam overrides — these tests
 * drive the PUBLIC `start`/`stop` surface only, against a genuinely
 * unreachable Postgres host (`127.0.0.1:1`, a port nothing listens on) so
 * the connect attempt fails fast with a real driver error (ECONNREFUSED)
 * rather than hanging on a DNS timeout.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgNotifySource, WalSource } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const UNREACHABLE = "postgres://127.0.0.1:1/db";

// ── RSC-6: PgNotifySource rejects on a first-attempt connect failure ──────
await check("RSC-6: PgNotifySource.start() rejects on an unreachable host, no seam and no DB required", async () => {
  const source = new PgNotifySource(UNREACHABLE, testSchema());
  let caught;
  try {
    await source.start(() => {}, () => {});
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof Error, "start() must reject rather than resolve or hang against an unreachable host");
  ok(
    /ECONNREFUSED/.test(String(caught.code ?? caught.message)),
    `the rejection must carry the underlying connection error, got: ${caught?.message}`,
  );
  // `PgNotifySource`'s own `client.on("end", ...)` reconnect wiring is
  // untouched by this contract and remains armed after a failed start()
  // (`this.stopped` stays false on a first-attempt failure, matching a real
  // caller's own responsibility to call stop() once it gives up) — without
  // this, the underlying socket's own "end" event would schedule a REAL
  // reconnect against the same unreachable host and leak a live handle past
  // this check's own completion.
  await source.stop();
});

// ── RSC-11a: no RealtimeSource signature change (executable, not prose) ───
await check("RSC-11a: start()/stop() keep their exact existing parameter arity for both implementations", () => {
  strictEqual(WalSource.prototype.start.length, 2, "WalSource.start must take exactly (onEvent, onError)");
  strictEqual(PgNotifySource.prototype.start.length, 2, "PgNotifySource.start must take exactly (onEvent, onError)");
  strictEqual(WalSource.prototype.stop.length, 0, "WalSource.stop must take no arguments");
  strictEqual(PgNotifySource.prototype.stop.length, 0, "PgNotifySource.stop must take no arguments");
});

await check("RSC-11a: both implementations still expose exactly the same consumer-facing surface (start/stop/models)", () => {
  // TypeScript's `private` is compile-time only — it does NOT hide a method
  // from runtime reflection, so a literal `Object.getOwnPropertyNames`
  // diff would also list every already-existing private helper method
  // (`connect`, `scheduleReconnect`, `handleMessage`, …) on both classes,
  // which is not what "no widening" means here. This checks the actual
  // consumer-facing contract instead: `start`/`stop` are functions with the
  // arity asserted above, and `models` remains a getter (not a plain
  // widened method) on both classes, exactly as before this capability.
  for (const Ctor of [WalSource, PgNotifySource]) {
    ok(typeof Ctor.prototype.start === "function", `${Ctor.name}.start must remain a function`);
    ok(typeof Ctor.prototype.stop === "function", `${Ctor.name}.stop must remain a function`);
    const modelsDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, "models");
    ok(modelsDescriptor && typeof modelsDescriptor.get === "function", `${Ctor.name}.models must remain a getter`);
    ok(!("resolve" in Ctor.prototype), `${Ctor.name} must not widen its prototype with a new public "resolve" member`);
    ok(!("onReady" in Ctor.prototype), `${Ctor.name} must not widen its prototype with a new public "onReady" member`);
  }
});

// ── RSC-11b: protocol.ts's RealtimeSource interface body is comment-only ──
await check("RSC-11b: RealtimeSource's method signatures are byte-identical to the pre-contract shape (comment-only diff)", () => {
  const protocolPath = fileURLToPath(new URL("../src/protocol.ts", import.meta.url));
  const source = readFileSync(protocolPath, "utf8");
  const match = /export interface RealtimeSource \{([\s\S]*?)\n\}/.exec(source);
  ok(match, "protocol.ts must still declare `export interface RealtimeSource { ... }`");
  // Strip every /** ... */ block comment, then collapse whitespace — what
  // remains is the interface's non-comment content. If this ever stops
  // matching the two known method signatures exactly, either a signature
  // was widened (fails this check, as intended) or a NEW non-comment line
  // was added to the interface body (also fails this check, as intended).
  const nonComment = match[1]
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  strictEqual(
    nonComment,
    "start( onEvent: (event: RealtimeEvent) => void, onError: (error: Error) => void, ): Promise<void>; stop(): Promise<void>;",
    "the interface body's non-comment content must be unchanged — only doc comments may differ",
  );
});

console.log(`\n${passed} passed`);
strictEqual(passed, 4, "expected exactly 4 checks to pass — an omitted or silently-skipped case must shrink this count and fail loudly");
if (process.exitCode) process.exit(process.exitCode);
