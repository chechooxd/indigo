/**
 * @indigodb/migrator — Row-Level Security DDL unit coverage
 * (`@@allow` → `postgres.ts`, design.md decisions 8/11/12/13/17, tasks.md
 * C1.1/C1.2/C1.3).
 *
 * Exercises `columnSqlType`, `policyName`, `renderPolicy`, `renderRlsBlock`
 * and `renderDisableRls` directly against synthetic `ResolvedTable`/
 * `AllowRule` objects — the same style as `native-type.mjs` and
 * `index-ddl.mjs`: no fixture files, exact-string assertions pinning the
 * exact SQL shape the design table requires.
 */

import { deepStrictEqual, throws, ok } from "node:assert";
import {
  columnSqlType,
  policyName,
  renderPolicy,
  renderRlsBlock,
  renderDisableRls,
} from "../dist/index.js";

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

/** Minimal `ResolvedColumn` builder. */
function col(overrides = {}) {
  return {
    name: "field",
    dbName: "field",
    type: "String",
    isEnum: false,
    nullable: false,
    isPk: false,
    unique: false,
    autoincrement: false,
    ...overrides,
  };
}

/** Minimal `ResolvedTable` builder, with `ownerId` (Int) present by default
 * so `field`-operand rules resolve against a real column. */
function table(overrides = {}) {
  return {
    name: "Post",
    dbName: "Post",
    columns: [
      col({ name: "id", dbName: "id", type: "Int", isPk: true }),
      col({ name: "ownerId", dbName: "ownerId", type: "Int" }),
      col({ name: "status", dbName: "status", type: "String" }),
    ],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
    relations: [],
    ...overrides,
  };
}

const claim = { kind: "claim", name: "userId" };
const field = (name) => ({ kind: "field", name });

console.log("rls: RLS DDL unit cases");

// ─── columnSqlType (design decision 8) ─────────────────────────────────────

check("columnSqlType: Int -> integer", () => {
  deepStrictEqual(columnSqlType(col({ type: "Int" })), "integer");
});

check("columnSqlType: @db.Uuid native override -> UUID", () => {
  deepStrictEqual(
    columnSqlType(col({ type: "String", nativeType: { name: "Uuid", args: [] } })),
    "UUID",
  );
});

check("columnSqlType: String (no native override) -> text", () => {
  deepStrictEqual(columnSqlType(col({ type: "String" })), "text");
});

check("columnSqlType: autoincrement Int -> integer (IDENTITY base wins)", () => {
  deepStrictEqual(columnSqlType(col({ type: "Int", autoincrement: true })), "integer");
});

// ─── policyName (design decision 11) ───────────────────────────────────────

check("policyName: indigo_p_<dbName>_<action>_<ordinal>", () => {
  const t = table();
  const rule = { action: "read", left: claim, right: field("ownerId") };
  deepStrictEqual(policyName(t, rule, 0), "indigo_p_Post_read_0");
});

check("policyName: rejects a name exceeding 63 bytes", () => {
  const t = table({ dbName: "a".repeat(60) });
  const rule = { action: "read", left: claim, right: field("ownerId") };
  throws(() => policyName(t, rule, 0), /63 bytes/);
});

// ─── renderPolicy (design decision 12) ─────────────────────────────────────

check("renderPolicy: read -> FOR SELECT USING, claim cast to field's SQL type, NULLIF-guarded", () => {
  const t = table();
  const rule = { action: "read", left: claim, right: field("ownerId") };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes(`CREATE POLICY "indigo_p_Post_read_0" ON "Post" AS PERMISSIVE FOR SELECT`), sql);
  ok(sql.includes("USING ("), sql);
  ok(!sql.includes("WITH CHECK"), "read policy must not carry WITH CHECK");
  ok(sql.includes("NULLIF(current_setting('app.user_id', true), '')::integer"), sql);
  ok(sql.includes(`"ownerId"`), sql);
});

check("renderPolicy: create -> FOR INSERT WITH CHECK only, no USING (Postgres forbids USING on INSERT)", () => {
  const t = table();
  const rule = { action: "create", left: claim, right: field("ownerId") };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes("FOR INSERT"), sql);
  ok(sql.includes("WITH CHECK ("), sql);
  ok(!sql.includes("USING ("), "insert policy must never carry USING");
});

check("renderPolicy: update -> FOR UPDATE USING (...) WITH CHECK (...) from the same condition", () => {
  const t = table();
  const rule = { action: "update", left: claim, right: field("ownerId") };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes("FOR UPDATE"), sql);
  ok(sql.includes("USING ("), sql);
  ok(sql.includes("WITH CHECK ("), sql);
});

check("renderPolicy: delete -> FOR DELETE USING only", () => {
  const t = table();
  const rule = { action: "delete", left: claim, right: field("ownerId") };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes("FOR DELETE"), sql);
  ok(sql.includes("USING ("), sql);
  ok(!sql.includes("WITH CHECK"), sql);
});

check("renderPolicy: field==field carries no cast on either side", () => {
  const t = table();
  const rule = { action: "read", left: field("ownerId"), right: field("ownerId") };
  const sql = renderPolicy(t, rule, 0);
  ok(!sql.includes("::"), sql);
});

check("renderPolicy: field==string literal (e.g. this.status == \"published\") casts the literal to the field's SQL type", () => {
  const t = table();
  const rule = { action: "read", left: field("status"), right: { kind: "string", value: "published" } };
  const sql = renderPolicy(t, rule, 0);
  // status is String -> text, so no cast text is emitted (text is the native type).
  ok(sql.includes(`'published'`), sql);
});

check("renderPolicy: operand order in SQL follows declaration order (compiler never normalizes sides)", () => {
  const t = table();
  const rule = { action: "read", left: field("ownerId"), right: claim };
  const sql = renderPolicy(t, rule, 0);
  const fieldIdx = sql.indexOf(`"ownerId"`);
  const claimIdx = sql.indexOf("current_setting");
  ok(fieldIdx < claimIdx, "expected field (left) to render before the claim (right)");
});

// ─── SQL injection via schema-authored identifiers/literals (threat matrix) ─

check("renderPolicy: quote-bearing @map column name is safely quoted via quoteIdent, never interpolated raw", () => {
  const t = table({
    columns: [
      col({ name: "id", dbName: "id", type: "Int", isPk: true }),
      col({ name: "ownerId", dbName: `owner"; DROP TABLE "Post`, type: "Int" }),
    ],
  });
  const rule = { action: "read", left: claim, right: field(`owner"; DROP TABLE "Post`) };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes(`"owner""; DROP TABLE ""Post"`), sql);
});

check("renderPolicy: quote-bearing string literal is safely escaped via escapeLiteral, never interpolated raw", () => {
  const t = table();
  const rule = {
    action: "read",
    left: field("status"),
    right: { kind: "string", value: "x'; DROP TABLE \"Post\"; --" },
  };
  const sql = renderPolicy(t, rule, 0);
  ok(sql.includes(`'x''; DROP TABLE "Post"; --'`), sql);
});

// ─── renderRlsBlock (design decision 13) ───────────────────────────────────

check("renderRlsBlock: ENABLE + FORCE ROW LEVEL SECURITY, prune, DROP+CREATE POLICY per rule", () => {
  const t = table({
    allow: [
      { action: "read", left: claim, right: field("ownerId") },
      { action: "create", left: claim, right: field("ownerId") },
    ],
  });
  const stmts = renderRlsBlock(t);
  ok(stmts.some((s) => s.includes(`ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes(`ALTER TABLE "Post" FORCE ROW LEVEL SECURITY`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes("indigo_p_Post_%")), "expected a prune loop scoped to this table's policy prefix");
  ok(stmts.some((s) => s.includes(`DROP POLICY IF EXISTS "indigo_p_Post_read_0"`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes(`CREATE POLICY "indigo_p_Post_read_0"`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes(`DROP POLICY IF EXISTS "indigo_p_Post_create_0"`)), stmts.join("\n"));
});

check("renderRlsBlock: untouched table (no `allow`) gets no RLS DDL", () => {
  const t = table();
  deepStrictEqual(renderRlsBlock(t), []);
});

check("renderRlsBlock: zero-rule table (`allow: []`) renders via renderDisableRls (prune + DISABLE/NO FORCE)", () => {
  const t = table({ allow: [] });
  const stmts = renderRlsBlock(t);
  deepStrictEqual(stmts, renderDisableRls(t));
});

check("renderDisableRls: prune + DISABLE + NO FORCE", () => {
  const t = table();
  const stmts = renderDisableRls(t);
  ok(stmts.some((s) => s.includes(`ALTER TABLE "Post" DISABLE ROW LEVEL SECURITY`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes(`ALTER TABLE "Post" NO FORCE ROW LEVEL SECURITY`)), stmts.join("\n"));
  ok(stmts.some((s) => s.includes("indigo_p_Post_%")), "expected a prune loop scoped to this table's policy prefix");
});

check("renderDisableRls: prune uses `<> ALL(ARRAY[...])`, never `NOT IN (NULL)` — an empty keep-list must still match (and prune) every row, not silently match none", () => {
  const t = table();
  const stmts = renderDisableRls(t);
  const pruneStmt = stmts.find((s) => s.includes("pg_policies"));
  ok(pruneStmt.includes("<> ALL(ARRAY[]::text[])"), pruneStmt);
  ok(!pruneStmt.includes("NOT IN (NULL)"), "NOT IN (NULL) is always unknown/false — it would prune nothing");
});

check("renderRlsBlock/renderDisableRls: prune's dynamic DROP quotes the table identifier via %I, never interpolates it unquoted (unquoted would case-fold a PascalCase table name and silently no-op)", () => {
  const t = table();
  const stmts = renderDisableRls(t);
  const pruneStmt = stmts.find((s) => s.includes("pg_policies"));
  ok(pruneStmt.includes("format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, 'Post')"), pruneStmt);
});

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all rls DDL cases passed.");
}
