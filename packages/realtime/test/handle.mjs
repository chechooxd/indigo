/**
 * Unit suite (no DB) for `packages/realtime/src/handle.ts`
 * (`realtime-live-endpoint` tasks A1.1-A1.3).
 *
 * Every failure mode collapses to `verifyHandle` returning `null` —
 * uniformly, and WITHOUT throwing. `crypto.timingSafeEqual` throws on
 * unequal-length buffers, so the truncated-signature case specifically
 * proves the length check runs before the compare.
 */
import { strictEqual, ok, doesNotThrow } from "node:assert";
import { createHmac } from "node:crypto";
import { mintHandle, verifyHandle, DEFAULT_HANDLE_TTL_SECONDS } from "../dist/index.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SECRET = "test-secret-do-not-use-in-prod";

console.log("realtime handle: mint/verify round-trip and forgery/tamper resistance (unit, no DB)");

// ── A1.1 — round-trip + mandatory exp ──────────────────────────────────────

check("A1.1: mintHandle/verifyHandle round-trips {table, userId}", () => {
  const token = mintHandle({ table: "Order", userId: "u1", ttl: 3600 }, SECRET);
  const verified = verifyHandle(token, SECRET);
  ok(verified, "expected a successful verification");
  strictEqual(verified.table, "Order");
  strictEqual(verified.userId, "u1");
});

check("A1.1: mint without ttl defaults exp to ~1h from mint time", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = mintHandle({ table: "Order", userId: "u1" }, SECRET);
  const [payloadText] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  ok(payload.exp !== undefined && payload.exp !== null, "exp must be present");
  const delta = payload.exp - before;
  ok(
    Math.abs(delta - DEFAULT_HANDLE_TTL_SECONDS) <= 5,
    `expected exp ~${DEFAULT_HANDLE_TTL_SECONDS}s from mint, got delta ${delta}`,
  );
});

check("A1.1: exp is always present on the signed payload — mintHandle has no way to omit it", () => {
  const token = mintHandle({ table: "Order", userId: "u1" }, SECRET);
  const [payloadText] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  strictEqual(typeof payload.exp, "number");
  ok(payload.exp > 0);
});

// ── A1.2 — forgery/tamper threat battery ───────────────────────────────────

check("A1.2 (threat: tamper): re-encoding the payload with a different u, WITHOUT re-signing, is rejected", () => {
  const token = mintHandle({ table: "Order", userId: "u1", ttl: 3600 }, SECRET);
  const [, signatureText] = token.split(".");
  const original = JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
  );
  const tampered = { ...original, u: "attacker" };
  const tamperedPayloadText = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
  const forged = `${tamperedPayloadText}.${signatureText}`;
  strictEqual(verifyHandle(forged, SECRET), null);
});

check("A1.2 (threat: tamper): flipping a bit in the signature segment is rejected", () => {
  const token = mintHandle({ table: "Order", userId: "u1", ttl: 3600 }, SECRET);
  const [payloadText, signatureText] = token.split(".");
  const sigBuf = Buffer.from(signatureText, "base64url");
  sigBuf[0] ^= 0xff; // flip every bit of the first byte
  const tamperedSig = sigBuf.toString("base64url");
  const forged = `${payloadText}.${tamperedSig}`;
  strictEqual(verifyHandle(forged, SECRET), null);
});

check("A1.2 (threat: version): an unrecognized v:2 payload, correctly signed, is rejected", () => {
  // Hand-crafted: mintHandle only ever produces v:1, so this signs a v:2
  // payload directly with the same signing scheme to prove verifyHandle
  // itself — not just mintHandle — rejects it.
  const payload = { v: 2, t: "Order", u: "u1", exp: Math.floor(Date.now() / 1000) + 3600 };
  const payloadText = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payloadText).digest().toString("base64url");
  strictEqual(verifyHandle(`${payloadText}.${sig}`, SECRET), null);
});

check("A1.2 (threat: expiry): an expired exp, with a valid signature, is rejected", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = mintHandle({ table: "Order", userId: "u1", ttl: -10 }, SECRET);
  const [payloadText] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  ok(payload.exp < nowSeconds, "sanity: this handle's exp must already be in the past");
  strictEqual(verifyHandle(token, SECRET), null);
});

check("A1.2 (threat: truncated signature) does NOT throw and returns null — length check runs before timingSafeEqual", () => {
  const token = mintHandle({ table: "Order", userId: "u1", ttl: 3600 }, SECRET);
  const [payloadText, signatureText] = token.split(".");
  const truncatedSig = signatureText.slice(0, Math.max(1, Math.floor(signatureText.length / 3)));
  const truncated = `${payloadText}.${truncatedSig}`;
  let result;
  doesNotThrow(() => {
    result = verifyHandle(truncated, SECRET);
  }, "verifyHandle must never throw on a truncated signature — timingSafeEqual would throw on unequal lengths");
  strictEqual(result, null);
});

check("A1.2: malformed token (no dot separator) is rejected without throwing", () => {
  let result;
  doesNotThrow(() => {
    result = verifyHandle("not-a-valid-handle", SECRET);
  });
  strictEqual(result, null);
});

check("A1.2: empty string / non-string tokens are rejected without throwing", () => {
  doesNotThrow(() => strictEqual(verifyHandle("", SECRET), null));
  doesNotThrow(() => strictEqual(verifyHandle(undefined, SECRET), null));
});

// ── Uniform opaque failure: every failure mode above returns the exact
// same `null` — the endpoint layer (engine.ts) is what turns `null` into
// one byte-identical 401, asserted in endpoint.mjs. ─────────────────────

// ── Secret handling ─────────────────────────────────────────────────────

check("secret handling: the secret itself never appears inside a minted token", () => {
  const token = mintHandle({ table: "Order", userId: "u1" }, SECRET);
  ok(!token.includes(SECRET), "the raw secret must never appear in the token");
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
