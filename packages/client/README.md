# @indigodb/client

Framework-agnostic runtime for the IndigoDB ORM. The generated `indigo.ts` client extends
`IndigoClientBase` and attaches one typed `ModelDelegate` per model. Usable in NestJS, Express,
or plain Node.

## Default usage (built-in `pg.Pool`)

```ts
import { PrismaLikeClient } from "./generated/indigo.js"; // your generated client

const db = new PrismaLikeClient({ connectionString: process.env.DATABASE_URL });
```

Under the hood this constructs and owns a `pg.Pool` via `createPgAdapter` — see
`client-driver-adapters` design.md — so the default path and the "bring your own driver" path
below are, byte for byte, the same code.

## Bring your own driver

`IndigoClientOptions.db` accepts any `DriverAdapter`:

```ts
export interface DriverAdapter {
  exec: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  close?: () => Promise<void>;
  transaction?: <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;
}
```

`@indigodb/client` ships two named factories that produce one:

### `createPgAdapter` — reuse an existing `pg.Pool`

```ts
import { createPgAdapter } from "@indigodb/client";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaLikeClient({ db: createPgAdapter({ pool }) });
```

Passing `{ pool }` (an existing `pg.Pool` instance) means the adapter never calls `pool.end()`
on `$disconnect()` — you constructed it, you own its lifecycle. Passing a plain `PoolConfig`
(or nothing) instead makes the adapter construct and own its own pool, exactly like the default
`connectionString` path.

### `createPGliteAdapter` — embed over PGlite

```ts
import { createPGliteAdapter } from "@indigodb/client";
import { PGlite } from "@electric-sql/pglite";

const pglite = new PGlite();
const db = new PrismaLikeClient({ db: createPGliteAdapter(pglite) });
```

Useful for tests and embedded/edge deployments. `transaction()` delegates to PGlite's own
`transaction(tx => …)` API — never a raw `BEGIN`/`COMMIT` — because PGlite is single-connection
and that's its supported concurrency-safe transaction mechanism. `close()` is a no-op by default
(same ownership rule as `createPgAdapter`); pass `{ close: true }` to opt in.

### Neon (HTTP driver) — documentation only, no `createNeonAdapter` export

Neon's `@neondatabase/serverless` HTTP driver (`neon(...)` tagged-template client) executes each
query as its own independent HTTP request — there is no persistent session, so it cannot honor
`DriverAdapter.transaction`. `@indigodb/client` deliberately does NOT ship a `createNeonAdapter`:
shipping one would either silently drop transactional guarantees or throw at runtime on the very
call apps expect to work. Wire it up yourself as a plain `Executor`, and simply omit `transaction`:

```ts
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const db = new PrismaLikeClient({
  db: {
    exec: async (query, params) => sql(query, params),
    // No `transaction` — `$transaction`/`$withSession` will reject with an
    // explicit error instead of silently running un-transacted statements.
  },
});
```

If your workload needs real multi-statement transactions against Neon, use Neon's pooled
Postgres connection string with `createPgAdapter` (or the default `connectionString` path)
instead of the HTTP driver.

## Testing

- `pnpm test` (from the repo root, scoped with `--filter=@indigodb/client`, or run directly here)
  runs every `test/*.mjs` suite listed in `package.json`'s `test` script.
- `test/adapters.mjs` — `createPgAdapter`/`createPGliteAdapter` unit + integration coverage.
- `test/adapters-pg.mjs` — `createPgAdapter` parity test over a real Postgres engine reachable
  over a real TCP socket (`test/pglite-socket-harness.mjs`).
