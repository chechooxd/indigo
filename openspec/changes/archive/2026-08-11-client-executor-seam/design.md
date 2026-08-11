# Design: Carve the Executor seam in `@indigodb/client`

## Technical Approach

Add ONE optional paired adapter option to `IndigoClientOptions`. The constructor branches once:
injected path assigns the query function and an optional `close`, leaving `pool` as `null`;
default path is today's behaviour verbatim. `this.exec` stays the single downstream contract —
a thin logging wrapper over an internal `run: Executor` resolved at construction — so `log`
behaviour, `$queryRaw`, `ModelDelegate` and the generated subclass are untouched.
`$disconnect()` tears down realtime first, then closes whichever seam exists.

## Architecture Decisions

### Decision: Paired adapter object, not two flat options

**Choice**: `db?: { exec: Executor; close?: () => Promise<void> }`.
**Alternatives considered**: flat `executor?: Executor` + `close?: () => Promise<void>`.
**Rationale**: the flat shape makes `close` without `executor` representable — meaningless on the
pool path, requiring either extra validation or a silent ignore. The paired object makes that state
unrepresentable, gives the constructor a single truthy check (`options.db`), and matches the
`StudioDb` port precedent from `harden-studio-server`. The read-only member that made `StudioDb`
heavy simply is not present here, so the pairing costs nothing.

### Decision: `pool: PgPool | null`, not a discriminated union

**Choice**: `private readonly pool: PgPool | null` plus `private readonly run: Executor` and
`private readonly closeInjected: (() => Promise<void>) | undefined`.
**Alternatives considered**: a discriminated internal state object (`{kind:'pool'|'injected'}`).
**Rationale**: only `$disconnect()` needs to distinguish the paths; `run` already erases the
difference for every query. A union would add a type-level ceremony no call site consumes.

### Decision: `run` resolved in the constructor, `exec` unchanged in shape

**Choice**: `exec` remains the one place that logs, then delegates to `this.run`.
**Alternatives considered**: branching inside `exec` on every call.
**Rationale**: the spec requires `this.exec` be identically shaped on both paths *including* `log`.
Resolving `run` once keeps the hot path branch-free and the log guarantee structural.

## Exact new logic

```ts
constructor(options: IndigoClientOptions = {}) {
  if (options.db) {
    this.pool = null;
    this.run = options.db.exec;
    this.closeInjected = options.db.close;
  } else {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString && !options.pool) {
      throw new Error(
        "IndigoClient: no connection string. Pass `connectionString` or set DATABASE_URL.",
      );
    }
    const pool = new Pool({ connectionString, ...options.pool });
    this.pool = pool;
    this.run = async (sql, params) =>
      (await pool.query(sql, params)).rows as Record<string, unknown>[];
    this.closeInjected = undefined;
  }
  this.log = options.log ?? false;
  this.realtimeUrl = options.realtime?.url ?? process.env.INDIGO_REALTIME_URL;
}

protected readonly exec: Executor = async (sql, params) => {
  if (this.log) console.log("[indigodb]", sql, params);
  return this.run(sql, params);
};

async $disconnect(): Promise<void> {
  this.realtimeManager?.close();
  this.realtimeManager = null;
  if (this.pool) await this.pool.end();
  else await this.closeInjected?.();
}
```

The guard is now reached only when `options.db` is absent — i.e. it throws exactly when there is no
injected executor AND no `connectionString`/`DATABASE_URL` AND no `options.pool`.

## Data Flow

    ModelDelegate ──→ this.exec (logs) ──→ this.run ──┬──→ pg.Pool.query  (default)
                                                      └──→ options.db.exec (injected)
    $disconnect ──→ realtime.close ──→ pool.end() | options.db.close?.()

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/client.ts` | Modify | `IndigoClientOptions.db`, fields, constructor branch, `exec`, `$disconnect` |
| `packages/client/package.json` | Modify | `"test": "node test/client.mjs"`, devDep `@electric-sql/pglite@^0.5.4` |
| `packages/client/test/pglite-harness.mjs` | Create | `withDatabase(fn)` + `createPgliteExecutor(db)` |
| `packages/client/test/client.mjs` | Create | Seam regressions + one CRUD round-trip |

`packages/client/src/index.ts` needs no change: `IndigoClientOptions` is already re-exported and
`Executor` ships via `export type * from "./types.js"`.

## PGlite adapter

```js
export function createPgliteExecutor(db) {
  return async (sql, params) => (await db.query(sql, params)).rows;
}
```

PGlite's `query(sql, params?)` is the extended protocol with `$1…$n` positional parameters and a
`{ rows, fields, affectedRows }` result — the same contract `pg` exposes. `studio-harness.mjs`
already proves the `.rows` shape against the same library; `pg-harness.mjs` proves multi-statement
DDL belongs on `db.exec`, so schema setup in the new harness uses `exec` and only the executor uses
`query`. Gotcha: PGlite's extended protocol infers parameter types less eagerly than `pg`; fixtures
must avoid bare untyped `NULL` parameters or add explicit `::type` casts.

## Scope boundary (explicit)

This change proves the **seam mechanism only**: construction on both paths, the exact
missing-connection-string error, `$queryRaw` path-independence, `$disconnect` on all three
variants, realtime teardown, and ONE happy-path CRUD round-trip
(`create`→`findMany`→`update`→`delete`) as a passthrough smoke test.

It does **not** audit or characterise the CRUD layer. `buildWhere`'s eleven operators, column
aliasing, `select`/`orderBy`/`take`/`skip`, and null handling are deliberately out of scope; a
genuine correctness suite for them is the roadmap's later ORM-parity work and would dwarf this
budget. The harness landed here is what makes that later effort cheap.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Constructor guard, `$disconnect` on all three variants, realtime teardown | Plain-Node asserts with a stub executor; no PGlite needed |
| Integration | `$queryRaw` + one CRUD round-trip through the injected executor | `withDatabase` + `createPgliteExecutor`, real SQL against in-process Postgres |
| E2E | N/A | Default `pg.Pool` path still requires a live server; unchanged and untested by design |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The change adds no new SQL string construction; all statements
remain parameterized through the existing `ModelDelegate`.

## Turbo wiring

No `turbo.json` change. `test` already exists with `dependsOn: ["build"]` and Turbo discovers it
from the package's `scripts` — the same zero-config path `compiler`, `migrator`, `generator` and
`cli` already use.

## Size forecast

~35 changed lines in `client.ts`, ~4 in `package.json`, ~60 + ~170 new test lines ≈ **270 authored
lines** against the 800-line budget. A **single slice** is sufficient; there is no chaining need
here and none should be invented.

## Migration / Rollout

No migration required. The option is additive and opt-in; no schema, IR, WASM or generated-code
contract is touched, so no rebuild cascade.

## Open Questions

- None blocking.
