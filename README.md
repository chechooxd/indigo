# IndigoDB

A schema-first, all-in-one database toolkit: **one `.indigo` language** drives a
typed ORM client (like Prisma), an ER-diagram + data Studio (like dbdiagram), and
HTML documentation (like dbdocs).

Define your models once, then:

```bash
indigodb db push      # sync your PostgreSQL database
indigodb generate     # generate a typed TypeScript client
indigodb studio       # open the visual workspace (ER diagram, data, docs, queries)
```

Everything visual lives in **Studio** (`indigodb studio`, launched like Prisma
Studio): the ER diagram + `.indigo` editor, the data/table browser, the SQL
query console, and the schema documentation.

## The `.indigo` language

A single schema: `Table` blocks (dbdiagram-style) carry Prisma-style attributes.
Doc metadata (`@note`) lives in the same file as the ORM semantics (`@id`,
`@relation`, …). ERD table groups and their color are declared separately with
a `TableGroup` block, which every table it lists inherits the color from:

```
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

generator client {
  provider = "indigodb-client-ts"
  output = "src/generated/indigo.ts"
}

enum UserRole { ADMIN USER GUEST }

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @note("Corporate email")
  role      UserRole @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
}

Table Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("author_id")
  author   User   @relation(fields: [authorId], references: [id])

  @@index([authorId])
}

TableGroup "Core" {
  color = "#818cf8"

  User
  Post
}
```

## Quickstart (in a NestJS / Node backend)

> Requires Node 22+ and a reachable PostgreSQL instance. For a throwaway DB:
> `docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`

```bash
# 1. Install the CLI and runtime
npm install @indigodb/cli @indigodb/client

# 2. Scaffold schema.indigo + .env
npx indigodb init

# 3. Edit schema.indigo and set DATABASE_URL in .env, then:
npx indigodb db push        # creates tables/enums/FKs (idempotent)
npx indigodb generate       # writes src/generated/indigo.ts
npx indigodb studio         # explore the schema, data and docs visually
```

Use the generated, typed client anywhere (NestJS, Express, plain Node):

```ts
import { IndigoClient } from "./generated/indigo";

const db = new IndigoClient(); // reads DATABASE_URL

const user = await db.user.create({
  data: { email: "alice@acme.dev", role: "ADMIN" },
});

const admins = await db.user.findMany({
  where: { role: "ADMIN", email: { contains: "acme" } },
  orderBy: { createdAt: "desc" },
  take: 20,
});

await db.$disconnect();
```

The client supports `findMany`, `findFirst`, `findUnique`, `create`, `createMany`,
`update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `count`, `aggregate`,
`groupBy`, `explain`, `$transaction`, `$withSession` (for RLS `@@allow`),
`$extends`, `$queryRaw`, cursor pagination, relation `include`/nested writes,
driver adapters (`pg` and `PGlite`), and rich `where` filters (logical `AND`/`OR`/`NOT`,
relation filters, JSON path filters, case-insensitive string operators).

## Migrations

`db push` syncs the database directly (no history) — great for prototyping. For
production, use **versioned migrations** (like `prisma migrate`):

```bash
npx indigodb migrate dev --name init      # diff schema → migration file, apply it
npx indigodb migrate dev --name add_posts # after editing schema.indigo
npx indigodb migrate dev --name backfill --create-only --empty # scaffold DDL + data.sql
npx indigodb migrate deploy               # apply pending migrations (CI/prod)
npx indigodb migrate status               # what's applied vs pending
npx indigodb migrate resolve              # mark baseline / rolled-back migrations
npx indigodb db pull                      # introspect existing PostgreSQL into schema.indigo
```

Migrations are written to `migrations/<timestamp>_<name>/migration.sql` (with an optional
transactional sibling `data.sql` for data backfills), tracked with SHA-256 checksums in
`_indigo_migrations`, and cover tables, columns, native types, enums, partial and expression
indexes, foreign keys, RLS policies (`@@allow`), and logical-replication DDL (`@@realtime`).

| Command             | Like Prisma          | Use for                    |
| ------------------- | -------------------- | -------------------------- |
| `db push`           | `prisma db push`     | prototyping, no history    |
| `db pull`           | `prisma db pull`     | introspect existing DB     |
| `migrate dev`       | `prisma migrate dev` | development, with history   |
| `migrate deploy`    | `prisma migrate deploy` | production / CI          |

## Realtime & React

Mark models with `@@realtime` to stream PostgreSQL logical-replication (`pgoutput`)
notifications over HTTP SSE, run ephemeral Presence & Broadcast channels, and inspect live
operational metrics (`GET /api/realtime/metrics` / `onTelemetry`):

```bash
npx indigodb realtime   # starts the realtime SSE + channels + metrics daemon
```

Consume from browsers with zero Node/`pg` dependencies via `@indigodb/client/realtime`
(`createLiveSubscription`, `createChannel`) or `@indigodb/react` (`useLiveTable`,
`useChannel`).

## Studio

```bash
npx indigodb studio     # opens http://localhost:5555 in your browser
```

Launches (and opens, like Prisma Studio) the visual workspace wired to your real
schema and database — the single home for everything visual:

- **ER diagram + editor** — the MER rendered from `schema.indigo` (dbdiagram-style)
- **Data browser** — paginated tables, record editor, and live updates
- **SQL console** — run read-only queries directly with row and timeout guardrails
- **Documentation** — columns, constraints, indexes, notes and relations (dbdocs-style)

## Local development install

To try packages from a local checkout in an external project, build the workspace and link
the CLI + runtime:

```bash
pnpm install && pnpm build
# from the repo root:
pnpm --filter @indigodb/cli --filter @indigodb/client exec npm link
# in your project:
npm link @indigodb/cli @indigodb/client
```

## Repository layout

See [CLAUDE.md](CLAUDE.md) for the architecture. In short: `@indigodb/compiler`
(Rust → WASM) and `@indigodb/parser` parse `.indigo`, `@indigodb/core` resolves it into
a relational IR, and `migrator` / `generator` / `client` / `realtime` / `react` / `studio`
/ `cli` build on that IR.

## Status

Pre-release candidate on PostgreSQL (Node 22+). Planned post-1.0: MySQL/SQLite dialects
and framework integration modules.
