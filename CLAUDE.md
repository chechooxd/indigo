# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IndigoDB is a schema-first database toolkit built around a custom `.indigo` schema language.
It is a **pnpm + Turborepo monorepo** (`packageManager: pnpm@10.28.1`) with ESM-only TypeScript packages.

## Commands

All commands run from the repo root and fan out through Turborepo:

- `pnpm install` — install workspace deps
- `pnpm dev` — run all `dev` tasks (Studio dev server on :5555); `dev` depends on `^build`
- `pnpm build` — build every package (`tsc`) and the Studio app (`tsc -b && vite build`)
- `pnpm lint` — typecheck-as-lint: every package's `lint` is `tsc --noEmit`
- `pnpm test` — wired via Turbo but **no tests exist yet**; there is no test runner configured
- `pnpm clean` — remove `dist/` and `.turbo/` across packages

Scope to one package with Turbo filters, e.g. `pnpm build --filter=@indigodb/parser`
or `pnpm --filter @indigodb/studio dev`.

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
- **`@indigodb/parser`** — `parse(source)` → `Schema` AST via Chevrotain. Stages:
  `lexer.ts` (tokens; order matters, keywords use `LONGER_ALT`) → `parser.ts` (`CstParser`) →
  `index.ts`'s `cstToAst()` (hand-written `any`-typed CST→AST; TODO: migrate to `CstVisitor`).
  Throws `IndigoParseError`.
- **`@indigodb/core`** — `resolve(schema)` → `ResolvedSchema` (`ir.ts`): physical
  tables/columns, PKs, `foreignKeys`, `indexes`, `relations`, plus doc/diagram metadata
  (`@note`, `@@color`, `@@group`). Also `validate(schema)` and attribute helpers (`attributes.ts`).
  Relations are resolved here from `@relation(fields:/references:)` — the parser does NOT.
- **`@indigodb/migrator`** — `renderPushSql(resolved)` in `postgres.ts` emits **idempotent**
  PostgreSQL DDL for `db push` (`CREATE TABLE/TYPE ... IF NOT EXISTS`, guarded `DO $$` blocks
  for enums/FKs). The older `diff()`/`DialectAdapter` scaffolding remains for future incremental
  migrations.
- **`@indigodb/generator`** — `generateClient(resolved)` in `client.ts` emits a typed `indigo.ts`
  (enums, row/create/update interfaces, model metadata, an `IndigoClient` binding one
  `ModelDelegate` per model). The older `generate()` (interfaces-only string) still exists.
- **`@indigodb/client`** — framework-agnostic runtime. `IndigoClientBase` (`client.ts`) owns the
  `pg` Pool + parameterized executor; `ModelDelegate` (`delegate.ts`) implements Prisma-style
  CRUD (`findMany/findUnique/create/update/delete/count`, `where` subset, `select`, `orderBy`).
  Consumed by the generated client.
- **`@indigodb/cli`** — the `indigodb` binary (commander). Commands: `init`, `generate`,
  `db push` (executes SQL via `pg`; `--print` to dry-run), `studio`. Shared helpers in
  `util.ts` (`.env` loader, `loadSchema`, `resolveConnectionString`). `studio-server.ts` is a
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
shadcn-style UI in `src/components/ui/`; feature modules in `src/features/` (`erd/` built on
`@xyflow/react` with orthogonal routing in `src/lib/routing.ts`; `studio/browser/` = data browser);
i18n via `react-i18next` (`src/i18n/locales/` en/es).

### CLI Studio server (`packages/cli/src/studio-server.ts`)
`indigodb studio` starts a `node:http` server that serves the built Studio SPA (located via
`require.resolve("@indigodb/studio/package.json")` → `dist`, overridable with `INDIGODB_STUDIO_DIST`)
plus the JSON API backed by the user's Postgres. `/api/query` only permits a single read-only
SELECT/WITH; `/api/tables/:name` aliases physical columns back to schema field names.

## Conventions

- ESM only (`"type": "module"`); packages compile with `tsc` to `dist/`, `strict` mode on.
- Packages reference each other via `workspace:*` and consume built output (`dist/`), so a
  cross-package type change needs a rebuild of the dependency before dependents see it.
