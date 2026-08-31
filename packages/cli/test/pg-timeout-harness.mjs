/**
 * Real-Postgres lifecycle helper for `studio-query-timeout-pg.mjs`.
 *
 * PGlite (used by `studio-harness.mjs` for every other Studio suite) accepts
 * `SET LOCAL statement_timeout` without error but never actually aborts a
 * long-running statement once it elapses (empirically confirmed during the
 * `studio-query-guardrails` change). That means no PGlite-backed suite can
 * prove the guardrail's actual job: making Postgres itself cancel a slow
 * query. This module owns ONLY the mechanics of gating on a real server for
 * that proof, mirroring `packages/realtime/test/pg-harness.mjs`'s contract
 * exactly (same env var, same skip shape, same exit-0-on-skip behavior) so
 * `pnpm test` stays Postgres-free by default.
 *
 * Local setup used to develop/verify this suite:
 *   docker run -d --name indigo-studio-timeout-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=indigo_test -p 55433:5432 postgres:17
 *   export INDIGODB_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/indigo_test
 */

export function testDatabaseUrl() {
  return process.env.INDIGODB_TEST_DATABASE_URL ?? null;
}

/** Skips the calling suite (exit 0, printed notice) when no real Postgres is configured. */
export function skipIfNoDatabase(suiteName) {
  const url = testDatabaseUrl();
  if (url) return url;
  console.log(
    `SKIP - ${suiteName}: INDIGODB_TEST_DATABASE_URL is unset — real-Postgres suite skipped ` +
      `(PGlite never actually aborts a timed-out statement, so proving statement_timeout ` +
      `enforcement needs a real server). Set the var, or see \`packages/realtime/test/pg-harness.mjs\`'s ` +
      `header for a docker one-liner.`,
  );
  return null;
}
