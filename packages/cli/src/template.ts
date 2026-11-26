/** Starter templates written by `indigodb init`. */

export const SCHEMA_TEMPLATE = `// IndigoDB schema — https://indigodb.dev
// Edit your models here, then run:
//   indigodb db push     # sync the database
//   indigodb generate    # regenerate the typed client
//   indigodb studio      # open ER diagram, data browser, docs & queries

datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

generator client {
  provider = "indigodb-client-ts"
  output = "src/generated/indigo.ts"
}

enum UserRole {
  ADMIN
  USER
  GUEST
}

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @note("Corporate email")
  name      String?
  role      UserRole @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
}

Table Post {
  id       Int     @id @default(autoincrement())
  title    String
  content  String?
  authorId Int     @map("author_id")
  author   User    @relation(fields: [authorId], references: [id])

  @@index([authorId])
  // Uncomment to stream INSERT/UPDATE/DELETE events (indigodb realtime):
  // @@realtime
}

TableGroup "Core" {
  color = "#818cf8"

  User
  Post
}
`;

export const ENV_TEMPLATE = `# IndigoDB
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb"
`;
