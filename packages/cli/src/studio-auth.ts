/**
 * @indigodb/cli — Studio session auth
 *
 * Optional shared-password session gate for `indigodb studio`. Reuses
 * `@indigodb/realtime`'s `handle.ts` signing primitive exactly:
 * `base64url(payload) "." base64url(HMAC-SHA256(<payload text>, secret))`,
 * signing the exact base64url PAYLOAD TEXT that will be re-verified (never a
 * re-serialized form of the decoded JSON), with the length check running
 * BEFORE `timingSafeEqual` (which throws on unequal-length buffers).
 *
 * No KDF: the secret is derived once via a fixed-context HMAC over the raw
 * password (`deriveSessionSecret`), never stored, and never leaves the
 * process — matching `handle.ts`'s single primitive rather than introducing
 * a second scheme (scrypt/HKDF would buy nothing here: rotation already
 * invalidates prior sessions by construction, since the secret itself
 * changes with the password).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Fixed context string, domain-separating this secret from any other HMAC
 * use of the same password (there is none today, but this costs nothing). */
const SESSION_SECRET_CONTEXT = "indigodb-studio-session-v1";

/** Name of the cookie carrying the signed session value. */
export const SESSION_COOKIE = "indigodb_studio_session";

/** Fixed session TTL: 24 hours, no sliding renewal. */
export const SESSION_TTL_SECONDS = 86400;

/** The signed session cookie payload. `v` allows a future format change. */
export interface SessionPayload {
  v: 1;
  /** Unix seconds — issued at. */
  iat: number;
  /** Unix seconds — expiry. Mandatory, never absent/undefined/0. */
  exp: number;
}

/**
 * Derives the HMAC signing secret from the configured Studio password. Pure
 * function of `password` — the same password always yields the same secret,
 * and a different password always yields a different one, which is exactly
 * what makes password rotation invalidate every previously minted session.
 */
export function deriveSessionSecret(password: string): string {
  return createHmac("sha256", password).update(SESSION_SECRET_CONTEXT).digest("hex");
}

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

/** Mints a signed session cookie value: `{v:1, iat, exp}` -> base64url -> signed. */
export function mintSession(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { v: 1, iat: now, exp: now + SESSION_TTL_SECONDS };
  const payloadText = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadText, secret);
  return `${payloadText}.${signature}`;
}

/**
 * Extracts the named cookie's raw value from a `Cookie:` request header.
 * `null` when the header is absent or the cookie is not present.
 */
export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Verifies a session cookie value (already extracted from the `Cookie:`
 * header via `parseCookie`, or the raw `value.signature` token). Every
 * failure mode collapses to `false`, uniformly — callers MUST NOT branch on
 * why. Never throws.
 */
export function verifySessionToken(token: string | null, secret: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadText = token.slice(0, dot);
  const signatureText = token.slice(dot + 1);

  const expectedSignature = sign(payloadText, secret);
  const expectedBuf = base64urlDecode(expectedSignature);
  const actualBuf = base64urlDecode(signatureText);
  if (!expectedBuf || !actualBuf) return false;

  // Length check FIRST: `timingSafeEqual` throws on unequal-length buffers,
  // so an attacker-supplied truncated/oversized signature must not crash —
  // it must cleanly fall through to `false`.
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  const payloadBuf = base64urlDecode(payloadText);
  if (!payloadBuf) return false;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return false;
  }

  if (payload == null || typeof payload !== "object") return false;
  if (payload.v !== 1) return false;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
  if (payload.exp < Math.floor(Date.now() / 1000)) return false;

  return true;
}

/**
 * Verifies a raw `Cookie:` request header: extracts `SESSION_COOKIE` and
 * checks it against `secret`. `false` when the header is absent, the cookie
 * is missing, or the cookie fails `verifySessionToken`.
 */
export function verifySession(cookieHeader: string | undefined, secret: string): boolean {
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  return verifySessionToken(token, secret);
}

/**
 * The Studio auth port bound to one derived secret (and therefore one
 * configured password). `startStudio` computes this once at startup —
 * `password ? createStudioAuth(password) : null` — never per-request.
 */
export interface StudioAuth {
  /** Mints a fresh signed session cookie value (not a full `Set-Cookie` header). */
  mint(): string;
  /** Verifies a raw `Cookie:` request header against this instance's secret. */
  verify(cookieHeader: string | undefined): boolean;
  /**
   * Constant-time comparison of a submitted password against the configured
   * one. Compares SHA-256 digests of both strings (equal length by
   * construction) rather than the raw strings — avoids both a length leak
   * and a `timingSafeEqual` throw on differently-sized raw input.
   */
  check(submittedPassword: string): boolean;
  /** Builds a full `Set-Cookie` header value for the given session value and max-age (seconds). */
  cookieHeader(value: string, maxAge: number): string;
}

/**
 * Builds the `StudioAuth` port for one configured `password`. The secret is
 * derived once here, not per-call.
 */
export function createStudioAuth(password: string): StudioAuth {
  const secret = deriveSessionSecret(password);

  return {
    mint() {
      return mintSession(secret);
    },
    verify(cookieHeader) {
      return verifySession(cookieHeader, secret);
    },
    check(submittedPassword) {
      const expectedDigest = createHash("sha256").update(password).digest();
      const actualDigest = createHash("sha256").update(submittedPassword).digest();
      // Both are fixed-length SHA-256 digests, so lengths always match and
      // `timingSafeEqual` never throws regardless of the raw input lengths —
      // this is what avoids both a length leak and a mismatched-length throw.
      return timingSafeEqual(expectedDigest, actualDigest);
    },
    cookieHeader(value, maxAge) {
      return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    },
  };
}
