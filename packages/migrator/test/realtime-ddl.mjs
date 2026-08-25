/**
 * @indigodb/migrator — realtime replication DDL unit suite (`realtime-wal-source` PR B).
 *
 * Direct unit coverage for the new renderers exported from `postgres.ts`:
 * `resolveSlotName`, `renderReplicationPreSql`, `renderPublicationSql`,
 * `renderReplicaIdentity`, `renderDropLegacyNotify`. Plain Node, no test
 * framework — mirrors the rest of this package's suites.
 */

import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import {
  resolveSlotName,
  renderReplicationPreSql,
  renderPublicationSql,
  renderReplicaIdentity,
  renderDropLegacyNotify,
  renderRealtimeLogSql,
  REALTIME_LOG_TABLE,
  renderPushSql,
  planMigration,
  quoteIdent,
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

console.log("migrator realtime-ddl: unit suite");

// ─── resolveSlotName ─────────────────────────────────────────────────────────

check("resolveSlotName: default when unset", () => {
  strictEqual(resolveSlotName({}), "indigo_realtime");
});

check("resolveSlotName: override honoured", () => {
  strictEqual(resolveSlotName({ INDIGODB_REALTIME_SLOT: "tenant_a_realtime" }), "tenant_a_realtime");
});

check("resolveSlotName: rejects invalid characters (uppercase/hyphen)", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "Bad-Name" }), /Invalid INDIGODB_REALTIME_SLOT/);
});

check("resolveSlotName: threat — identifier injection via env var rejected before any SQL is built", () => {
  throws(
    () => resolveSlotName({ INDIGODB_REALTIME_SLOT: 'x"; DROP TABLE "User' }),
    /Invalid INDIGODB_REALTIME_SLOT/,
  );
});

check("resolveSlotName: rejects a 64-char name (limit is 63)", () => {
  throws(() => resolveSlotName({ INDIGODB_REALTIME_SLOT: "a".repeat(64) }), /Invalid INDIGODB_REALTIME_SLOT/);
});

check("resolveSlotName: accepts a 63-char name (boundary)", () => {
  strictEqual(resolveSlotName({ INDIGODB_REALTIME_SLOT: "a".repeat(63) }), "a".repeat(63));
});

// ─── Fixture schema helper ────────────────────────────────────────────────────

function schemaOf(source) {
  return resolve(parse(source));
}

const noRealtime = schemaOf(`Table Post {\n  id Int @id @default(autoincrement())\n}\n`);
const oneRealtime = schemaOf(
  `Table Post {\n  id Int @id @default(autoincrement())\n\n  @@realtime\n}\n`,
);

// ─── renderReplicationPreSql ──────────────────────────────────────────────────

check("renderReplicationPreSql: guarded SELECT slot creation when >=1 realtime model exists", () => {
  const [stmt] = renderReplicationPreSql(oneRealtime);
  strictEqual(stmt.includes("pg_create_logical_replication_slot('indigo_realtime', 'pgoutput')"), true);
  strictEqual(stmt.includes("WHERE NOT EXISTS"), true);
});

check("renderReplicationPreSql: guarded SELECT slot drop when no realtime model exists, no `AND NOT active` guard (fails loudly on an active slot)", () => {
  const [stmt] = renderReplicationPreSql(noRealtime);
  strictEqual(stmt.includes("pg_drop_replication_slot('indigo_realtime')"), true);
  strictEqual(stmt.includes("WHERE EXISTS"), true);
  strictEqual(stmt.includes("AND NOT active"), false);
});

// ─── renderPublicationSql ─────────────────────────────────────────────────────

check("renderPublicationSql: DO-guarded CREATE + declarative SET TABLE for every realtime table", () => {
  const stmts = renderPublicationSql(oneRealtime);
  strictEqual(stmts.some((s) => s.includes("CREATE PUBLICATION") && s.includes("duplicate_object")), true);
  strictEqual(stmts.some((s) => s === `ALTER PUBLICATION ${quoteIdent("indigo_realtime")} SET TABLE ${quoteIdent("Post")};`), true);
});

check("renderPublicationSql: DROP PUBLICATION IF EXISTS when the realtime set is empty — never an empty SET TABLE", () => {
  const stmts = renderPublicationSql(noRealtime);
  deepStrictEqual(stmts, [`DROP PUBLICATION IF EXISTS ${quoteIdent("indigo_realtime")};`]);
  strictEqual(
    stmts.some((s) => s.includes("SET TABLE")),
    false,
  );
});

check("renderPublicationSql: threat — a quote-bearing @map table name renders safely through quoteIdent, never interpolated raw", () => {
  const schema = schemaOf(
    `Table Post {\n  id Int @id @default(autoincrement())\n\n  @@realtime\n  @@map("weird\\"table")\n}\n`,
  );
  const stmts = renderPublicationSql(schema);
  const setTable = stmts.find((s) => s.includes("SET TABLE"));
  strictEqual(setTable.includes(quoteIdent('weird"table')), true);
});

// ─── renderReplicaIdentity ─────────────────────────────────────────────────────

check("renderReplicaIdentity: FULL for a realtime table", () => {
  const table = oneRealtime.tables[0];
  strictEqual(renderReplicaIdentity(table), `ALTER TABLE ${quoteIdent("Post")} REPLICA IDENTITY FULL;`);
});

check("renderReplicaIdentity: DEFAULT restored for a non-realtime table", () => {
  const table = noRealtime.tables[0];
  strictEqual(renderReplicaIdentity(table), `ALTER TABLE ${quoteIdent("Post")} REPLICA IDENTITY DEFAULT;`);
});

// ─── renderDropLegacyNotify ─────────────────────────────────────────────────────

check("renderDropLegacyNotify: DROP FUNCTION IF EXISTS ... CASCADE (also drops any dependent legacy trigger)", () => {
  strictEqual(renderDropLegacyNotify(), "DROP FUNCTION IF EXISTS indigo_notify_trigger() CASCADE;");
});

// ─── renderRealtimeLogSql (realtime-shape-log PR A: table + indexes only) ────

check("renderRealtimeLogSql: no realtime tables -> DROP TABLE IF EXISTS", () => {
  const stmts = renderRealtimeLogSql(noRealtime);
  deepStrictEqual(stmts, [`DROP TABLE IF EXISTS ${quoteIdent(REALTIME_LOG_TABLE)};`]);
});

check("renderRealtimeLogSql: >=1 realtime table -> idempotent CREATE TABLE with every column", () => {
  const [createStmt] = renderRealtimeLogSql(oneRealtime);
  strictEqual(createStmt.includes(`CREATE TABLE IF NOT EXISTS ${quoteIdent(REALTIME_LOG_TABLE)}`), true);
  for (const fragment of [
    "id         bigserial PRIMARY KEY",
    "lsn        pg_lsn      NOT NULL",
    "txid       text",
    "table_name text        NOT NULL",
    "op         text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE'))",
    "pk         jsonb       NOT NULL",
    '"new"      jsonb',
    '"old"      jsonb',
    "ts         timestamptz NOT NULL",
    "buckets    text[]",
  ]) {
    strictEqual(createStmt.includes(fragment), true, `missing fragment: ${fragment}`);
  }
});

check("renderRealtimeLogSql: 3 indexes — (lsn,id), (table_name,lsn,id), gin(buckets)", () => {
  const stmts = renderRealtimeLogSql(oneRealtime);
  strictEqual(stmts.length, 4, "create + 3 indexes");
  strictEqual(
    stmts.some((s) => s === `CREATE INDEX IF NOT EXISTS ${quoteIdent("_indigo_realtime_log_lsn_idx")} ON ${quoteIdent(REALTIME_LOG_TABLE)} (lsn, id);`),
    true,
  );
  strictEqual(
    stmts.some((s) => s === `CREATE INDEX IF NOT EXISTS ${quoteIdent("_indigo_realtime_log_table_idx")} ON ${quoteIdent(REALTIME_LOG_TABLE)} (table_name, lsn, id);`),
    true,
  );
  strictEqual(
    stmts.some((s) => s === `CREATE INDEX IF NOT EXISTS ${quoteIdent("_indigo_realtime_log_buckets_idx")} ON ${quoteIdent(REALTIME_LOG_TABLE)} USING gin (buckets);`),
    true,
  );
});

check("renderRealtimeLogSql: wired into renderPushSql block 5 — the log table DDL appears in the full push script", () => {
  const sql = renderPushSql(oneRealtime);
  strictEqual(sql.includes(`CREATE TABLE IF NOT EXISTS ${quoteIdent(REALTIME_LOG_TABLE)}`), true);
});

check("renderRealtimeLogSql: no realtime model -> DROP TABLE also appears in the full push script", () => {
  const sql = renderPushSql(noRealtime);
  strictEqual(sql.includes(`DROP TABLE IF EXISTS ${quoteIdent(REALTIME_LOG_TABLE)};`), true);
});

// ─── planMigration wiring: create/drop the log table on the 0<->1+ boundary ──
// (design decision 4/13; task A3.1/A3.2)

const twoRealtime = schemaOf(
  `Table Post {\n  id Int @id @default(autoincrement())\n\n  @@realtime\n}\n` +
    `Table Comment {\n  id Int @id @default(autoincrement())\n\n  @@realtime\n}\n`,
);

check("planMigration: adding the first @@realtime model includes the log table CREATE (safe)", () => {
  const plan = planMigration(noRealtime, oneRealtime);
  const createStmt = plan.statements.find(
    (s) => s.sql.includes(`CREATE TABLE IF NOT EXISTS ${quoteIdent(REALTIME_LOG_TABLE)}`),
  );
  strictEqual(!!createStmt, true, "expected a log table CREATE statement");
  strictEqual(createStmt.risk, "safe");
});

check("planMigration: removing the last @@realtime model includes a forced() log table DROP with an explicit impact", () => {
  const plan = planMigration(oneRealtime, noRealtime);
  const dropStmt = plan.statements.find(
    (s) => s.sql === `DROP TABLE IF EXISTS ${quoteIdent(REALTIME_LOG_TABLE)};`,
  );
  strictEqual(!!dropStmt, true, "expected a log table DROP statement");
  strictEqual(dropStmt.risk, "requires-force");
  strictEqual(typeof dropStmt.impact, "string");
  strictEqual(dropStmt.impact.length > 0, true);
});

check("planMigration: a second @@realtime table added while the log already exists -> no log DDL churn", () => {
  const plan = planMigration(oneRealtime, twoRealtime);
  const logStmts = plan.statements.filter((s) => s.sql.includes(REALTIME_LOG_TABLE));
  deepStrictEqual(logStmts, []);
});

if (failures > 0) {
  console.error(`\nmigrator realtime-ddl: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator realtime-ddl: all green");
