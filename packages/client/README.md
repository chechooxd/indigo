# @indigodb/client

Framework-agnostic runtime for the IndigoDB ORM. The generated `indigo.ts` client extends
`IndigoClientBase` and attaches one typed `ModelDelegate` per model. Usable in NestJS, Express,
or plain Node.

The root `@indigodb/client` entry point above is **server-only, by design**: it statically
imports `pg` (`src/adapters/pg.ts`) and `node:async_hooks` (`src/client.ts`, and `src/context.ts`
via `delegate.ts` — so even constructing a `ModelDelegate` alone drags it in). Bundling it for a
browser will fail, or resolve to broken shims, and that failure is expected — see
[Browser usage](#browser-usage) below for what runs client-side instead. The generated
`indigo.ts` client is server code too: it imports this root entry, so it cannot be bundled for a
browser either.

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

## Browser usage

`@indigodb/client/realtime` is the browser entry point. Its whole import closure is
`realtime.ts` + `live.ts` + `@indigodb/realtime/protocol` — none of it imports `pg` or any
`node:` module. It only uses standard Web APIs (`fetch`, `AbortController`, `TextDecoder`, `URL`,
`ReadableStream`, `atob`), so it is safe to bundle into any frontend build:

```ts
import { createLiveSubscription, browserTransport } from "@indigodb/client/realtime";

const subscription = createLiveSubscription({
  table: "Order",
  transport: browserTransport(), // reads window.location.origin for you
  onWake: () => {
    // your own invalidation logic — see the TanStack Query recipe below
  },
});

const unsubscribe = subscription.subscribe(() => {
  console.log(subscription.getStatus()); // "idle" | "connecting" | "live" | "error" | "closed"
});
```

### The SSE stream is wake-only — it carries no row data

The realtime channel is a notification, not a data feed: every table, `@@allow` or not, only
ever tells a browser subscriber *"table `Order` changed"* — never the row itself. `onWake` is
called with no arguments and `createLiveSubscription`'s return shape has no `rows`/data field to
read. Row data reaches a remote consumer only through the handle-authenticated replay route,
which this primitive does not call.

### So the app fetches its own data

`@indigodb/client` does not provide a browser-side query API. The SDK notifies; your backend
serves: on `onWake`, call your own authenticated API route (or, as below, invalidate a cache that
already knows how to refetch it) — never query IndigoDB directly from browser code.

### TanStack Query recipe: `onWake` as a cache invalidation signal

`createLiveSubscription` composes with an existing data-fetching library instead of competing
with it — wire its `onWake` to `queryClient.invalidateQueries()` and let TanStack Query own the
actual refetch:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createLiveSubscription, browserTransport } from "@indigodb/client/realtime";

function useOrderInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const subscription = createLiveSubscription({
      table: "Order",
      transport: browserTransport(),
      onWake: () => {
        queryClient.invalidateQueries({ queryKey: ["orders"] });
      },
    });
    const unsubscribe = subscription.subscribe(() => {});
    return () => {
      unsubscribe();
      subscription.close();
    };
  }, [queryClient]);
}
```

`useOrders()` (a normal `useQuery({ queryKey: ["orders"], queryFn: fetchOrders })`) keeps fetching
from your own backend exactly as it always did; this hook only tells TanStack Query when that
cache is stale.

### What this does NOT give you

- **No browser-direct database queries.** There is no `findMany`/`findUnique` you can call from
  the browser — `IndigoClientBase` and every `ModelDelegate` method are server-only, as stated
  above.
- **No end-user authentication.** The realtime channel has an origin allowlist (CORS), not a
  per-user identity check. It tells you *that* something changed, not *whether you're allowed to
  see it*.
- **No handle-minting HTTP route.** The replay/handle mechanism that gates row-level access
  (`mintHandle`/`verifyHandle` in `@indigodb/realtime`) is a server-side primitive your backend
  calls; this package does not expose an endpoint that mints one for a browser caller.

If you're arriving from Firebase or Supabase expecting browser-direct, authenticated queries,
that model is not what this package provides. IndigoDB's realtime story is deliberately
"notify the browser, let your own backend answer": build the fetch route yourself and use the
recipe above to know when to call it again.

## Testing

- `pnpm test` (from the repo root, scoped with `--filter=@indigodb/client`, or run directly here)
  runs every `test/*.mjs` suite listed in `package.json`'s `test` script.
- `test/adapters.mjs` — `createPgAdapter`/`createPGliteAdapter` unit + integration coverage.
- `test/adapters-pg.mjs` — `createPgAdapter` parity test over a real Postgres engine reachable
  over a real TCP socket (`test/pglite-socket-harness.mjs`).
- `test/readme-contract.mjs` — content-assertion suite over this README's browser-usage section
  (`client-browser-usage-docs` spec): keeps the browser entry point name, the wake-only contract,
  the query non-goal, and the TanStack recipe from silently drifting out of sync with the code.
