/**
 * @indigodb/migrator — `indexName`/`renderIndexDdl` direct unit coverage.
 *
 * `postgres.ts` exports these two helpers (replacing the inline
 * name-derivation/`CREATE INDEX` logic previously duplicated at
 * `postgres.ts:284-292`); `migrate.ts` imports the same helpers instead of
 * re-deriving the name/DDL text independently (design decision #9 — avoids
 * `USING <method>` drift between the two DDL paths).
 */

import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { PGlite } from "@electric-sql/pglite";
import { parse, resolve, printSchema } from "@indigodb/core";
import { indexName, renderIndexDdl, renderPushSql, planMigration, introspectResolvedSchema } from "../dist/index.js";

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

check("partial index renders WHERE clause after column list", () => {
  deepStrictEqual(
    renderIndexDdl(table(), index({ where: "deleted_at IS NULL" })),
    `CREATE INDEX "User_email_idx" ON "User" ("email") WHERE deleted_at IS NULL;`,
  );
});

check("expression index renders raw expression without double-quoting", () => {
  deepStrictEqual(
    renderIndexDdl(
      table(),
      index({ columns: [], name: "user_lower_email_idx", expression: "lower(email)" }),
    ),
    `CREATE INDEX "user_lower_email_idx" ON "User" (lower(email));`,
  );
});

check("combined partial + expression unique index renders both expression and WHERE", () => {
  deepStrictEqual(
    renderIndexDdl(
      table(),
      index({
        columns: [],
        unique: true,
        name: "user_active_lower_email_key",
        expression: "lower(email)",
        where: "deleted_at IS NULL",
      }),
    ),
    `CREATE UNIQUE INDEX "user_active_lower_email_key" ON "User" (lower(email)) WHERE deleted_at IS NULL;`,
  );
});

check("diffing a where-predicate change emits DROP INDEX + CREATE INDEX", () => {
  const prev = resolve(
    parse(`Table User {\n  id Int @id\n  email String\n  deletedAt DateTime? @map("deleted_at")\n  active Boolean\n  @@index([email], name: "user_email_idx", where: "deleted_at IS NULL")\n}`),
  );
  const next = resolve(
    parse(`Table User {\n  id Int @id\n  email String\n  deletedAt DateTime? @map("deleted_at")\n  active Boolean\n  @@index([email], name: "user_email_idx", where: "active = true")\n}`),
  );
  const plan = planMigration(prev, next);
  const sqls = plan.statements.map((s) => s.sql);
  deepStrictEqual(sqls, [
    `DROP INDEX "user_email_idx";`,
    `CREATE INDEX "user_email_idx" ON "User" ("email") WHERE active = true;`,
  ]);
});

check("diffing an expression change emits DROP INDEX + CREATE INDEX", () => {
  const prev = resolve(
    parse(`Table User {\n  id Int @id\n  email String\n  @@index([], name: "user_expr_idx", expression: "lower(email)")\n}`),
  );
  const next = resolve(
    parse(`Table User {\n  id Int @id\n  email String\n  @@index([], name: "user_expr_idx", expression: "upper(email)")\n}`),
  );
  const plan = planMigration(prev, next);
  const sqls = plan.statements.map((s) => s.sql);
  ok(sqls.includes(`DROP INDEX "user_expr_idx";`), `expected DROP in ${sqls}`);
  ok(sqls.includes(`CREATE INDEX "user_expr_idx" ON "User" (upper(email));`), `expected CREATE in ${sqls}`);
});

check("printSchema preserves where and expression arguments", () => {
  const src = `Table Account {\n  id Int @id\n  email String\n  deletedAt DateTime? @map("deleted_at")\n  @@unique([email], name: "active_email_key", where: "deleted_at IS NULL")\n  @@index([], name: "lower_email_idx", expression: "lower(email)")\n}\n`;
  const printed = printSchema(resolve(parse(src)));
  ok(printed.includes('where: "deleted_at IS NULL"'), `printed missing where:\n${printed}`);
  ok(printed.includes('expression: "lower(email)"'), `printed missing expression:\n${printed}`);
});

async function runPgliteRoundTrip() {
  const db = new PGlite();
  try {
    const src = `Table Account {\n  id Int @id @default(autoincrement())\n  email String\n  deletedAt DateTime? @map("deleted_at")\n  @@index([email], where: "deleted_at IS NULL")\n  @@unique([email], name: "Account_email_key", where: "deleted_at IS NULL")\n  @@index([], name: "account_lower_email_idx", expression: "lower(email)")\n}\n`;
    const resolved = resolve(parse(src));
    await db.exec(renderPushSql(resolved));

    const introspected = await introspectResolvedSchema((sql, params) => db.query(sql, params));
    const account = introspected.tables.find((t) => t.dbName === "Account");
    ok(account, "Account table introspected");

    // Partial single-column unique index even with derived name MUST NOT fold into col.unique
    const emailCol = account.columns.find((c) => c.dbName === "email");
    strictEqual(emailCol.unique, false, "partial unique index must not mark column as full-table @unique");

    const partialPlain = account.indexes.find((i) => !i.unique && i.columns.includes("email"));
    ok(partialPlain && partialPlain.where && partialPlain.where.includes("deleted_at"), `missing partial plain index: ${JSON.stringify(account.indexes)}`);

    const partialUnique = account.indexes.find((i) => i.unique && i.columns.includes("email"));
    ok(partialUnique && partialUnique.where && partialUnique.where.includes("deleted_at"), `missing partial unique index: ${JSON.stringify(account.indexes)}`);

    const exprIdx = account.indexes.find((i) => i.name === "account_lower_email_idx");
    ok(exprIdx && exprIdx.columns.length === 0 && exprIdx.expression && exprIdx.expression.includes("lower"), `missing expression index: ${JSON.stringify(account.indexes)}`);
    console.log("  ok   PGlite push + introspect round-trips partial, partial-unique, and expression indexes");
  } catch (err) {
    failures++;
    console.error("  FAIL PGlite push + introspect round-trip");
    console.error(err.stack ?? err.message);
  } finally {
    await db.close();
  }
}

await runPgliteRoundTrip();

if (failures > 0) {
  console.error(`\nindex-ddl: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nindex-ddl: all green");
