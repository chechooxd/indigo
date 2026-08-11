/**
 * Real-Postgres-over-TCP lifecycle helper for `@indigodb/client`'s
 * `transactions-pg.mjs` suite.
 *
 * The rest of this repo's "real PostgreSQL" test precedent (see
 * `packages/migrator/test/pg-harness.mjs`, `packages/client/test/pglite-harness.mjs`)
 * is PGlite (`@electric-sql/pglite`) — a real Postgres engine running
 * in-process over WASM — driven directly through its JS `exec`/`query` API,
 * never over the wire protocol.
 *
 * That direct-API precedent cannot exercise `IndigoClientBase`'s default
 * `pg.Pool` code path (`client.ts`'s `$withSession`): that path is only
 * reachable when a real `pg` module `Pool`/`PoolClient` actually speaks the
 * PostgreSQL wire protocol to something. This harness closes that gap with
 * `@electric-sql/pglite-socket` (pinned to the exact PGlite peer version
 * this repo already uses), which fronts a PGlite instance with a real
 * `net.Server` speaking that wire protocol — so `pg.Pool` genuinely
 * connects, `BEGIN`/`COMMIT`/`ROLLBACK` genuinely round-trip, and
 * `client.release()` genuinely returns a connection to `pg`'s own pool.
 * It is still PGlite underneath (a real embedded Postgres engine, not a
 * mock), matching this repo's established meaning of "real Postgres" —
 * only the transport is now the real thing too.
 *
 * KNOWN LIMITATION (verified empirically, not theoretical): PGlite is a
 * single-writer engine. `pglite-socket`'s query queue only dequeues the
 * in-transaction connection's own queries while ANY session has an open
 * transaction (see its `QueryQueueManager.processQueue`) — a second
 * connection's `BEGIN` while another is mid-transaction never gets
 * serviced and hangs forever. So this harness supports proving
 * `pool.connect()` checks out and holds a dedicated connection (via
 * `pg.Pool`'s own connection accounting — e.g. a `max: 1` pool blocking a
 * concurrent outside query until the transaction releases), commit/rollback
 * durability, and release-driven pool reuse across sequential transactions.
 * It must NOT be used to run two overlapping open transactions concurrently.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * Starts a fresh PGlite instance fronted by a real TCP `pglite-socket`
 * server bound to an OS-assigned free port on loopback, runs `fn({
 * connectionString })`, then always tears both down — even on failure.
 */
export async function withRealPostgres(fn) {
  const db = new PGlite();
  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    // One connection is all `pg.Pool` needs to exercise the default path;
    // kept intentionally small given the single-writer limitation above.
    maxConnections: 4,
  });
  await server.start();
  try {
    const connectionString = `postgres://postgres@127.0.0.1:${server.port}/postgres`;
    return await fn({ connectionString, port: server.port });
  } finally {
    await server.stop();
    await db.close();
  }
}
