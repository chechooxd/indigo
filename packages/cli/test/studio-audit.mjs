/**
 * @indigodb/cli — Studio audit log integration suite.
 *
 * Plain Node, no test framework (mirrors `studio-readonly.mjs`/`studio-write.mjs`).
 * Drives the REAL HTTP server (`startStudio`) over real `fetch()`, backed by a
 * PGlite-backed `StudioDb` adapter (`studio-harness.mjs`), capturing `console.log`
 * around each request to assert on the emitted stdout audit lines.
 *
 * Covers `openspec/changes/studio-audit-log/design.md`'s Testing Strategy rows
 * 18–40 and the restart-rotation scenario (spec `studio-audit-log`, "Correlators
 * do not survive a restart").
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, resolve } from "@indigodb/core";
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

const TEST_PASSWORD = "correct horse battery staple";

function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

async function loginAndGetCookie(baseUrl) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert(loginRes.status === 200, `expected login 200, got ${loginRes.status}`);
  return extractCookie(loginRes);
}

function insertRow(baseUrl, table, values, extraHeaders = {}) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(values),
  });
}

function patchRow(baseUrl, table, pk, patch, extraHeaders = {}) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ pk, patch }),
  });
}

function deleteRow(baseUrl, table, pk, extraHeaders = {}) {
  return fetch(`${baseUrl}/api/rows/${encodeURIComponent(table)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ pk }),
  });
}

/** Captures every `console.log` call made while `fn` runs, restoring it after. */
async function captureLog(fn) {
  const original = console.log;
  const raw = [];
  console.log = (...args) => raw.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return raw;
}

/** Filters captured raw lines down to parsed `studio.audit.write` entries. */
function parseAuditLines(rawLines) {
  const audit = [];
  for (const line of rawLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // not JSON — e.g. a startup banner line
    }
    if (parsed && typeof parsed === "object" && parsed.kind === "studio.audit.write") {
      audit.push(parsed);
    }
  }
  return audit;
}

console.log("@indigodb/cli studio-audit: PGlite-backed audit-log integration suite");

// ── 3.1: successful INSERT/UPDATE/DELETE each emit exactly one `ok` line ───

await check("successful INSERT emits one ok line with op/pk/columns/count", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      let insertedId;
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "insert1@example.com", bio: "new" });
        assert(res.status === 201, `expected 201, got ${res.status}`);
        const body = await res.json();
        insertedId = body.row.id;
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}: ${JSON.stringify(raw)}`);
      const entry = audit[0];
      assert(entry.op === "insert", `expected op:insert, got ${entry.op}`);
      assert(entry.table === "User", `expected table:User, got ${entry.table}`);
      assert(entry.outcome === "ok", `expected outcome:ok, got ${entry.outcome}`);
      assert(entry.count === 1, `expected count:1, got ${entry.count}`);
      assert(
        entry.pk && entry.pk.id === String(insertedId),
        `expected pk.id to be the generated id, got ${JSON.stringify(entry.pk)}`,
      );
      const cols = (entry.columns ?? []).slice().sort();
      assert(
        cols.join(",") === "bio,email",
        `expected columns [bio,email], got ${JSON.stringify(entry.columns)}`,
      );
    }, { auditLog: true });
  });
});

await check("successful UPDATE emits one ok line with op/pk/columns/count", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: "updated" });
        assert(res.status === 200, `expected 200, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
      const entry = audit[0];
      assert(entry.op === "update", `expected op:update, got ${entry.op}`);
      assert(entry.outcome === "ok", `expected outcome:ok, got ${entry.outcome}`);
      assert(entry.count === 1, `expected count:1, got ${entry.count}`);
      assert(entry.pk && entry.pk.id === "1", `expected pk.id:"1", got ${JSON.stringify(entry.pk)}`);
      assert(
        (entry.columns ?? []).join(",") === "bio",
        `expected columns [bio], got ${JSON.stringify(entry.columns)}`,
      );
    }, { auditLog: true });
  });
});

await check("successful DELETE emits one ok line with op/pk/count, no columns key", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await deleteRow(baseUrl, "User", { id: 2 });
        assert(res.status === 200, `expected 200, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
      const entry = audit[0];
      assert(entry.op === "delete", `expected op:delete, got ${entry.op}`);
      assert(entry.outcome === "ok", `expected outcome:ok, got ${entry.outcome}`);
      assert(entry.count === 1, `expected count:1, got ${entry.count}`);
      assert(entry.pk && entry.pk.id === "2", `expected pk.id:"2", got ${JSON.stringify(entry.pk)}`);
      assert(!("columns" in entry), `expected no columns key on a DELETE line, got ${JSON.stringify(entry)}`);
    }, { auditLog: true });
  });
});

// ── 3.2: sentinel absence — the proposal's headline negative ───────────────

const SENTINEL = "ZZ-SENTINEL-9137";

await check("a distinctive non-PK value never appears in captured stdout", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const insertRes = await insertRow(baseUrl, "User", { email: "sentinel@example.com", bio: SENTINEL });
        assert(insertRes.status === 201, `expected insert 201, got ${insertRes.status}`);
        const updateRes = await patchRow(baseUrl, "User", { id: 1 }, { bio: SENTINEL });
        assert(updateRes.status === 200, `expected update 200, got ${updateRes.status}`);
      });
      const joined = raw.join("\n");
      assert(!joined.includes(SENTINEL), `expected the sentinel to be absent from captured stdout, got:\n${joined}`);
      // Sanity: the audit lines DID fire (this isn't a trivially-empty capture).
      const audit = parseAuditLines(raw);
      assert(audit.length === 2, `expected 2 audit lines (insert+update), got ${audit.length}`);
    }, { auditLog: true });
  });
});

// ── 3.3: read-only denial + non-write verb emits nothing ───────────────────

await check("read-only denial emits {outcome:denied, reason:read-only} with no pk/columns", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "blocked@example.com" });
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
      const entry = audit[0];
      assert(entry.outcome === "denied", `expected outcome:denied, got ${entry.outcome}`);
      assert(entry.reason === "read-only", `expected reason:read-only, got ${entry.reason}`);
      assert(entry.op === "insert", `expected op:insert, got ${entry.op}`);
      assert(entry.count === 0, `expected count:0, got ${entry.count}`);
      assert(!("pk" in entry), `expected no pk key on a denial line, got ${JSON.stringify(entry)}`);
      assert(!("columns" in entry), `expected no columns key on a denial line, got ${JSON.stringify(entry)}`);
    }, { auditLog: true, readOnly: true });
  });
});

await check("GET /api/rows/x under read-only still 403s but emits nothing", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await fetch(`${baseUrl}/api/rows/User`);
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 0, `expected zero audit lines for a GET, got ${audit.length}: ${JSON.stringify(raw)}`);
    }, { auditLog: true, readOnly: true });
  });
});

// ── 3.4: invariant sweep — every response is matched by exactly one line ───

await check("invariant sweep: ok/400/404/db-error/denied each produce exactly one matching line", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();

    await withStudio(db, fixture, async ({ baseUrl }) => {
      // ok
      const okRaw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "sweep-ok@example.com" });
        assert(res.status === 201, `expected 201, got ${res.status}`);
      });
      assert(parseAuditLines(okRaw).length === 1, "expected exactly one line for the ok response");

      // 400 — unknown column
      const badRaw = await captureLog(async () => {
        const res = await patchRow(baseUrl, "User", { id: 1 }, { "not-a-real-column": "x" });
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });
      const badAudit = parseAuditLines(badRaw);
      assert(badAudit.length === 1, `expected exactly one line for the 400 response, got ${badAudit.length}`);
      assert(badAudit[0].outcome === "error", `expected outcome:error, got ${badAudit[0].outcome}`);
      assert(badAudit[0].reason === "invalid-request", `expected reason:invalid-request, got ${badAudit[0].reason}`);

      // 404 — no row matched
      const notFoundRaw = await captureLog(async () => {
        const res = await patchRow(baseUrl, "User", { id: 999 }, { bio: "nope" });
        assert(res.status === 404, `expected 404, got ${res.status}`);
      });
      const nfAudit = parseAuditLines(notFoundRaw);
      assert(nfAudit.length === 1, `expected exactly one line for the 404 response, got ${nfAudit.length}`);
      assert(nfAudit[0].outcome === "error", `expected outcome:error, got ${nfAudit[0].outcome}`);
      assert(nfAudit[0].reason === "not-found", `expected reason:not-found, got ${nfAudit[0].reason}`);

      // db-error — unique violation
      const dbErrRaw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "a@example.com" });
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });
      const dbErrAudit = parseAuditLines(dbErrRaw);
      assert(dbErrAudit.length === 1, `expected exactly one line for the db-error response, got ${dbErrAudit.length}`);
      assert(dbErrAudit[0].outcome === "error", `expected outcome:error, got ${dbErrAudit[0].outcome}`);
      assert(dbErrAudit[0].reason === "db-error", `expected reason:db-error, got ${dbErrAudit[0].reason}`);
    }, { auditLog: true });

    // denied — separate read-only instance
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const deniedRaw = await captureLog(async () => {
        const res = await deleteRow(baseUrl, "User", { id: 1 });
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
      const deniedAudit = parseAuditLines(deniedRaw);
      assert(deniedAudit.length === 1, `expected exactly one line for the denied response, got ${deniedAudit.length}`);
      assert(deniedAudit[0].outcome === "denied", `expected outcome:denied, got ${deniedAudit[0].outcome}`);
    }, { auditLog: true, readOnly: true });
  });
});

// ── 3.5: db-error/invalid-request/not-found detail ──────────────────────────

await check("unique-violation write logs outcome:error, reason:db-error, code:23505, no conflicting value", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "a@example.com", bio: "dup" });
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one line, got ${audit.length}`);
      const entry = audit[0];
      assert(entry.outcome === "error", `expected outcome:error, got ${entry.outcome}`);
      assert(entry.reason === "db-error", `expected reason:db-error, got ${entry.reason}`);
      assert(entry.code === "23505", `expected code:23505, got ${entry.code}`);
      const joined = raw.join("\n");
      assert(!joined.includes("a@example.com"), `expected the conflicting value absent from stdout, got:\n${joined}`);
    }, { auditLog: true });
  });
});

await check("400 invalid-column (unknown column) logs reason:invalid-request, count:0, submitted values absent", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await patchRow(baseUrl, "User", { id: 1 }, { "totally-unknown": SENTINEL });
        assert(res.status === 400, `expected 400, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one line, got ${audit.length}`);
      assert(audit[0].outcome === "error", `expected outcome:error, got ${audit[0].outcome}`);
      assert(audit[0].reason === "invalid-request", `expected reason:invalid-request, got ${audit[0].reason}`);
      assert(audit[0].count === 0, `expected count:0, got ${audit[0].count}`);
      assert(!raw.join("\n").includes(SENTINEL), "expected submitted values absent from stdout");
    }, { auditLog: true });
  });
});

await check("404 no-row-matched logs reason:not-found, count:0", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await deleteRow(baseUrl, "User", { id: 999 });
        assert(res.status === 404, `expected 404, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one line, got ${audit.length}`);
      assert(audit[0].outcome === "error", `expected outcome:error, got ${audit[0].outcome}`);
      assert(audit[0].reason === "not-found", `expected reason:not-found, got ${audit[0].reason}`);
      assert(audit[0].count === 0, `expected count:0, got ${audit[0].count}`);
    }, { auditLog: true });
  });
});

// ── 3.6: session correlation ────────────────────────────────────────────────

await check("auth off → no line contains a session key", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        await insertRow(baseUrl, "User", { email: "noauth@example.com" });
        await patchRow(baseUrl, "User", { id: 1 }, { bio: "x" });
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 2, `expected 2 audit lines, got ${audit.length}`);
      for (const entry of audit) {
        assert(!("session" in entry), `expected no session key when auth is off, got ${JSON.stringify(entry)}`);
      }
    }, { auditLog: true });
  });
});

await check(
  "auth on → session present (12 hex), stable across two writes with the same cookie, differs across logins a second apart, raw cookie never logged",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const cookieA = await loginAndGetCookie(baseUrl);

        const rawA = await captureLog(async () => {
          const res1 = await patchRow(baseUrl, "User", { id: 1 }, { bio: "s1" }, { cookie: cookieA });
          assert(res1.status === 200, `expected 200, got ${res1.status}`);
          const res2 = await patchRow(baseUrl, "User", { id: 1 }, { bio: "s2" }, { cookie: cookieA });
          assert(res2.status === 200, `expected 200, got ${res2.status}`);
        });
        const auditA = parseAuditLines(rawA);
        assert(auditA.length === 2, `expected 2 audit lines, got ${auditA.length}`);
        const [sessionA1, sessionA2] = auditA.map((e) => e.session);
        assert(
          typeof sessionA1 === "string" && /^[0-9a-f]{12}$/.test(sessionA1),
          `expected a 12-hex session value, got ${JSON.stringify(sessionA1)}`,
        );
        assert(sessionA1 === sessionA2, `expected the same session across two writes with the same cookie, got ${sessionA1} / ${sessionA2}`);
        assert(!rawA.join("\n").includes(cookieA), "expected the raw cookie value never to appear in captured stdout");

        // A second login, minted at least a second later, must yield a
        // different `session` value (design.md: two logins in the SAME
        // second may collide — that is an accepted property of the cookie
        // format, not of this derivation — so this test deliberately
        // spaces the logins out to avoid that accepted collision).
        await new Promise((r) => setTimeout(r, 1100));
        const cookieB = await loginAndGetCookie(baseUrl);
        const rawB = await captureLog(async () => {
          const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: "s3" }, { cookie: cookieB });
          assert(res.status === 200, `expected 200, got ${res.status}`);
        });
        const auditB = parseAuditLines(rawB);
        assert(auditB.length === 1, `expected 1 audit line, got ${auditB.length}`);
        const sessionB = auditB[0].session;
        assert(
          sessionB !== sessionA1,
          `expected a different session for a distinct login a second apart, got the same value ${sessionB}`,
        );
        assert(!rawB.join("\n").includes(cookieB), "expected the raw cookie value never to appear in captured stdout");
      }, { auditLog: true, password: TEST_PASSWORD });
    });
  },
);

// ── 3.7: unauthenticated 401 + reads emit nothing ───────────────────────────

await check("unauthenticated 401 to /api/rows/* emits no line", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "unauth@example.com" });
        assert(res.status === 401, `expected 401, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 0, `expected zero audit lines for a 401, got ${audit.length}: ${JSON.stringify(raw)}`);
    }, { auditLog: true, password: TEST_PASSWORD });
  });
});

await check("reads (GET /api/tables/:name, POST /api/query, GET /api/schema) emit nothing", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const tablesRes = await fetch(`${baseUrl}/api/tables/User`);
        assert(tablesRes.status === 200, `expected /api/tables/User 200, got ${tablesRes.status}`);
        const queryRes = await fetch(`${baseUrl}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        });
        assert(queryRes.status === 200, `expected /api/query 200, got ${queryRes.status}`);
        const schemaRes = await fetch(`${baseUrl}/api/schema`);
        assert(schemaRes.status === 200, `expected /api/schema 200, got ${schemaRes.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 0, `expected zero audit lines for reads, got ${audit.length}: ${JSON.stringify(raw)}`);
    }, { auditLog: true });
  });
});

// ── 3.8: auditLog:false → zero lines, byte-identical response ──────────────

await check("auditLog:false emits zero lines for a successful write; response byte-identical to auditLog:true", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();

    let onBody, onStatus;
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await insertRow(baseUrl, "User", { email: "identical@example.com", bio: "b" });
      onStatus = res.status;
      onBody = await res.json();
    }, { auditLog: true });

    await withDatabase(async (db2) => {
      await seedUsers(db2);
      let offBody, offStatus;
      const raw = await captureLog(async () => {
        await withStudio(db2, fixture, async ({ baseUrl }) => {
          const res = await insertRow(baseUrl, "User", { email: "identical@example.com", bio: "b" });
          offStatus = res.status;
          offBody = await res.json();
        }, { auditLog: false });
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 0, `expected zero audit lines with auditLog:false, got ${audit.length}`);
      assert(offStatus === onStatus, `expected identical status, got ${offStatus} vs ${onStatus}`);
      const normalize = (b) => ({ ...b, row: { ...b.row, id: undefined, createdAt: undefined } });
      assert(
        JSON.stringify(normalize(offBody)) === JSON.stringify(normalize(onBody)),
        `expected byte-identical response bodies (id/createdAt excluded), got ${JSON.stringify(offBody)} vs ${JSON.stringify(onBody)}`,
      );
    });
  });
});

// ── 3.9: two-option combinations ────────────────────────────────────────────

await check("{readOnly:true, password} denial line carries session and reason:read-only", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const cookie = await loginAndGetCookie(baseUrl);
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "combo@example.com" }, { cookie });
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 1, `expected exactly one line, got ${audit.length}`);
      const entry = audit[0];
      assert(entry.reason === "read-only", `expected reason:read-only, got ${entry.reason}`);
      assert(
        typeof entry.session === "string" && /^[0-9a-f]{12}$/.test(entry.session),
        `expected a session correlator on the denial line, got ${JSON.stringify(entry.session)}`,
      );
    }, { auditLog: true, readOnly: true, password: TEST_PASSWORD });
  });
});

await check("{auditLog:false, readOnly:true} → 403 still returned, no line", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const raw = await captureLog(async () => {
        const res = await insertRow(baseUrl, "User", { email: "combo2@example.com" });
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
      const audit = parseAuditLines(raw);
      assert(audit.length === 0, `expected zero audit lines, got ${audit.length}`);
    }, { auditLog: false, readOnly: true });
  });
});

// ── 3.10: /api/auth/status byte-identical, exact six keys ──────────────────

await check("GET /api/auth/status is byte-identical across --audit-log/--no-audit-log, exactly six keys", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    let onBody;
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      onBody = await res.json();
    }, { auditLog: true });

    await withDatabase(async (db2) => {
      await seedUsers(db2);
      let offBody;
      await withStudio(db2, fixture, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        offBody = await res.json();
      }, { auditLog: false });

      assert(
        JSON.stringify(onBody) === JSON.stringify(offBody),
        `expected byte-identical probe responses, got ${JSON.stringify(onBody)} vs ${JSON.stringify(offBody)}`,
      );
      const keys = Object.keys(onBody).sort();
      // `schemaWritable` (PR #1b, studio-schema-write) added a seventh key,
      // and `layoutWritable` (studio-layout-persistence) an eighth — updated
      // here deliberately, not a silent drift: the byte-identical assertion
      // above is what actually matters for this suite's own scope
      // (audit-log on/off must not change the probe body), and still holds.
      const expected = [
        "authRequired",
        "authenticated",
        "environment",
        "layoutWritable",
        "queryRowCap",
        "queryTimeoutMs",
        "readOnly",
        "schemaWritable",
      ].sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(expected),
        `expected exactly the eight probe keys, got ${JSON.stringify(keys)}`,
      );
    });
  });
});

// ── 3.11: no file/directory is ever created ─────────────────────────────────

await check("no file or directory is created under cwd across several writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indigo-audit-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      await withStudio(db, fixture, async ({ baseUrl }) => {
        await insertRow(baseUrl, "User", { email: "nofile1@example.com" });
        await patchRow(baseUrl, "User", { id: 1 }, { bio: "nofile" });
        await deleteRow(baseUrl, "User", { id: 2 });
      }, { auditLog: true });
    });
    const entries = readdirSync(dir);
    assert(entries.length === 0, `expected no files/directories created, got: ${entries.join(", ")}`);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3.12: startup block prints the resolved audit-log state ────────────────

await check("startup block prints 'Audit log: enabled' when audit logging is on", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    const raw = await captureLog(async () => {
      await withStudio(db, fixture, async () => {}, { auditLog: true });
    });
    const joined = raw.join("\n");
    assert(/Audit log: enabled/.test(joined), `expected an "Audit log: enabled" startup line, got:\n${joined}`);
  });
});

await check("startup block prints 'Audit log: disabled' when audit logging is off", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    const raw = await captureLog(async () => {
      await withStudio(db, fixture, async () => {}, { auditLog: false });
    });
    const joined = raw.join("\n");
    assert(/Audit log: disabled/.test(joined), `expected an "Audit log: disabled" startup line, got:\n${joined}`);
  });
});

// ── 3.13: control — auditLog:true alone is not an enforcement input ────────

await check("control: auditLog:true alone leaves writes succeeding and guardrails at defaults", async () => {
  await withDatabase(async (db) => {
    await seedUsers(db);
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const insertRes = await insertRow(baseUrl, "User", { email: "control@example.com" });
      assert(insertRes.status === 201, `expected insert to succeed (201), got ${insertRes.status}`);

      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const statusBody = await statusRes.json();
      assert(statusBody.readOnly === false, `expected readOnly:false, got ${statusBody.readOnly}`);
      assert(statusBody.authRequired === false, `expected authRequired:false, got ${statusBody.authRequired}`);
      assert(statusBody.queryTimeoutMs === 30000, `expected default queryTimeoutMs, got ${statusBody.queryTimeoutMs}`);
      assert(statusBody.queryRowCap === 1000, `expected default queryRowCap, got ${statusBody.queryRowCap}`);
    }, { auditLog: true });
  });
});

// ── 3.14: regex sweep — no forbidden identity wording anywhere ─────────────
//
// Deliberately uses a table named "Account" (never "User") for this one
// check: the sweep must catch wording THIS CHANGE introduces (field names,
// static log/startup text), not an incidental substring match against a
// fixture's own table/column names, which are legitimate arbitrary data the
// audit log is explicitly allowed to carry (e.g. table names).

const ACCOUNT_SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table Account {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

function loadAccountFixture() {
  const ast = parse(ACCOUNT_SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: ACCOUNT_SCHEMA_SOURCE };
}

async function seedAccounts(db) {
  await db.exec(`
    CREATE TABLE "Account" (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL
    );
    INSERT INTO "Account" (email) VALUES ('a@example.com'), ('b@example.com');
  `);
}

await check("no captured line, message, or startup string contains user/actor/by/who", async () => {
  await withDatabase(async (db) => {
    await seedAccounts(db);
    const fixture = loadAccountFixture();
    const raw = await captureLog(async () => {
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const cookie = await loginAndGetCookie(baseUrl);
        await insertRow(baseUrl, "Account", { email: "sweep1@example.com" }, { cookie });
        await patchRow(baseUrl, "Account", { id: 1 }, { email: "sweep2@example.com" }, { cookie });
        await deleteRow(baseUrl, "Account", { id: 2 }, { cookie });
        await insertRow(baseUrl, "Account", { email: "a@example.com" }, { cookie }); // db-error
      }, { auditLog: true, password: TEST_PASSWORD });
    });
    const forbidden = /\b(user|actor|who)\b/i;
    for (const line of raw) {
      assert(!forbidden.test(line), `expected no forbidden identity wording, found it in: ${line}`);
    }
  });
});

// ── 3.15: restart rotation — session differs across successive instances ───

await check(
  "restart rotation: same client, same still-valid cookie, session differs across two successive startStudio instances",
  async () => {
    await withDatabase(async (db) => {
      await seedUsers(db);
      const fixture = loadFixture();
      let cookie;
      let session1;

      await withStudio(db, fixture, async ({ baseUrl }) => {
        cookie = await loginAndGetCookie(baseUrl);
        const raw = await captureLog(async () => {
          const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: "restart-1" }, { cookie });
          assert(res.status === 200, `expected 200, got ${res.status}`);
        });
        const audit = parseAuditLines(raw);
        assert(audit.length === 1, `expected 1 audit line, got ${audit.length}`);
        session1 = audit[0].session;
        assert(
          typeof session1 === "string" && /^[0-9a-f]{12}$/.test(session1),
          `expected a 12-hex session value, got ${JSON.stringify(session1)}`,
        );
      }, { auditLog: true, password: TEST_PASSWORD });

      let session2;
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const raw = await captureLog(async () => {
          const res = await patchRow(baseUrl, "User", { id: 1 }, { bio: "restart-2" }, { cookie });
          assert(res.status === 200, `expected 200 (same cookie must still be valid across restart), got ${res.status}`);
        });
        const audit = parseAuditLines(raw);
        assert(audit.length === 1, `expected 1 audit line, got ${audit.length}`);
        session2 = audit[0].session;
      }, { auditLog: true, password: TEST_PASSWORD });

      assert(
        session1 !== session2,
        `expected the session correlator to differ across a restart (key must regenerate, never persist/hardcode), got the same value ${session1} both times`,
      );
    });
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-audit: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-audit: all green");
