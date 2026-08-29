/**
 * @indigodb/cli — Studio session auth suite.
 *
 * Plain Node, no test framework (mirrors `studio-write.mjs`/`studio-pagination.mjs`).
 *
 * Phase 1 (this file, unit slice): mint/verify round-trip and every rejection
 * path of `createStudioAuth` against `dist/studio-auth.js` directly — no HTTP
 * server involved yet. Phase 2 adds the `studio-harness.mjs`-backed
 * integration sections (zero-config passthrough, auth-required flow) in the
 * same file.
 */

import { createHmac } from "node:crypto";
import { parse, resolve } from "@indigodb/core";
import {
  createStudioAuth,
  deriveSessionSecret,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../dist/studio-auth.js";
import { withDatabase, withStudio } from "./studio-harness.mjs";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cookieHeaderToValue(setCookieHeader) {
  // `cookieHeader(value, maxAge)` returns a full `Set-Cookie` header text
  // ("<name>=<value>; ..."); extract the raw cookie value the way a client
  // would from a `Cookie:` request header.
  const firstPair = setCookieHeader.split(";")[0];
  const eq = firstPair.indexOf("=");
  return firstPair.slice(eq + 1);
}

function asCookieRequestHeader(value) {
  return `${SESSION_COOKIE}=${value}`;
}

await check("mint/verify round-trip accepts a freshly minted cookie", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const value = auth.mint();
  assert(auth.verify(asCookieRequestHeader(value)) === true, "expected a fresh cookie to verify");
});

await check("verify rejects when no cookie header is present", () => {
  const auth = createStudioAuth("correct horse battery staple");
  assert(auth.verify(undefined) === false, "expected undefined cookie header to reject");
});

await check("verify rejects a tampered payload", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const value = auth.mint();
  const [payloadText, signatureText] = value.split(".");
  const decoded = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...decoded, exp: decoded.exp + 999999 }),
  ).toString("base64url");
  const tampered = `${tamperedPayload}.${signatureText}`;
  assert(auth.verify(asCookieRequestHeader(tampered)) === false, "expected tampered payload to reject");
});

await check("verify rejects a tampered signature", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const value = auth.mint();
  const [payloadText, signatureText] = value.split(".");
  const sigBuf = Buffer.from(signatureText, "base64url");
  sigBuf[0] = sigBuf[0] ^ 0xff;
  const tampered = `${payloadText}.${sigBuf.toString("base64url")}`;
  assert(auth.verify(asCookieRequestHeader(tampered)) === false, "expected tampered signature to reject");
});

await check("verify rejects a truncated cookie", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const value = auth.mint();
  const truncated = value.slice(0, Math.floor(value.length / 2));
  assert(auth.verify(asCookieRequestHeader(truncated)) === false, "expected truncated cookie to reject");
});

await check("verify rejects a wrong v field", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const value = auth.mint();
  const [payloadText] = value.split(".");
  const decoded = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  // Re-mint by hand with v:2 signed under the SAME secret (derived from the
  // same password) — this must still reject on the `v` check, independent
  // of signature validity.
  const badPayloadText = Buffer.from(JSON.stringify({ ...decoded, v: 2 })).toString("base64url");
  // Re-sign so only `v` is wrong, not the signature.
  const secret = createHmac("sha256", "correct horse battery staple")
    .update("indigodb-studio-session-v1")
    .digest("hex");
  const sig = createHmac("sha256", secret).update(badPayloadText).digest().toString("base64url");
  const forged = `${badPayloadText}.${sig}`;
  assert(auth.verify(asCookieRequestHeader(forged)) === false, "expected wrong v to reject");
});

await check("verify rejects an expired cookie", async () => {
  const secret = createHmac("sha256", "correct horse battery staple")
    .update("indigodb-studio-session-v1")
    .digest("hex");
  const expiredPayload = {
    v: 1,
    iat: Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 10,
    exp: Math.floor(Date.now() / 1000) - 10,
  };
  const payloadText = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadText).digest().toString("base64url");
  const expired = `${payloadText}.${sig}`;

  const auth = createStudioAuth("correct horse battery staple");
  assert(auth.verify(asCookieRequestHeader(expired)) === false, "expected expired cookie to reject");
});

await check("verify rejects a cookie signed with a foreign secret", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const foreign = createStudioAuth("a totally different password");
  const value = foreign.mint();
  assert(auth.verify(asCookieRequestHeader(value)) === false, "expected foreign-secret cookie to reject");
});

await check("changing the password changes the derived secret (rotation)", () => {
  const before = createStudioAuth("first-password");
  const cookie = before.mint();

  const after = createStudioAuth("second-password");
  assert(
    after.verify(asCookieRequestHeader(cookie)) === false,
    "expected a cookie minted under the old password to reject once the password rotated",
  );
});

await check("check() uses timingSafeEqual and accepts the correct password", () => {
  const auth = createStudioAuth("correct horse battery staple");
  assert(auth.check("correct horse battery staple") === true, "expected matching password to pass");
  assert(auth.check("wrong password") === false, "expected mismatched password to fail");
  // Different lengths must not throw.
  assert(auth.check("x") === false, "expected a differently-sized password to fail without throwing");
});

await check("cookieHeader sets HttpOnly; SameSite=Strict; Path=/ and no Secure", () => {
  const auth = createStudioAuth("correct horse battery staple");
  const header = auth.cookieHeader(auth.mint(), SESSION_TTL_SECONDS);
  assert(header.includes("HttpOnly"), "expected HttpOnly");
  assert(header.includes("SameSite=Strict"), "expected SameSite=Strict");
  assert(header.includes("Path=/"), "expected Path=/");
  assert(!header.includes("Secure"), "expected no Secure attribute (documented plain-HTTP tradeoff)");
  assert(header.includes(`Max-Age=${SESSION_TTL_SECONDS}`), "expected Max-Age to reflect the given maxAge");
});

// ─── Integration: real startStudio server over real fetch() ────────────────

const SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  bio       String?
  createdAt DateTime @default(now()) @map("created_at")
}
`;

function loadFixture() {
  const ast = parse(SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: SCHEMA_SOURCE };
}

async function seedUsers(db) {
  await db.exec(`
    CREATE TABLE "User" (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      bio TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    INSERT INTO "User" (email, bio) VALUES ('a@example.com', 'hello'), ('b@example.com', 'world');
  `);
}

function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

// ── Zero-config passthrough: no `password` option, nothing changes ─────────

await check("zero-config: GET /api/auth/status reports authRequired:false, no cookie", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.authRequired === false, "expected authRequired:false with no password configured");
      assert(body.authenticated === false, "expected authenticated:false with no password configured");
      assert(extractCookie(res) === null, "expected no Set-Cookie in zero-config mode");
    });
  });
});

await check("zero-config: /api/schema, /api/tables/:t, /api/query, and row writes are unchanged, no Set-Cookie", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const schemaRes = await fetch(`${baseUrl}/api/schema`);
      assert(schemaRes.status === 200, `expected /api/schema 200, got ${schemaRes.status}`);
      assert(extractCookie(schemaRes) === null, "expected no Set-Cookie on /api/schema");

      const tablesRes = await fetch(`${baseUrl}/api/tables/User`);
      assert(tablesRes.status === 200, `expected /api/tables/User 200, got ${tablesRes.status}`);

      const queryRes = await fetch(`${baseUrl}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      assert(queryRes.status === 200, `expected /api/query 200, got ${queryRes.status}`);

      const insertRes = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "c@example.com" }),
      });
      assert(insertRes.status === 201, `expected insert 201, got ${insertRes.status}`);

      const patchRes = await fetch(`${baseUrl}/api/rows/User`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk: { id: 1 }, patch: { bio: "still open" } }),
      });
      assert(patchRes.status === 200, `expected patch 200, got ${patchRes.status}`);

      const deleteRes = await fetch(`${baseUrl}/api/rows/User`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk: { id: 2 } }),
      });
      assert(deleteRes.status === 200, `expected delete 200, got ${deleteRes.status}`);
    });
  });
});

// ── Auth-required flow: `password` option set on withStudio ────────────────

const TEST_PASSWORD = "correct horse battery staple";

await check("auth-required: unauthenticated request to a gated /api/* route is 401", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/schema`);
      assert(res.status === 401, `expected 401, got ${res.status}`);
    }, { password: TEST_PASSWORD });
  });
});

await check("auth-required: unauthenticated row write is 401", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/rows/User`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unauthorized@example.com" }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    }, { password: TEST_PASSWORD });

    const rows = await db.query(`SELECT * FROM "User" WHERE email = 'unauthorized@example.com'`);
    assert(rows.rows.length === 0, "expected no row to have been inserted by an unauthenticated write");
  });
});

await check("auth-required: GET /api/auth/status is ungated and reports authRequired:true, authenticated:false", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.authRequired === true, "expected authRequired:true");
      assert(body.authenticated === false, "expected authenticated:false with no cookie");
    }, { password: TEST_PASSWORD });
  });
});

await check("auth-required: wrong password to login is 401 with the generic message", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
      const body = await res.json();
      assert(body.error === "Invalid password", `expected the generic message, got ${JSON.stringify(body)}`);
      assert(extractCookie(res) === null, "expected no Set-Cookie on failed login");
    }, { password: TEST_PASSWORD });
  });
});

await check(
  "auth-required: correct login issues a cookie that then authorizes the gated routes, including a row write",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        assert(loginRes.status === 200, `expected login 200, got ${loginRes.status}`);
        const cookie = extractCookie(loginRes);
        assert(typeof cookie === "string" && cookie.startsWith(`${SESSION_COOKIE}=`), "expected a session cookie");

        const schemaRes = await fetch(`${baseUrl}/api/schema`, { headers: { cookie } });
        assert(schemaRes.status === 200, `expected authenticated /api/schema 200, got ${schemaRes.status}`);

        const statusRes = await fetch(`${baseUrl}/api/auth/status`, { headers: { cookie } });
        const statusBody = await statusRes.json();
        assert(statusBody.authenticated === true, "expected authenticated:true with a valid cookie");

        const insertRes = await fetch(`${baseUrl}/api/rows/User`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ email: "authorized@example.com" }),
        });
        assert(insertRes.status === 201, `expected authenticated insert 201, got ${insertRes.status}`);
      }, { password: TEST_PASSWORD });
    });
  },
);

await check("auth-required: logout clears the cookie; a subsequent request without a fresh cookie is 401 again", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      const cookie = extractCookie(loginRes);

      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie } });
      assert(logoutRes.status === 200, `expected logout 200, got ${logoutRes.status}`);
      const logoutSetCookie = logoutRes.headers.get("set-cookie") ?? "";
      assert(/max-age=0/i.test(logoutSetCookie), "expected logout to clear the cookie with Max-Age=0");

      const afterRes = await fetch(`${baseUrl}/api/schema`);
      assert(afterRes.status === 401, `expected 401 without a fresh cookie, got ${afterRes.status}`);
    }, { password: TEST_PASSWORD });
  });
});

await check("auth-required: a hand-minted expired cookie is 401", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const secret = deriveSessionSecret(TEST_PASSWORD);
      const expiredPayload = {
        v: 1,
        iat: Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 10,
        exp: Math.floor(Date.now() / 1000) - 10,
      };
      const payloadText = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
      const sig = createHmac("sha256", secret).update(payloadText).digest().toString("base64url");
      const expiredCookie = `${SESSION_COOKIE}=${payloadText}.${sig}`;

      const res = await fetch(`${baseUrl}/api/schema`, { headers: { cookie: expiredCookie } });
      assert(res.status === 401, `expected 401 for an expired cookie, got ${res.status}`);
    }, { password: TEST_PASSWORD });
  });
});

await check("auth-required: the static SPA shell route still returns 200 with no session and no cookie", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/`);
      assert(res.status === 200, `expected the SPA shell to return 200 unauthenticated, got ${res.status}`);
    }, { password: TEST_PASSWORD });
  });
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll studio-auth checks passed.");
}
