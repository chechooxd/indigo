/**
 * @indigodb/generator — index metadata & uniqueGroups safety suite
 * (`named-index-followups`).
 *
 * Proves:
 *   1. `__meta[Model].indexes` is emitted with logical field names and carries
 *      `unique`, optional `name`, `type`, `where`, and `expression`.
 *   2. Partial (`where`) and expression (`expression`) unique indexes are
 *      EXCLUDED from `uniqueGroups` / `<Model>WhereUniqueInput` so `upsert`
 *      never emits an invalid unconditional `ON CONFLICT (cols)` targeting
 *      a partial or expression index.
 */

import { ok } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 20).join("\n"));
  }
}

console.log("generator regression: index metadata & uniqueGroups emission");

const SCHEMA_SRC = `
Table Account {
  id        Int       @id @default(autoincrement())
  orgId     Int       @map("org_id")
  slug      String
  email     String
  deletedAt DateTime? @map("deleted_at")

  @@unique([orgId, slug])
  @@unique([email], name: "account_active_email_key", where: "deleted_at IS NULL")
  @@index([email], name: "account_email_idx", type: hash)
  @@unique([], name: "account_lower_email_key", expression: "lower(email)")
}
`;

const generated = generateClient(resolve(parse(SCHEMA_SRC)));
const metaLine = generated.split("\n").find((l) => l.includes('"Account": { name: "Account"'));

check("uniqueGroups excludes partial and expression unique indexes while keeping PK and full @@unique", () => {
  ok(metaLine, "Account __meta entry emitted");
  ok(
    metaLine.includes('uniqueGroups: [["id"], ["orgId", "slug"]]'),
    `unexpected uniqueGroups in: ${metaLine}`,
  );
  ok(
    !metaLine.includes('uniqueGroups: [["id"], ["orgId", "slug"], ["email"]'),
    "partial unique index must not appear in uniqueGroups",
  );
});

check("<Model>WhereUniqueInput omits partial/expression unique indexes", () => {
  const uniqueType = generated
    .split("\n")
    .find((l) => l.startsWith("export type AccountWhereUniqueInput"));
  ok(uniqueType, "AccountWhereUniqueInput emitted");
  ok(uniqueType.includes("{ id: number }"));
  ok(uniqueType.includes("{ orgId: number; slug: string }"));
  ok(!uniqueType.includes("email"), `partial/expression email unique leaked into WhereUniqueInput: ${uniqueType}`);
});

check("__meta[Model].indexes emits all declared indexes with schema field names and options", () => {
  ok(metaLine, "Account __meta entry emitted");
  ok(metaLine.includes('{ fields: ["orgId", "slug"], unique: true }'), `missing composite unique: ${metaLine}`);
  ok(
    metaLine.includes('{ fields: ["email"], unique: true, name: "account_active_email_key", where: "deleted_at IS NULL" }'),
    `missing partial unique: ${metaLine}`,
  );
  ok(
    metaLine.includes('{ fields: ["email"], unique: false, name: "account_email_idx", type: "hash" }'),
    `missing hash index: ${metaLine}`,
  );
  ok(
    metaLine.includes('{ fields: [], unique: true, name: "account_lower_email_key", expression: "lower(email)" }'),
    `missing expression unique: ${metaLine}`,
  );
});

if (failures > 0) {
  console.error(`\nindex-emission: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nindex-emission: all green");
