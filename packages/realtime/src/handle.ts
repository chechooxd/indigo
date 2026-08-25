/**
 * @indigodb/realtime — Signed handle minting/verification
 *
 * `node:crypto` lives HERE, never in `protocol.ts` — that file is imported
 * type-only by `@indigodb/client` and its header forbids runtime code
 * (browser bundles must never pull in `node:crypto`).
 *
 * A handle is `base64url(payload) "." base64url(HMAC-SHA256(<payload text>, secret))`.
 * The HMAC signs the exact base64url PAYLOAD TEXT that will be re-verified —
 * never a re-serialized/re-canonicalized form of the decoded JSON (design
 * decision 6) — so verification never depends on JSON key order or number
 * formatting.
 *
 * Every failure mode (tampered payload, tampered signature, unrecognized
 * `v`, expired `exp`, malformed/truncated input) collapses to `null`,
 * uniformly. `verifyHandle` never throws: `timingSafeEqual` throws on
 * unequal-length buffers, so the length check runs BEFORE the compare.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The signed handle payload. `exp` is mandatory — never absent/undefined/0. */
export interface HandlePayload {
  v: 1;
  /** Model (schema) table name this handle is bound to. */
  t: string;
  /** Identity claim, coerced to a string (same coercion as `$authSession`). */
  u: string;
  /** Unix seconds expiry. */
  exp: number;
}

/** Default handle TTL when `mintHandle` is called without `ttl`: ~1 hour. */
export const DEFAULT_HANDLE_TTL_SECONDS = 3600;

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** `null` on any malformed base64url input rather than throwing. */
function base64urlDecode(text: string): Buffer | null {
  try {
    return Buffer.from(text, "base64url");
  } catch {
    return null;
  }
}

function sign(payloadText: string, secret: string): string {
  return base64urlEncode(createHmac("sha256", secret).update(payloadText).digest());
}

/**
 * Mints a signed handle. `exp` is always computed from `ttl` (defaulting to
 * `DEFAULT_HANDLE_TTL_SECONDS`) — there is no way to call this without an
 * `exp` landing on the signed payload.
 */
export function mintHandle(
  options: { table: string; userId: string | number; ttl?: number },
  secret: string,
): string {
  const ttl = options.ttl ?? DEFAULT_HANDLE_TTL_SECONDS;
  const payload: HandlePayload = {
    v: 1,
    t: options.table,
    u: String(options.userId),
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const payloadText = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadText, secret);
  return `${payloadText}.${signature}`;
}

/**
 * Verifies a handle. Returns `{table, userId}` on success, `null` on ANY
 * failure — callers MUST NOT branch on why (the endpoint's opaque 401
 * depends on this). Never throws.
 */
export function verifyHandle(
  token: string,
  secret: string,
): { table: string; userId: string } | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadText = token.slice(0, dot);
  const signatureText = token.slice(dot + 1);

  const expectedSignature = sign(payloadText, secret);
  const expectedBuf = base64urlDecode(expectedSignature);
  const actualBuf = base64urlDecode(signatureText);
  if (!expectedBuf || !actualBuf) return null;

  // Length check FIRST: `timingSafeEqual` throws on unequal-length buffers,
  // so an attacker-supplied truncated/oversized signature must not crash
  // into a 500 upstream — it must cleanly fall through to the same `null`.
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  const payloadBuf = base64urlDecode(payloadText);
  if (!payloadBuf) return null;

  let payload: HandlePayload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return null;
  }

  if (payload == null || typeof payload !== "object") return null;
  if (payload.v !== 1) return null;
  if (typeof payload.t !== "string" || payload.t.length === 0) return null;
  if (typeof payload.u !== "string" || payload.u.length === 0) return null;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return { table: payload.t, userId: payload.u };
}
