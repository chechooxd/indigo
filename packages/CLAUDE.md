# Packages (`packages/*`)

Loaded when working under `packages/`. The root `CLAUDE.md` carries the commands,
CI workflow, and conventions that apply everywhere.

- **`@indigodb/ast`** — pure AST type definitions (`Schema`, `Model`, `Field`, `Attribute`,
  `Relation`, `ScalarType`, `SCALAR_TYPES`). No logic. The syntactic contract.
- **`crates/indigo-compiler` + `@indigodb/compiler`** — the compiler itself, in Rust:
  `lexer.rs` (logos; keywords matched post-lex, replicating Chevrotain's `LONGER_ALT`),
  `parser.rs` (hand-written recursive descent with declaration-level recovery → multiple
  errors per pass with 1-based line/column), `resolve.rs`/`validate.rs` (ports of the old TS
  resolver/validator), `ast.rs`/`ir.rs` (serde mirrors of `@indigodb/ast` + core's `ir.ts` —
  **the serde attributes ARE the JSON contract**; absent keys ≡ TS `undefined`). The WASM
  boundary speaks JSON-string envelopes (`{ok}`/`{errors}`/`{error}`). `packages/compiler`
  wraps it with conditional exports: `index.node.ts` calls `initSync` at load (fully sync on
  Node), `index.browser.ts` exposes async `initCompiler()` (the Studio awaits it in
  `main.tsx` before rendering; Vite needs no wasm plugin — `new URL(..., import.meta.url)`
  plus `optimizeDeps.exclude` for the workspace packages).
- **`@indigodb/parser`** — thin wrapper: `parse(source)` delegates to `@indigodb/compiler`
  and rethrows failures as `IndigoParseError` (class lives here so `instanceof` keeps working).
- **`@indigodb/core`** — `resolve(schema)` → `ResolvedSchema` (`ir.ts`): physical
  tables/columns, PKs, `foreignKeys`, `indexes`, `relations`, doc metadata (`@note`),
  `@@realtime`, plus `tableGroups` resolved from `TableGroup "Name" { color = "#hex" ... }`
  blocks — each table listed inherits the group's `color`. `resolve`/`validate` delegate to
  the WASM compiler and apply the IR typing; the types in `ir.ts` and the helpers in
  `attributes.ts` remain TS-native. Re-exports `parse`, `IndigoParseError` and `initCompiler`.
- **`@indigodb/migrator`** — two rendering paths off the IR. `postgres.ts`'s `renderPushSql(resolved)`
  emits **idempotent** DDL for `db push` (`CREATE ... IF NOT EXISTS`, guarded `DO $$` blocks).
  `migrate.ts`'s `diffResolved(prev, next)` / `renderMigrationSql` emit **exact, ordered** DDL for
  versioned migrations (create/drop table, add/drop/alter column, enum add-value, indexes, FKs,
  `@@realtime` notify triggers).
- **`@indigodb/generator`** — `generateClient(resolved)` in `client.ts` emits a typed `indigo.ts`
  (enums, row/create/update interfaces, model metadata, an `IndigoClient` binding one
  `ModelDelegate` per model; `RealtimeModelDelegate` for `@@realtime` models).
- **`@indigodb/realtime`** — Postgres → client change-event engine for `@@realtime` tables,
  `pg`/`pg-logical-replication` only. `RealtimeEngine` (`engine.ts`) is the embeddable
  fan-out hub: consumes a `RealtimeSource` and pushes `RealtimeEvent`s to in-process
  listeners and SSE subscribers (`GET <REALTIME_PATH>?tables=...`) over plain `node:http`
  — no framework. Default source is `WalSource` (`wal-source.ts`, logical replication /
  `pgoutput`, no events lost while disconnected); `PgNotifySource` (`source.ts`, v1
  LISTEN/NOTIFY) remains exported and pluggable via `RealtimeEngineOptions.source`. The
  `RealtimeSource` seam (`protocol.ts`) keeps the wire protocol and SDK stable across both.
  `handle.ts` mints/verifies HMAC-signed handles (`mintHandle`/`verifyHandle`) that gate the
  replay-log route (`REALTIME_LOG_PATH`) to a caller's own rows. Consumed by the `indigodb
  realtime` CLI command and embedded directly in the Studio server.
- **`@indigodb/client`** — framework-agnostic runtime. `IndigoClientBase` (`client.ts`) owns
  the `pg` Pool + parameterized executor; `ModelDelegate` (`delegate.ts`) implements
  Prisma-style CRUD (`findMany/findUnique/create/update/delete/count`, `where` subset,
  `select`, `orderBy`). `adapters/` (`pg.ts`, `pglite.ts`) let callers hand in an already-open
  driver (e.g. embedded PGlite) instead of a `connectionString`, behind the same
  `DriverAdapter` shape. `realtime.ts` + `live.ts` + `realtime-delegate.ts` are the browser-safe
  client half of the realtime story: `realtime.ts` runs the SSE protocol over `fetch()`
  streaming (not the `EventSource` global, absent in Node <22), one connection per table,
  refcounted across subscribers, reconnecting with backoff; `live.ts` layers `findMany().live()`
  on top — snapshot-then-tail, debounced/coalesced refetch on wake — for `RealtimeModelDelegate`s
  the generator emits. These files deliberately import **type-only** (or not at all) from
  `@indigodb/realtime`'s root entry, since that pulls `pg` via `engine.ts`/`wal-source.ts`;
  value imports go through the dependency-free `@indigodb/realtime/protocol` subpath instead,
  so this package stays safe to bundle into a browser build. Consumed by the generated client.
- **`@indigodb/cli`** — the `indigodb` binary (commander). Commands: `init`, `generate`,
  `db push` (executes SQL via `pg`; `--print` to dry-run), `migrate dev/deploy/status`,
  `studio`, `realtime` (standalone SSE daemon over `@indigodb/realtime`'s `RealtimeEngine`,
  requires at least one `@@realtime` table). Shared helpers in `util.ts` (`.env` loader,
  `loadSchema`, `resolveConnectionString`). `migrate-runner.ts` owns migration files
  (`migrations/<ts>_<name>/migration.sql`), the `.snapshot.json` used to diff the next
  migration, and the `_indigo_migrations` history table. `studio-server.ts` is a
  dependency-free `node:http` server (see below).

**Everything visual lives in the Studio** (`indigodb studio`), by design — the ER diagram +
editor, data/table browser, SQL console, and documentation. There is intentionally no separate
docs/HTML generator; the docs view is a Studio module (`DocBrowser.tsx`).
