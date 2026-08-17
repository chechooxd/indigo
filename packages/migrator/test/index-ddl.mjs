/**
 * @indigodb/migrator — `indexName`/`renderIndexDdl` direct unit coverage.
 *
 * `postgres.ts` exports these two helpers (replacing the inline
 * name-derivation/`CREATE INDEX` logic previously duplicated at
 * `postgres.ts:284-292`); `migrate.ts` imports the same helpers instead of
 * re-deriving the name/DDL text independently (design decision #9 — avoids
 * `USING <method>` drift between the two DDL paths).
 */

import { deepStrictEqual } from "node:assert";
import { indexName, renderIndexDdl } from "../dist/index.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

/** Minimal `ResolvedTable` builder — only the fields these helpers read. */
function table(overrides = {}) {
  return { name: "User", dbName: "User", columns: [], primaryKey: [], foreignKeys: [], indexes: [], relations: [], ...overrides };
}

/** Minimal `ResolvedIndex` builder. */
function index(overrides = {}) {
  return { columns: ["email"], unique: false, ...overrides };
}

console.log("index-ddl: indexName unit cases");

check("indexName uses derived name when omitted (plain index -> _idx suffix)", () => {
  deepStrictEqual(indexName(table(), index()), "User_email_idx");
});

check("indexName uses derived name with _key suffix for unique", () => {
  deepStrictEqual(indexName(table(), index({ unique: true })), "User_email_key");
});

check("indexName uses explicit name verbatim when present", () => {
  deepStrictEqual(indexName(table(), index({ name: "custom_idx" })), "custom_idx");
});

console.log("\nindex-ddl: renderIndexDdl unit cases");

check("USING is omitted when type is absent (byte-identical to pre-change DDL)", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index()),
    `CREATE INDEX "User_email_idx" ON "User" ("email");`,
  );
});

check("USING <method> is included, positioned before the column list (Postgres syntax)", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index({ type: "gin" })),
    `CREATE INDEX "User_email_idx" ON "User" USING gin ("email");`,
  );
});

check("explicit name is used verbatim in the rendered DDL", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index({ name: "custom_idx", type: "gist" })),
    `CREATE INDEX "custom_idx" ON "User" USING gist ("email");`,
  );
});

check("unique index renders CREATE UNIQUE INDEX", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index({ unique: true })),
    `CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");`,
  );
});

check("ifNotExists: true adds IF NOT EXISTS", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index(), { ifNotExists: true }),
    `CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User" ("email");`,
  );
});

check("ifNotExists defaults to false (no IF NOT EXISTS)", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index()),
    `CREATE INDEX "User_email_idx" ON "User" ("email");`,
  );
});

check("multi-column index renders comma-joined quoted columns", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index({ columns: ["email", "tags"], unique: true, ifNotExists: undefined })),
    `CREATE UNIQUE INDEX "User_email_tags_key" ON "User" ("email", "tags");`,
  );
});

if (failures > 0) {
  console.error(`\nindex-ddl: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nindex-ddl: all green");
