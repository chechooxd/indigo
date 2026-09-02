/**
 * @indigodb/cli — Studio degraded-realtime suite (EPT-1, EPT-2, EPT-3).
 *
 * `indigodb studio` must NOT refuse to boot when the realtime engine fails to
 * start: its schema, table and query routes need no replication stream, so
 * failing hard would trade a defect for a regression. But the failure must be
 * *visible*, because `RealtimeEngine.handleRequest` answers 200 with an
 * `event: ready` frame without ever consulting whether the source started —
 * and the browser's SSE transport treats any 200 as an open stream, so the
 * Studio's live badge would read `live` over a stream that can never deliver
 * an event.
 *
 * Drives a REAL `startStudio` server over real `fetch()`, per
 * `studio-harness.mjs`. The degraded fixture overrides `connectionString` to
 * `postgres://127.0.0.1:1/db` — an unroutable PORT, deliberately not a
 * hostname that relies on DNS failure, which is resolver-dependent and slow.
 * Only `RealtimeEngine` ever dials it; the Studio's own queries go through
 * the injected PGlite `StudioDb`.
 */

import { parse, resolve } from "@indigodb/core";
import { withDatabase, withStudio } from "./studio-harness.mjs";

let failures = 0;
let ran = 0;

async function check(name, fn) {
  ran++;
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

// `@@realtime` — this Studio builds an engine, whose start() rejects against
// the unroutable connection string, so it boots degraded.
const REALTIME_SCHEMA = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table Post {
  id    Int    @id @default(autoincrement())
  title String

  @@realtime
}
`;

// No `@@realtime` — no engine is constructed at all, so this Studio is the
// healthy control. EPT-3 compares the two: a bare "expect 200" on the
// degraded side would pass vacuously in exactly the world where a blunt
// implementation degraded the ordinary routes along with the realtime ones.
const PLAIN_SCHEMA = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table Post {
  id    Int    @id @default(autoincrement())
  title String
}
`;

const UNROUTABLE = "postgres://127.0.0.1:1/db";

function resolvedFrom(source) {
  return { resolved: resolve(parse(source)), source };
}

async function seed(db) {
  await db.exec(`
    CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT);
    INSERT INTO "Post" (title) VALUES ('first'), ('second');
  `);
}

console.log("cli studio: degraded realtime (EPT-1/2/3)");

await withDatabase(async (db) => {
  await seed(db);

  const realtime = resolvedFrom(REALTIME_SCHEMA);
  const plain = resolvedFrom(PLAIN_SCHEMA);

  await withStudio(
    db,
    realtime,
    async ({ baseUrl }) => {
      await check("EPT-1: the SSE route answers 503 and writes no `ready` frame", async () => {
        const res = await fetch(`${baseUrl}/api/realtime?tables=Post`);
        assert(res.status === 503, `expected 503, got ${res.status}`);
        const body = await res.text();
        // Status alone is not enough: a 503 that still emitted a ready frame
        // would satisfy a status-only assertion while leaving the client's
        // `onOpen` reachable, which is the exact failure this gate prevents.
        assert(!body.includes("event: ready"), `expected no ready frame, got body: ${body}`);
        assert(!body.includes("data:"), `expected no SSE data frame, got body: ${body}`);
      });

      await check("EPT-2: the replay-log route answers 503", async () => {
        const res = await fetch(`${baseUrl}/api/realtime/log?handle=x&offset=0`);
        assert(res.status === 503, `expected 503, got ${res.status}`);
      });

      await check("EPT-3: ordinary routes answer identically to a healthy Studio", async () => {
        // Collect the degraded Studio's answers first...
        const degraded = {};
        for (const path of ["/api/schema", "/api/tables/Post"]) {
          const res = await fetch(`${baseUrl}${path}`);
          // RSC-13 standalone: assert 200 outright, not only that it equals
          // the control. An equality-only check would still pass if BOTH
          // Studios broke the same way, so the absolute assertion is what
          // actually proves the degraded Studio still serves these routes.
          assert(res.status === 200, `degraded Studio should serve ${path}, got ${res.status}`);
          degraded[path] = { status: res.status, keys: Object.keys(await res.json()).sort() };
        }
        const dq = await fetch(`${baseUrl}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: 'SELECT id FROM "Post" ORDER BY id' }),
        });
        degraded["/api/query"] = { status: dq.status, keys: Object.keys(await dq.json()).sort() };

        // ...then the same block against a Studio that never built an engine.
        await withStudio(db, plain, async ({ baseUrl: healthyUrl }) => {
          for (const path of ["/api/schema", "/api/tables/Post"]) {
            const res = await fetch(`${healthyUrl}${path}`);
            const healthy = { status: res.status, keys: Object.keys(await res.json()).sort() };
            assert(
              healthy.status === degraded[path].status,
              `${path}: healthy ${healthy.status} vs degraded ${degraded[path].status}`,
            );
            assert(
              JSON.stringify(healthy.keys) === JSON.stringify(degraded[path].keys),
              `${path}: body shape differs — healthy ${healthy.keys} vs degraded ${degraded[path].keys}`,
            );
          }
          const hq = await fetch(`${healthyUrl}/api/query`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sql: 'SELECT id FROM "Post" ORDER BY id' }),
          });
          const healthyQuery = { status: hq.status, keys: Object.keys(await hq.json()).sort() };
          assert(
            healthyQuery.status === degraded["/api/query"].status,
            `/api/query: healthy ${healthyQuery.status} vs degraded ${degraded["/api/query"].status}`,
          );
          assert(
            JSON.stringify(healthyQuery.keys) === JSON.stringify(degraded["/api/query"].keys),
            `/api/query: body shape differs`,
          );
          // The comparison is only meaningful if both sides actually worked.
          assert(healthyQuery.status === 200, `control Studio should serve /api/query, got ${healthyQuery.status}`);
        });
      });
    },
    { connectionString: UNROUTABLE },
  );
});

// An omitted or silently skipped case shrinks `ran` rather than failing, so
// pin the count: the suite must not be able to under-report its own size.
if (ran !== 3) {
  console.error(`\nexpected 3 checks to run, ran ${ran}`);
  process.exit(1);
}
if (failures > 0) {
  console.error(`\ncli studio degraded realtime: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncli studio degraded realtime: all green");
