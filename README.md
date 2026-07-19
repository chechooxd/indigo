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

> Requires Node 20+ and a reachable PostgreSQL instance. For a throwaway DB:
> `docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`

```bash
# 1. Install the CLI and runtime (see "Local install" below until published)
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

The client supports `findMany`, `findFirst`, `findUnique`, `create`, `update`,
`delete`, `count` and `$queryRaw`, with a `where` subset (equality, `in`, `notIn`,
`lt/lte/gt/gte`, `contains/startsWith/endsWith`), `select`, `orderBy`, `take`, `skip`.

## Migrations

`db push` syncs the database directly (no history) — great for prototyping. For
production, use **versioned migrations** (like `prisma migrate`):

```bash
npx indigodb migrate dev --name init      # diff schema → migration file, apply it
npx indigodb migrate dev --name add_posts # after editing schema.indigo
npx indigodb migrate deploy               # apply pending migrations (CI/prod)
npx indigodb migrate status               # what's applied vs pending
```

Migrations are written to `migrations/<timestamp>_<name>/migration.sql` (commit
them), tracked in a `_indigo_migrations` table, and cover create/drop tables and
columns, column type / nullability / default changes, enum additions, indexes
and foreign keys.

| Command             | Like Prisma          | Use for                    |
| ------------------- | -------------------- | -------------------------- |
| `db push`           | `prisma db push`     | prototyping, no history    |
| `migrate dev`       | `prisma migrate dev` | development, with history   |
| `migrate deploy`    | `prisma migrate deploy` | production / CI          |

## Studio

```bash
npx indigodb studio     # opens http://localhost:5555 in your browser
```

Launches (and opens, like Prisma Studio) the visual workspace wired to your real
schema and database — the single home for everything visual:

- **ER diagram + editor** — the MER rendered from `schema.indigo` (dbdiagram-style)
- **Data browser** — tables, fields and live rows
- **SQL console** — run read-only queries directly
- **Documentation** — columns, constraints, notes and relations (dbdocs-style)

## Local install (before npm publish)

The packages aren't on npm yet. To try them in an external project, build the
workspace and link the CLI + runtime:

```bash
pnpm install && pnpm build
# from the repo root:
pnpm --filter @indigodb/cli --filter @indigodb/client exec npm link
# in your project:
npm link @indigodb/cli @indigodb/client
```

## Repository layout

See [CLAUDE.md](CLAUDE.md) for the architecture. In short: `@indigodb/parser`
parses `.indigo`, `@indigodb/core` resolves it into a relational IR, and the
`migrator` / `generator` / `docs` / `client` / `studio` all consume that IR.

## Status

MVP. Post-MVP: nested `include`/writes in the client, MySQL/SQLite dialects,
a dedicated `@indigodb/nestjs` module, and npm publishing.
