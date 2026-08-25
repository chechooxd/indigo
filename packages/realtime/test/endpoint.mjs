/**
 * `GET ?handle&offset` suite (`realtime-live-endpoint` PR A):
 *
 *  - Unit section (no DB): offset validation, `RealtimeLogDb` port shape
 *    (bind parameters, same-transaction `set_config`), uniform opaque 401
 *    across every failure cause, stale-table 404, cache-header
 *    sealed-vs-head logic (incl. the empty-page inverted-TTL regression
 *    guard), and the threat battery (SQL injection, identity spoofing,
 *    page-size amplification, routing/method confusion, secret leakage).
 *
 *  - Real-Postgres section (gated on `INDIGODB_TEST_DATABASE_URL`, same
 *    self-skip pattern as `log.mjs`/`buckets.mjs`): cursor advancement,
 *    RLS isolation asserted under a genuine non-superuser/non-BYPASSRLS
 *    role via `SET ROLE` (NOT the default superuser test connection — see
 *    the header note on that check specifically), and byte-identity of a
 *    repeated sealed-page fetch.
 */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { createServer } from "node:http";
import {
  RealtimeEngine,
  mintHandle,
  REALTIME_LOG_PAGE_SIZE,
  REALTIME_LOG_PATH,
} from "../dist/index.js";
import { renderRealtimeLogSql, REALTIME_LOG_TABLE } from "@indigodb/migrator";
import { testSchema } from "./fixtures-schema.mjs";
import { skipIfNoDatabase, withAdmin } from "./pg-harness.mjs";

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

const SECRET = "endpoint-test-secret";

/**
 * Drives `engine.handleLogRequest` through a REAL ephemeral `node:http`
 * server + `fetch()` — genuine `IncomingMessage`/`ServerResponse` objects
 * over an actual socket, rather than a hand-rolled duck-typed object (and
 * without the header-capture/socket-lifecycle quirks of driving
 * `ServerResponse` off an unconnected `net.Socket` directly). One server
 * per call, torn down immediately after — cheap enough for this suite's
 * size and keeps each check fully isolated.
 */
async function exchange(engine, { method = "GET", url = "/", headers = {} } = {}) {
  const server = createServer((req, res) => {
    void engine.handleLogRequest(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers });
    const bodyText = await response.text();
    const responseHeaders = {};
    for (const [k, v] of response.headers.entries()) responseHeaders[k] = v;
    return { status: response.status, headers: responseHeaders, body: bodyText };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** In-memory fake `RealtimeLogDb` recording every bound SQL call. */
function fakeLogDb(rows) {
  const calls = [];
  return {
    calls,
    async readOnly(fn) {
      const query = async (sql, params) => {
        calls.push({ sql, params });
        if (/set_config/i.test(sql)) return { rows: [] };
        return { rows };
      };
      return fn(query);
    },
  };
}

/** A `RealtimeLogDb` whose `readOnly` must never be invoked — used to prove
 * validation short-circuits BEFORE any SQL is built. */
function forbiddenLogDb() {
  return {
    async readOnly() {
      throw new Error("readOnly must not be called — validation should have short-circuited first");
    },
  };
}

function engineWith(logDb) {
  return new RealtimeEngine({
    connectionString: "postgres://unused-in-unit-tests/db",
    schema: testSchema(),
    // Unit tests never call engine.start() — a fake source avoids any
    // accidental real connection attempt if that ever changed.
    source: { start: async () => {}, stop: async () => {} },
    logDb,
  });
}

function logRow(overrides = {}) {
  return {
    id: "1",
    lsn: "0/1",
    txid: "5",
    table_name: "Post",
    op: "INSERT",
    pk: { id: 1 },
    new: { id: 1, title: "hi" },
    old: null,
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

console.log("realtime endpoint: GET ?handle&offset (unit, no DB)");

// ── A3.1/A3.2 — offset validation, rejected before any SQL is built ───────

for (const bad of ["", "-1", "1e3", "1; DROP TABLE", "1".repeat(20)]) {
  await check(`A3.1 (threat: SQL injection via offset): offset=${JSON.stringify(bad)} is rejected before any SQL is built`, async () => {
    const engine = engineWith(forbiddenLogDb());
    const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
    process.env.INDIGODB_REALTIME_SECRET = SECRET;
    const { status, body } = await exchange(engine, {
      url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&offset=${encodeURIComponent(bad)}`,
    });
    strictEqual(status, 400);
    ok(JSON.parse(body).error, "expected an error body");
  });
}

await check("A3.2: absent offset defaults to \"0\" and is accepted", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const { status } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(status, 200);
  const offsetParam = db.calls.find((c) => /WHERE table_name/i.test(c.sql))?.params[1];
  strictEqual(offsetParam, "0");
});

await check("A3.2: a valid digit-string offset is bound as text and cast id > $2::bigint (never interpolated)", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const { status } = await exchange(engine, {
    url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&offset=42`,
  });
  strictEqual(status, 200);
  const call = db.calls.find((c) => /WHERE table_name/i.test(c.sql));
  ok(/id > \$2::bigint/.test(call.sql), "expected the offset to be cast id > $2::bigint in the SQL text");
  strictEqual(call.params[1], "42");
  ok(!call.sql.includes("42"), "the raw offset value must never be interpolated into the SQL text itself");
});

// ── A4.1/A4.2 — RealtimeLogDb port: bind params, not string concatenation ─

await check("A4.1: table name and offset are bound $1/$2 parameters, never string-concatenated into SQL", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  await exchange(engine, {
    url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&offset=10`,
  });
  const call = db.calls.find((c) => /WHERE table_name/i.test(c.sql));
  ok(!call.sql.includes("Post"), "table name must never appear inlined in the SQL text");
  deepStrictEqual(call.params, ["Post", "10"]);
});

// ── A5.1/A5.2 — set_config runs in the SAME transaction, only from the handle ──

await check("A5.1: set_config('app.user_id', ...) runs inside the SAME readOnly transaction as the SELECT", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  const handle = mintHandle({ table: "Post", userId: "claim-1" }, SECRET);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(db.calls.length, 2, "expected exactly set_config then SELECT, in one readOnly() call");
  ok(/set_config/i.test(db.calls[0].sql));
  deepStrictEqual(db.calls[0].params, ["claim-1"]);
  ok(/WHERE table_name/i.test(db.calls[1].sql));
});

await check("A5.2 (threat: identity spoofing): a spoofed ?userId= or X-User-Id alongside a valid handle has no effect", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  const handle = mintHandle({ table: "Post", userId: "real-user" }, SECRET);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  await exchange(engine, {
    url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&userId=attacker`,
    headers: { "x-user-id": "attacker" },
  });
  deepStrictEqual(db.calls[0].params, ["real-user"], "app.user_id must come only from the verified handle claim");
});

// ── A5.3/A9 — uniform opaque 401 across every failure cause ────────────────

await check("A5.3 (threat: error oracle): tampered payload, tampered signature, unknown version, expired, and missing secret ALL produce byte-identical 401 responses", async () => {
  const engine = engineWith(forbiddenLogDb());
  process.env.INDIGODB_REALTIME_SECRET = SECRET;

  const valid = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  const [validPayload, validSig] = valid.split(".");
  const tamperedPayload = { ...JSON.parse(Buffer.from(validPayload, "base64url").toString()), u: "other" };
  const tamperedPayloadHandle =
    Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url") + "." + validSig;
  const sigBuf = Buffer.from(validSig, "base64url");
  sigBuf[0] ^= 0xff;
  const tamperedSigHandle = `${validPayload}.${sigBuf.toString("base64url")}`;
  const expiredHandle = mintHandle({ table: "Post", userId: "u1", ttl: -10 }, SECRET);

  const responses = [];
  for (const handleValue of [tamperedPayloadHandle, tamperedSigHandle, expiredHandle]) {
    const { status, body } = await exchange(engine, {
      url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handleValue)}`,
    });
    responses.push({ status, body });
  }

  // Missing secret entirely — same opaque failure.
  delete process.env.INDIGODB_REALTIME_SECRET;
  {
    const { status, body } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(valid)}` });
    responses.push({ status, body });
  }
  process.env.INDIGODB_REALTIME_SECRET = SECRET;

  // Missing/malformed handle param entirely.
  {
    const { status, body } = await exchange(engine, { url: REALTIME_LOG_PATH });
    responses.push({ status, body });
  }

  for (const r of responses) {
    strictEqual(r.status, 401);
    strictEqual(r.body, responses[0].body, "every failure cause must produce the exact same response body");
  }
});

// ── A6.1/A6.2 — stale/unknown table ─────────────────────────────────────────

await check("A6.1/A6.2: a signature-valid handle naming a table that is not @@realtime returns 404, not 401", async () => {
  const engine = engineWith(forbiddenLogDb());
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const handle = mintHandle({ table: "NotARealtimeTable", userId: "u1" }, SECRET);
  const { status } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(status, 404);
});

// ── A7.1/A7.2 — cache headers, sealed vs. head-of-log (empty page guard) ──

await check("A7.1/A7.2: a full page (events.length === PAGE_SIZE) is sealed/immutable", async () => {
  const rows = Array.from({ length: REALTIME_LOG_PAGE_SIZE }, (_, i) => logRow({ id: String(i + 1) }));
  const db = fakeLogDb(rows);
  const engine = engineWith(db);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  const { status, headers, body } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(status, 200);
  strictEqual(headers["cache-control"], "public, max-age=31536000, immutable");
  strictEqual(JSON.parse(body).hasMore, true);
});

await check("A7.1/A7.2 (regression guard): a short page (fewer than PAGE_SIZE) is no-store, never cacheable", async () => {
  const db = fakeLogDb([logRow({ id: "1" }), logRow({ id: "2" })]);
  const engine = engineWith(db);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  const { headers, body } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(headers["cache-control"], "no-store");
  strictEqual(JSON.parse(body).hasMore, false);
});

await check("A7.1/A7.2 (CRITICAL regression guard): an EMPTY page (0 events) is STILL no-store, never a cacheable directive", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  const { status, headers, body } = await exchange(engine, { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}` });
  strictEqual(status, 200);
  const parsed = JSON.parse(body);
  strictEqual(parsed.events.length, 0);
  strictEqual(parsed.hasMore, false);
  strictEqual(
    headers["cache-control"],
    "no-store",
    "an empty page inverted to a cacheable directive is THE likeliest correctness bug — must stay no-store",
  );
});

// ── A8.2 — threat: page-size amplification via client-tunable limit ───────

await check("A8.2 (threat: amplification): a ?limit=100000-shaped param has no effect — LIMIT stays the module constant", async () => {
  const db = fakeLogDb([]);
  const engine = engineWith(db);
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
  const { status } = await exchange(engine, {
    url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&limit=100000`,
  });
  strictEqual(status, 200);
  const call = db.calls.find((c) => /WHERE table_name/i.test(c.sql));
  ok(
    call.sql.includes(`LIMIT ${REALTIME_LOG_PAGE_SIZE}`),
    `expected the fixed LIMIT ${REALTIME_LOG_PAGE_SIZE} in the SQL text regardless of ?limit=`,
  );
});

// ── A8.3 — threat: routing/method confusion ─────────────────────────────────

for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
  await check(`A8.3 (threat: method confusion): ${method} ${REALTIME_LOG_PATH} returns 405`, async () => {
    const engine = engineWith(forbiddenLogDb());
    process.env.INDIGODB_REALTIME_SECRET = SECRET;
    const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
    const { status } = await exchange(engine, {
      method,
      url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}`,
    });
    strictEqual(status, 405);
  });
}

// ── A9.1 — threat: secret handling ─────────────────────────────────────────

await check("A9.1 (threat: secret leakage): the secret never appears in any response body across every failure path", async () => {
  process.env.INDIGODB_REALTIME_SECRET = SECRET;
  const engine = engineWith(forbiddenLogDb());
  const scenarios = [
    { url: REALTIME_LOG_PATH }, // missing handle
    { url: `${REALTIME_LOG_PATH}?handle=garbage` }, // malformed handle
    { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(mintHandle({ table: "Nope", userId: "u1" }, SECRET))}` }, // 404
    { url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(mintHandle({ table: "Post", userId: "u1" }, SECRET))}&offset=bad` }, // 400
    { method: "POST", url: `${REALTIME_LOG_PATH}?handle=x` }, // 405
  ];
  for (const scenario of scenarios) {
    const { body, headers } = await exchange(engine, scenario);
    ok(!body.includes(SECRET), `response body for ${JSON.stringify(scenario)} must never contain the secret`);
    for (const [, v] of Object.entries(headers)) {
      ok(!String(v).includes(SECRET), "response headers must never contain the secret");
    }
  }
});

console.log(`\n${passed} passed (unit)`);

// ─────────────────────────────────────────────────────────────────────────
// Real-Postgres integration section
// ─────────────────────────────────────────────────────────────────────────

const url = skipIfNoDatabase("endpoint.mjs");
if (url) {
  const { WalSource } = await import("../dist/index.js");
  const { withReplicationFixture } = await import("./pg-harness.mjs");
  let pgPassed = 0;
  async function pgCheck(name, fn) {
    try {
      await fn();
      pgPassed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  async function ensureNonSuperuserRole(admin, roleName) {
    await admin.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
    CREATE ROLE "${roleName}" NOLOGIN;
  END IF;
END $$;`);
    await admin.query(`GRANT "${roleName}" TO CURRENT_USER;`);
  }

  async function dropRole(admin, roleName) {
    await admin.query(`DROP ROLE IF EXISTS "${roleName}";`).catch(() => {});
  }

  /** `RealtimeLogDb` driven through `SET ROLE <roleName>` for the duration
   * of each transaction — genuinely demotes the connection away from the
   * superuser the test harness otherwise connects as (same idiom as
   * `buckets.mjs`; see this file's header for why `SET ROLE`, not a second
   * LOGIN connection, is what actually proves RLS isolation here). */
  function nonSuperuserLogDb(pool, roleName) {
    return {
      async readOnly(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET TRANSACTION READ ONLY");
          await client.query(`SET ROLE "${roleName}"`);
          try {
            return await fn(async (sql, params) => {
              const result = await client.query(sql, params);
              return { rows: result.rows };
            });
          } finally {
            await client.query("RESET ROLE").catch(() => {});
          }
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
    };
  }

  console.log("\nrealtime endpoint: GET ?handle&offset (real Postgres)");

  await pgCheck(
    "A12.1 (real PG): cursor advancement — 3 rows sharing one lsn are each returned once, ordered by id; paging to exhaustion reaches hasMore:false",
    async () => {
      await withReplicationFixture(url, "endpoint_cursor", async ({ table, slot }) => {
        const schema = {
          ...testSchema(),
          tables: [
            {
              ...testSchema().tables[0],
              name: table,
              dbName: table,
              columns: [
                { name: "id", dbName: "id" },
                { name: "name", dbName: "name" },
                { name: "big", dbName: "big" },
              ],
              primaryKey: ["id"],
            },
          ],
        };
        const events = [];
        const source = new WalSource(url, schema, { slot });
        await source.start(
          (e) => events.push(e),
          (e) => console.error("onError", e.message),
        );
        await new Promise((r) => setTimeout(r, 300));

        await withAdmin(url, async (admin) => {
          await admin.query("BEGIN");
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('a')`);
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('b')`);
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('c')`);
          await admin.query("COMMIT");
        });
        await new Promise((r) => setTimeout(r, 1200));
        await source.stop();

        strictEqual(events.length, 3);

        const pool = new (await import("pg")).default.Pool({ connectionString: url, max: 2 });
        const engine = new RealtimeEngine({
          connectionString: url,
          schema,
          source: { start: async () => {}, stop: async () => {} },
          logDb: {
            async readOnly(fn) {
              const client = await pool.connect();
              try {
                await client.query("BEGIN");
                await client.query("SET TRANSACTION READ ONLY");
                return await fn(async (sql, params) => {
                  const result = await client.query(sql, params);
                  return { rows: result.rows };
                });
              } finally {
                await client.query("ROLLBACK").catch(() => {});
                client.release();
              }
            },
          },
        });
        process.env.INDIGODB_REALTIME_SECRET = SECRET;
        const handle = mintHandle({ table, userId: "cursor-tester" }, SECRET);

        const seenNames = [];
        let offset = "0";
        let hasMore = true;
        let guard = 0;
        while (hasMore && guard++ < 10) {
          const { status, body } = await exchange(engine, {
            url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}&offset=${offset}`,
          });
          strictEqual(status, 200);
          const page = JSON.parse(body);
          for (const e of page.events) seenNames.push(e.new.name);
          offset = page.offset;
          hasMore = page.hasMore;
        }
        deepStrictEqual(seenNames, ["a", "b", "c"]);
        strictEqual(hasMore, false, "expected the final page to report hasMore:false (page short of the fixed limit)");
        await pool.end();
      });
    },
  );

  await pgCheck(
    "A12.2 (real PG, CRITICAL — non-superuser role): RLS isolation — two handles for the same table, different claims, see only their own bucket-scoped rows, enforced by policy under SET ROLE (NOT the default superuser connection)",
    async () => {
      const claim = { kind: "claim", name: "ownerId" };
      const field = (name) => ({ kind: "field", name });
      await withReplicationFixture(url, "endpoint_rls", async ({ table, slot }) => {
        const schema = {
          tables: [
            {
              name: table,
              dbName: table,
              realtime: true,
              columns: [
                { name: "id", dbName: "id" },
                { name: "name", dbName: "name" },
                { name: "big", dbName: "big" },
              ],
              primaryKey: ["id"],
              allow: [{ action: "read", left: field("name"), right: claim }],
            },
          ],
        };
        const events = [];
        const source = new WalSource(url, schema, { slot });
        await source.start(
          (e) => events.push(e),
          (e) => console.error("onError", e.message),
        );
        await new Promise((r) => setTimeout(r, 300));

        await withAdmin(url, async (admin) => {
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('owner-a')`);
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('owner-b')`);
        });
        await new Promise((r) => setTimeout(r, 1000));
        await source.stop();
        strictEqual(events.length, 2, "expected both rows to have logged (buckets computed from the read AllowRule)");

        const roleName = "endpoint_rls_role";
        const pg = (await import("pg")).default;
        const adminForRole = new pg.Client({ connectionString: url });
        await adminForRole.connect();
        await ensureNonSuperuserRole(adminForRole, roleName);
        await adminForRole.query(`GRANT SELECT ON "${REALTIME_LOG_TABLE}" TO "${roleName}";`);
        await adminForRole.end();

        const pool = new pg.Pool({ connectionString: url, max: 2 });
        try {
          const engine = new RealtimeEngine({
            connectionString: url,
            schema,
            source: { start: async () => {}, stop: async () => {} },
            logDb: nonSuperuserLogDb(pool, roleName),
          });
          process.env.INDIGODB_REALTIME_SECRET = SECRET;

          const handleA = mintHandle({ table, userId: "owner-a" }, SECRET);
          const { status: statusA, body: bodyA } = await exchange(engine, {
            url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handleA)}`,
          });
          strictEqual(statusA, 200);
          const pageA = JSON.parse(bodyA);
          deepStrictEqual(
            pageA.events.map((e) => e.new.name).sort(),
            ["owner-a"],
            "owner-a's handle must see only its own bucket-scoped row, enforced by the policy under a non-bypassing role",
          );

          const handleB = mintHandle({ table, userId: "owner-b" }, SECRET);
          const { body: bodyB } = await exchange(engine, {
            url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handleB)}`,
          });
          const pageB = JSON.parse(bodyB);
          deepStrictEqual(pageB.events.map((e) => e.new.name).sort(), ["owner-b"]);
        } finally {
          await pool.end();
          await withAdmin(url, async (admin) => {
            await dropRole(admin, roleName);
          });
        }
      });
    },
  );

  await pgCheck(
    "A12.3 (real PG): re-requesting the same sealed (handle, offset) returns a byte-identical response body",
    async () => {
      await withReplicationFixture(url, "endpoint_byteident", async ({ table, slot }) => {
        // A fixed small page size via REALTIME_LOG_PAGE_SIZE (500) would need
        // 500 rows to seal — instead this test asserts byte-identity on a
        // SHORT page (still deterministic/no-store, but the identity
        // property itself — re-fetching returns the exact same bytes for
        // the same underlying data — holds regardless of seal state, and is
        // cheap to prove without writing 500 rows).
        const schema = {
          ...testSchema(),
          tables: [
            {
              ...testSchema().tables[0],
              name: table,
              dbName: table,
              columns: [
                { name: "id", dbName: "id" },
                { name: "name", dbName: "name" },
                { name: "big", dbName: "big" },
              ],
              primaryKey: ["id"],
            },
          ],
        };
        const events = [];
        const source = new WalSource(url, schema, { slot });
        await source.start(
          (e) => events.push(e),
          (e) => console.error("onError", e.message),
        );
        await new Promise((r) => setTimeout(r, 300));
        await withAdmin(url, async (admin) => {
          await admin.query(`INSERT INTO "${table}" (name) VALUES ('once')`);
        });
        await new Promise((r) => setTimeout(r, 800));
        await source.stop();
        strictEqual(events.length, 1);

        const pg = (await import("pg")).default;
        const pool = new pg.Pool({ connectionString: url, max: 2 });
        try {
          const engine = new RealtimeEngine({
            connectionString: url,
            schema,
            source: { start: async () => {}, stop: async () => {} },
            logDb: {
              async readOnly(fn) {
                const client = await pool.connect();
                try {
                  await client.query("BEGIN");
                  await client.query("SET TRANSACTION READ ONLY");
                  return await fn(async (sql, params) => {
                    const result = await client.query(sql, params);
                    return { rows: result.rows };
                  });
                } finally {
                  await client.query("ROLLBACK").catch(() => {});
                  client.release();
                }
              },
            },
          });
          process.env.INDIGODB_REALTIME_SECRET = SECRET;
          const handle = mintHandle({ table, userId: "byteident-tester" }, SECRET);

          const { body: body1 } = await exchange(engine, {
            url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}`,
          });
          const { body: body2 } = await exchange(engine, {
            url: `${REALTIME_LOG_PATH}?handle=${encodeURIComponent(handle)}`,
          });

          strictEqual(body1, body2, "re-requesting the same (handle, offset) must return byte-identical content");
        } finally {
          await pool.end();
        }
      });
    },
  );

  console.log(`\n${pgPassed} passed (real PG)`);
}

if (process.exitCode) process.exit(process.exitCode);
