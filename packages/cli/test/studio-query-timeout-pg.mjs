/**
 * @indigodb/cli — Studio statement-timeout, real-Postgres integration suite.
 *
 * `studio-query-guardrails.mjs` proves the *shape* of the 57014 → 4xx
 * mapping using a deterministic injected `StudioDb` double that throws
 * `{ code: "57014" }` — it never asks a real Postgres to actually abort a
 * slow statement. This suite closes that gap: it starts `startStudio`
 * WITHOUT a `db` override, so it drives the production `createPgDb` path
 * (a real `pg.Pool`, the real `readOnlyPreamble`, a real
 * `SET LOCAL statement_timeout`) against a real Postgres server, and proves
 * two things the spec requires and that a double cannot:
 *
 *   1. Postgres genuinely cancels a query once `queryTimeoutMs` elapses,
 *      and the route maps that abort to a 4xx naming the configured
 *      timeout (not just a canned message from a mock).
 *   2. The pooled connection that absorbed the abort is NOT left open or
 *      wedged: a subsequent request over the same server/pool still
 *      succeeds. This is the part most likely to be broken and least
 *      likely to be noticed — `readOnly()`'s `finally` block always issues
 *      `ROLLBACK` + `client.release()`, but nothing except a real timeout
 *      actually exercises that path under a genuine abort.
 *
 * Gated on `INDIGODB_TEST_DATABASE_URL` exactly like
 * `packages/realtime/test/pg-harness.mjs` — see `pg-timeout-harness.mjs`'s
 * header for the docker one-liner. Unset → SKIP, exit 0, `pnpm test` stays
 * Postgres-free.
 */

import pg from "pg";
import { parse, resolve } from "@indigodb/core";
import { skipIfNoDatabase } from "./pg-timeout-harness.mjs";

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
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

function loadFixture() {
  const ast = parse(SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: SCHEMA_SOURCE };
}

async function runQuery(baseUrl, sql) {
  return fetch(`${baseUrl}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
}

/**
 * Creates the "User" table `/api/tables/User` reads, so the follow-up
 * request proving the pool is not wedged exercises a real table rather than
 * failing for the unrelated reason of a missing relation. Torn down after
 * the run, even on failure.
 */
async function withUserTable(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS "User"`);
    await client.query(
      `CREATE TABLE "User" (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL)`,
    );
    await client.query(`INSERT INTO "User" (email) VALUES ('a@example.com')`);
    return await fn();
  } finally {
    await client.query(`DROP TABLE IF EXISTS "User"`).catch(() => {});
    await client.end();
  }
}

const url = skipIfNoDatabase("studio-query-timeout-pg.mjs");

if (url) {
  const QUERY_TIMEOUT_MS = 100;

  await withUserTable(url, async () => {

  await check(
    "real Postgres genuinely aborts a slow query at the configured statement_timeout -> 4xx naming it",
    async () => {
      const fixture = loadFixture();
      const { startStudio } = await import("../dist/studio-server.js");
      // No `db` override: this exercises the real `createPgDb` path (real
      // pg.Pool, real readOnlyPreamble, real SET LOCAL statement_timeout).
      const server = await startStudio({
        resolved: fixture.resolved,
        source: fixture.source,
        connectionString: url,
        port: 0,
        open: false,
        queryTimeoutMs: QUERY_TIMEOUT_MS,
      });
      try {
        const baseUrl = `http://${server.host}:${server.port}`;

        const started = Date.now();
        const res = await runQuery(baseUrl, "SELECT pg_sleep(2)");
        const elapsedMs = Date.now() - started;

        assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
        const body = await res.json();
        assert(
          typeof body.error === "string" && body.error.includes(`${QUERY_TIMEOUT_MS}ms statement timeout`),
          `expected the error to name the configured ${QUERY_TIMEOUT_MS}ms timeout, got ${JSON.stringify(body.error)}`,
        );
        assert(
          elapsedMs < 2000,
          `expected Postgres to abort well before the full 2000ms pg_sleep, but the request took ${elapsedMs}ms`,
        );

        // The connection that absorbed the abort must not be left open or
        // wedged: the pool must still serve subsequent requests cleanly.
        // Run more than one to make sure a single abort doesn't poison the
        // whole `readOnlyPool` (max: 4) rather than just the one connection.
        for (let i = 0; i < 3; i++) {
          const followUp = await runQuery(baseUrl, "SELECT 1 AS one");
          assert(followUp.status === 200, `expected follow-up query #${i} to succeed with 200, got ${followUp.status}`);
          const followUpBody = await followUp.json();
          assert(
            followUpBody.rows.length === 1 && followUpBody.rows[0].one === 1,
            `expected follow-up query #${i} to return the real row, got ${JSON.stringify(followUpBody)}`,
          );
        }

        // Same proof again via /api/tables/:name, the other route the
        // guardrail is applied to.
        const tableAfterTimeout = await fetch(`${baseUrl}/api/tables/User`);
        assert(
          tableAfterTimeout.status === 200,
          `expected /api/tables/User to still succeed after the earlier abort, got ${tableAfterTimeout.status}`,
        );
      } finally {
        await server.close();
      }
    },
  );

  await check("queryTimeoutMs: 0 against a real Postgres does not abort a query the small timeout would have", async () => {
    const fixture = loadFixture();
    const { startStudio } = await import("../dist/studio-server.js");
    const server = await startStudio({
      resolved: fixture.resolved,
      source: fixture.source,
      connectionString: url,
      port: 0,
      open: false,
      queryTimeoutMs: 0,
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const res = await runQuery(baseUrl, "SELECT pg_sleep(0.3)");
      assert(res.status === 200, `expected the query to complete uninterrupted with queryTimeoutMs:0, got ${res.status}`);
    } finally {
      await server.close();
    }
  });
  });

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  } else {
    console.log("\nAll studio-query-timeout-pg checks passed.");
  }
}
