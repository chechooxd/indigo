/**
 * Shared minimal `ResolvedSchema` fixture for `WalSource` unit tests: two
 * `@@realtime` models (`Post`, `Comment`) plus one non-realtime model
 * (`Draft`) so "unknown table" behaviour has something real to test against.
 * Built via `parse`+`resolve` (not hand-typed IR) so the fixture stays
 * structurally identical to what a real schema resolves to.
 */
import { parse, resolve } from "@indigodb/core";

const SOURCE = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table Post {
  id    Int    @id @default(autoincrement())
  title String
  body  String @map("body_text")

  @@realtime
}

Table Comment {
  id     Int    @id @default(autoincrement())
  postId Int    @map("post_id")
  text   String

  @@realtime
}

Table Draft {
  id    Int    @id @default(autoincrement())
  title String
}
`;

export function testSchema() {
  return resolve(parse(SOURCE));
}
