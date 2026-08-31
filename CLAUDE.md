# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IndigoDB is a schema-first database toolkit built around a custom `.indigo` schema language.
It is a **pnpm + Turborepo monorepo** (`packageManager: pnpm@10.28.1`) with ESM-only TypeScript
packages, plus one Rust crate: the `.indigo` compiler (`crates/indigo-compiler`), compiled to
WASM and consumed through `packages/compiler`.

## Commands

All commands run from the repo root and fan out through Turborepo:

- `pnpm install` — install workspace deps
- `pnpm dev` — run all `dev` tasks (Studio dev server on :5555); `dev` depends on `^build`
- `pnpm build` — build every package (`tsc`) and the Studio app (`tsc -b && vite build`)
- `pnpm lint` — typecheck-as-lint: every package's `lint` is `tsc --noEmit`
- `pnpm test` — wired via Turbo (`turbo test`, depends on `build`) and fans out to every
  package's own plain-Node test script (no shared runner/framework — each package's `test`
  is a `node test/a.mjs && node test/b.mjs && ...` chain, plus `apps/studio`'s `vitest run`).
  Run a single file directly, e.g. `node packages/client/test/live.mjs`, or scope one
  package with `pnpm test --filter=@indigodb/client`. `@indigodb/compiler`'s suite
  (`test/parity.mjs`) checks the WASM artifact against golden snapshots in
  `fixtures/snapshots/`. `@indigodb/realtime`'s Postgres-backed suites (`wal-source.mjs`,
  `pg-harness.mjs`) are gated on `INDIGODB_TEST_DATABASE_URL` — unset, they print `SKIP` and
  pass; to actually exercise them, point that env var at a real Postgres (see the docker
  one-liner in `packages/realtime/test/pg-harness.mjs`'s header).
- `pnpm clean` — remove `dist/` and `.turbo/` across packages

Rust compiler workflow (build:wasm, freshness guard, CI notes) is documented in
`crates/CLAUDE.md` — only loads when working under `crates/`.

Scope to one package with Turbo filters, e.g. `pnpm build --filter=@indigodb/parser`
or `pnpm --filter @indigodb/studio dev`.

## CI

**CI is currently disabled and nothing runs on push or PR.** The workflow was moved to
`.github/workflows-disabled/ci.yml` in commit `8acd5d4` ("private pre-product repo, billed
minutes with no payoff yet"), and `.github/workflows/` is empty. Verification is therefore
local: `pnpm build`, `pnpm lint`, `pnpm test` before landing on `main`. The one CI guarantee
that could not survive being switched off — nobody noticing a stale WASM artifact — is now
enforced by `packages/compiler/test/wasm-freshness.mjs` (see the `build:wasm` bullet above).

If it is re-enabled, move the file back; it still describes three independent jobs (no
`needs:`, so one red job never hides another):

- **`ts`** — `pnpm install/build/lint/test`. Installs **no** Rust toolchain, deliberately: the
  committed WASM artifact exists so TypeScript-only contributors never need cargo. If this job
  ever grows a Rust step, committing the artifact stops buying anything.
- **`rust`** — `cargo test --locked`. `--locked` is what actually pins `wasm-bindgen`, since the
  manifest carries a caret range and only the committed lockfile holds it at 0.2.126.
- **`wasm-drift`** — rebuilds the artifact. On `push` to `main`, if the rebuild differs from what's
  committed, it commits its own rebuild back as `github-actions[bot]` (loop-guarded: a commit
  already authored by the bot that still doesn't match fails loudly instead of committing forever).
  On a PR, it only reports drift — pushing to a PR branch isn't safe, especially from a fork.

Build order matters: `@indigodb/ast` is the base type contract; `@indigodb/core`
(the relational IR + resolver) sits on top of `ast` + `parser` and is the hub every other
package consumes. Turbo's `^build` handles ordering, so build from the root rather than
per-package when types cross package boundaries.

## Architecture

The whole system speaks **one `.indigo` language** (Prisma-style). The pipeline is:
`parser` (source → AST) → `core` (AST → resolved relational IR) → consumers
(`migrator`, `generator`, `docs`, `client`, `studio`). **`@indigodb/core`'s `ResolvedSchema`
is the central contract** — when adding a feature, resolve it once in `core` and let consumers
read the IR rather than re-deriving structure from the raw AST.

### Packages (`packages/*`)

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

### Studio app (`apps/studio`)
React 19 + Vite + Tailwind v4 + Zustand SPA. **It now depends on `@indigodb/core`** and parses
the single `.indigo` dialect in-browser (`useERDParser` → `parse`+`resolve`), adapting the IR via
`src/lib/schema-adapter.ts`. `src/lib/api.ts` talks to the `indigodb studio` backend
(`/api/schema`, `/api/schema/source`, `/api/tables/:name`, `/api/query`) and **fails soft**:
standalone `pnpm dev` has no backend, so components fall back to mock data (`src/data/mockData.ts`).
The old regex parser in `src/lib/parser.ts` now only provides the ERD view-model types.

Studio internals: single Zustand store (`src/store/useStudioStore.ts`, which also holds the
`resolvedSchema` used by `DocBrowser.tsx` for real relations); `@/` alias → `apps/studio/src`;
shadcn-style UI in `src/components/ui/`; feature modules in `src/features/` (`erd/` is a custom
canvas/SVG renderer — not a graph library — with orthogonal edge routing in `src/lib/routing.ts`
and node sizing in `src/shared/lib/node-geometry.ts`; `studio/browser/` = data browser);
i18n via `react-i18next` (`src/i18n/locales/` en/es). `studio/browser/hooks/useLiveTable.ts`
gives the Table Browser its live-refresh: it opens `@indigodb/client`'s `SseTransport` directly
against `REALTIME_PATH` for the active `@@realtime` table and debounces/coalesces a refetch on
each change — this is Studio's own dev-only connection to the **embedded, unauthenticated**
realtime stream, separate from (and simpler than) the generated client's `.live()`, which is
gated behind `@@allow` + a signed handle.

### CLI Studio server (`packages/cli/src/studio-server.ts`)
`indigodb studio` starts a `node:http` server that serves the built Studio SPA (located via
`require.resolve("@indigodb/studio/package.json")` → `dist`, overridable with `INDIGODB_STUDIO_DIST`)
plus the JSON API backed by the user's Postgres. `/api/query` only permits a single read-only
SELECT/WITH; `/api/tables/:name` aliases physical columns back to schema field names.

## Conventions

- ESM only (`"type": "module"`); packages compile with `tsc` to `dist/`, `strict` mode on.
- Packages reference each other via `workspace:*` and consume built output (`dist/`), so a
  cross-package type change needs a rebuild of the dependency before dependents see it.
