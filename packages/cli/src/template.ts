/** Starter templates written by `indigodb init`. */

export const SCHEMA_TEMPLATE = `// IndigoDB schema — https://indigodb.dev
// Edit your models here, then run:
//   indigodb db push     # sync the database
//   indigodb generate    # regenerate the typed client
//   indigodb docs        # regenerate documentation

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

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @note("Corporate email")
  name      String?
  role      UserRole @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]

  @@color("#818cf8")
  @@group("core")
}

model Post {
  id       Int     @id @default(autoincrement())
  title    String
  content  String?
  authorId Int     @map("author_id")
  author   User    @relation(fields: [authorId], references: [id])

  @@index([authorId])
  @@group("core")
}
`;

export const ENV_TEMPLATE = `# IndigoDB
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb"
`;
