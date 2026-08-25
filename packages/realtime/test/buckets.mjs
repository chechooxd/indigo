/**
 * Real-Postgres suite for `_indigo_realtime_log`'s bucket auth
 * (`realtime-shape-log` PR B, tasks.md B4.1, B5.1-B5.4). Companion to
 * `log.mjs` (persistence/ordering/durability) — this file proves the RLS
 * mechanism (design decisions 6-11) actually enforces something at runtime,
 * not just that the emitted SQL text looks right (`realtime-ddl.mjs`
 * already covers that).
 *
 * Self-skips when `INDIGODB_TEST_DATABASE_URL` is unset (decision 14), same
 * pattern as `log.mjs`/`parity.mjs`/`resume.mjs`.
 *
 * `SET ROLE` (not a second LOGIN connection) is how every check here demotes
 * effective privilege away from the superuser the test harness connects as
 * — the exact same verified-live pattern `@indigodb/migrator`'s
 * `rls-enforcement.mjs` already uses against PGlite (its own doc comment:
 * "PGlite's DEFAULT role is a superuser and superusers bypass RLS even
 * under FORCE"; real Postgres has the identical rule, and it is the SAME
 * rule this file exercises against a real server). Superuser status is a
 * property of `current_user` specifically (it does not inherit through role
 * membership the way ordinary privileges do), so `SET ROLE` to a NOLOGIN,
 * non-superuser role genuinely removes the superuser bypass for the
 * remainder of the session, without a second TCP connection or a
 * REPLICATION-privileged custom role.
 */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { renderPushSql, renderRealtimeLogSql, REALTIME_LOG_TABLE, computeBuckets } from "@indigodb/migrator";
import { WalSource } from "../dist/index.js";
import { skipIfNoDatabase, withAdmin, withReplicationFixture } from "./pg-harness.mjs";

const url = skipIfNoDatabase("buckets.mjs");
if (!url) process.exit(0);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const claim = { kind: "claim", name: "userId" };
const field = (name) => ({ kind: "field", name });

/** Idempotently creates a NOLOGIN, non-superuser role and grants the
 * CURRENT session's role membership in it, so `SET ROLE <name>` is
 * permitted for the remainder of the admin session. */
async function ensureNonSuperuserRole(admin, roleName) {
  await admin.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
    CREATE ROLE "${roleName}" NOLOGIN;
  END IF;
END $$;`);
  await admin.query(`GRANT "${roleName}" TO CURRENT_USER;`);
}

async function dropRole(admin, roleName) {
  await admin.query(`DROP ROLE IF EXISTS "${roleName}";`).catch(() => {});
}

console.log("realtime buckets: RLS runtime enforcement + bucket-auth wiring (real Postgres)");

// ── B4.1 — threat: privilege escalation via the log (append-only) ─────────

await check(
  "B4.1 (real PG, threat: privilege escalation): a non-superuser, non-owner role's UPDATE/DELETE against _indigo_realtime_log affects 0 rows (no UPDATE/DELETE policy exists under FORCE RLS)",
  async () => {
    await withAdmin(url, async (admin) => {
      for (const stmt of renderRealtimeLogSql({ tables: [{ realtime: true }] })) {
        await admin.query(stmt);
      }
      const roleName = "wal_b41_role";
      await ensureNonSuperuserRole(admin, roleName);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${REALTIME_LOG_TABLE}" TO "${roleName}";`);
      // Seed at least one row (as the superuser, bypassing RLS) so an
      // unrestricted UPDATE/DELETE would have something to affect.
      await admin.query(
        `INSERT INTO "${REALTIME_LOG_TABLE}" (lsn, txid, table_name, op, pk, ts, buckets) ` +
          `VALUES ('0/1', '1', 'b41_probe', 'INSERT', '{}'::jsonb, now(), NULL)`,
      );
      try {
        await admin.query(`SET ROLE "${roleName}";`);
        const upd = await admin.query(`UPDATE "${REALTIME_LOG_TABLE}" SET op = 'UPDATE' WHERE table_name = 'b41_probe'`);
        strictEqual(upd.rowCount, 0, "expected 0 rows updated — no UPDATE policy exists");
        const del = await admin.query(`DELETE FROM "${REALTIME_LOG_TABLE}" WHERE table_name = 'b41_probe'`);
        strictEqual(del.rowCount, 0, "expected 0 rows deleted — no DELETE policy exists");
      } finally {
        await admin.query(`RESET ROLE;`);
      }
      await admin.query(`DELETE FROM "${REALTIME_LOG_TABLE}" WHERE table_name = 'b41_probe'`);
      await dropRole(admin, roleName);
    });
  },
);

// ── B5.1 — decision 6's RED test: FORCE RLS + the INSERT policy ───────────

await check(
  "B5.1 (real PG): the log OWNER's own INSERT succeeds under FORCE RLS via the FOR INSERT WITH CHECK(true) policy — and is REJECTED with that policy removed, proving FORCE RLS genuinely blocks the writer without it (decision 6)",
  async () => {
    await withAdmin(url, async (admin) => {
      for (const stmt of renderRealtimeLogSql({ tables: [{ realtime: true }] })) {
        await admin.query(stmt);
      }
      const roleName = "wal_b51_owner";
      await ensureNonSuperuserRole(admin, roleName);

      const ownerRow = await admin.query(
        `SELECT tableowner FROM pg_tables WHERE tablename = $1`,
        [REALTIME_LOG_TABLE],
      );
      const originalOwner = ownerRow.rows[0]?.tableowner;
      ok(originalOwner, "expected the log table to already exist with a known owner");

      const insertPolicy = "indigo_p__indigo_realtime_log_create_0";
      const insertRow = () =>
        admin.query(
          `INSERT INTO "${REALTIME_LOG_TABLE}" (lsn, txid, table_name, op, pk, ts, buckets) ` +
            `VALUES ('0/1', '1', 'b51_probe', 'INSERT', '{}'::jsonb, now(), NULL)`,
        );

      try {
        // FORCE RLS applies to the owner too — non-owner, non-superuser is
        // ALREADY subject to RLS regardless of FORCE, so this specific
        // property (the OWNER being blocked) requires the role under test
        // to genuinely own the table.
        await admin.query(`ALTER TABLE "${REALTIME_LOG_TABLE}" OWNER TO "${roleName}";`);

        // RED half: drop the INSERT policy — the owner's own INSERT must
        // now be rejected by FORCE RLS (this is the exact bug decision 6
        // warns "would have caught").
        await admin.query(`DROP POLICY IF EXISTS "${insertPolicy}" ON "${REALTIME_LOG_TABLE}";`);
        await admin.query(`SET ROLE "${roleName}";`);
        let rejected = false;
        try {
          await insertRow();
        } catch (err) {
          rejected = true;
          ok(/row-level security/i.test(err.message), `expected an RLS violation, got: ${err.message}`);
        } finally {
          await admin.query(`RESET ROLE;`);
        }
        ok(rejected, "expected the owner's INSERT to be rejected once the INSERT policy is removed");

        // GREEN half: restore the policy (mirrors renderRealtimeLogRls's
        // exact statement) — the owner's own INSERT must now succeed.
        await admin.query(
          `CREATE POLICY "${insertPolicy}" ON "${REALTIME_LOG_TABLE}"\n` +
            `  AS PERMISSIVE FOR INSERT WITH CHECK (true);`,
        );
        await admin.query(`SET ROLE "${roleName}";`);
        try {
          const res = await insertRow();
          strictEqual(res.rowCount, 1, "expected the owner's INSERT to succeed once the INSERT policy is restored");
        } finally {
          await admin.query(`RESET ROLE;`);
        }
      } finally {
        if (originalOwner) {
          await admin.query(`ALTER TABLE "${REALTIME_LOG_TABLE}" OWNER TO "${originalOwner}";`);
        }
        await admin.query(`DELETE FROM "${REALTIME_LOG_TABLE}" WHERE table_name = 'b51_probe'`);
        await dropRole(admin, roleName);
      }
    });
  },
);

// ── B5.2 — SET app.user_id row isolation ───────────────────────────────────

await check(
  "B5.2 (real PG): SET app.user_id isolation — a caller sees rows with buckets=NULL (public) and rows whose buckets contain their own claim, and is excluded from rows scoped to a different claim",
  async () => {
    await withAdmin(url, async (admin) => {
      for (const stmt of renderRealtimeLogSql({ tables: [{ realtime: true }] })) {
        await admin.query(stmt);
      }
      const roleName = "wal_b52_role";
      await ensureNonSuperuserRole(admin, roleName);
      await admin.query(`GRANT SELECT, INSERT ON "${REALTIME_LOG_TABLE}" TO "${roleName}";`);

      const rows = [
        ["b52_public", null],
        ["b52_u1", ["u1"]],
        ["b52_u2", ["u2"]],
        ["b52_both", ["u1", "u2"]],
      ];
      for (const [tableName, buckets] of rows) {
        await admin.query(
          `INSERT INTO "${REALTIME_LOG_TABLE}" (lsn, txid, table_name, op, pk, ts, buckets) ` +
            `VALUES ('0/1', '1', $1, 'INSERT', '{}'::jsonb, now(), $2::text[])`,
          [tableName, buckets],
        );
      }

      try {
        await admin.query(`SET ROLE "${roleName}";`);
        await admin.query(`SELECT set_config('app.user_id', 'u1', false);`);
        const seenByU1 = await admin.query(
          `SELECT table_name FROM "${REALTIME_LOG_TABLE}" WHERE table_name = ANY($1)`,
          [rows.map(([t]) => t)],
        );
        deepStrictEqual(
          seenByU1.rows.map((r) => r.table_name).sort(),
          ["b52_both", "b52_public", "b52_u1"],
          "u1 must see the public row, its own-bucket row, and the shared row — not u2's row",
        );

        await admin.query(`SELECT set_config('app.user_id', 'u2', false);`);
        const seenByU2 = await admin.query(
          `SELECT table_name FROM "${REALTIME_LOG_TABLE}" WHERE table_name = ANY($1)`,
          [rows.map(([t]) => t)],
        );
        deepStrictEqual(
          seenByU2.rows.map((r) => r.table_name).sort(),
          ["b52_both", "b52_public", "b52_u2"],
        );

        await admin.query(`SELECT set_config('app.user_id', 'someone-else', false);`);
        const seenByOther = await admin.query(
          `SELECT table_name FROM "${REALTIME_LOG_TABLE}" WHERE table_name = ANY($1)`,
          [rows.map(([t]) => t)],
        );
        deepStrictEqual(
          seenByOther.rows.map((r) => r.table_name).sort(),
          ["b52_public"],
          "a claim matching nothing must still see only the public (buckets=NULL) row",
        );
      } finally {
        await admin.query(`RESET ROLE;`);
      }
      await admin.query(`DELETE FROM "${REALTIME_LOG_TABLE}" WHERE table_name = ANY($1)`, [rows.map(([t]) => t)]);
      await dropRole(admin, roleName);
    });
  },
);

// ── B5.3 — driven from a hand-built ResolvedSchema (B1.3's flagged
// constraint), through a real WalSource against real logical replication ──

await check(
  "B5.3 (real PG, hand-built ResolvedSchema per B1.3): a row committed on a table with a read AllowRule logs with a non-NULL buckets, and RLS correctly restricts read to the matching claim",
  async () => {
    await withReplicationFixture(url, "buckets_claim", async ({ table, slot }) => {
      // Hand-built ResolvedSchema — NOT compiled from `.indigo` source
      // (B1.3): `@@realtime` + `@@allow` on the same model is unreachable
      // through a real compiled schema until slice 4 lifts the compiler
      // guard. `name` (an existing fixture column) stands in for an
      // owner-claim field.
      const schema = {
        tables: [
          {
            name: table,
            dbName: table,
            realtime: true,
            columns: [
              { name: "id", dbName: "id" },
              { name: "name", dbName: "name" },
              { name: "big", dbName: "big" },
            ],
            primaryKey: ["id"],
            allow: [{ action: "read", left: field("name"), right: claim }],
          },
        ],
      };

      const events = [];
      const source = new WalSource(url, schema, { slot });
      await source.start(
        (e) => events.push(e),
        (e) => console.error("onError", e.message),
      );
      await sleep(300);

      await withAdmin(url, async (admin) => {
        await admin.query(`INSERT INTO "${table}" (name) VALUES ('claim-u1')`);
      });
      await sleep(800);
      await source.stop();

      strictEqual(events.length, 1);

      const roleName = "wal_b53_role";
      await withAdmin(url, async (admin) => {
        const logRows = await admin.query(
          `SELECT buckets FROM "${REALTIME_LOG_TABLE}" WHERE table_name = $1`,
          [table],
        );
        strictEqual(logRows.rows.length, 1);
        deepStrictEqual(logRows.rows[0].buckets, ["claim-u1"]);

        await ensureNonSuperuserRole(admin, roleName);
        await admin.query(`GRANT SELECT ON "${REALTIME_LOG_TABLE}" TO "${roleName}";`);
        try {
          await admin.query(`SET ROLE "${roleName}";`);
          await admin.query(`SELECT set_config('app.user_id', 'claim-u1', false);`);
          const own = await admin.query(`SELECT 1 FROM "${REALTIME_LOG_TABLE}" WHERE table_name = $1`, [table]);
          strictEqual(own.rowCount, 1, "the matching claim must see the row");

          await admin.query(`SELECT set_config('app.user_id', 'someone-else', false);`);
          const other = await admin.query(`SELECT 1 FROM "${REALTIME_LOG_TABLE}" WHERE table_name = $1`, [table]);
          strictEqual(other.rowCount, 0, "a non-matching claim must not see the row");
        } finally {
          await admin.query(`RESET ROLE;`);
        }
        await dropRole(admin, roleName);
      });
    });
  },
);

// ── B5.4 — textual bucket matching vs the real table's SQL-type cast ──────

await check(
  "B5.4 (real PG, design risk 8): textual bucket matching stays consistent with slice 1's SQL-type casting for Int-, String- and uuid-keyed models — canonical claim values match on BOTH the real table's cast comparison and the log's textual match",
  async () => {
    await withAdmin(url, async (admin) => {
      const schemaSource = `
Table B54Int {
  id      Int    @id @default(autoincrement())
  ownerId Int
  @@allow(read, auth.userId == this.ownerId)
}
Table B54Str {
  id      Int    @id @default(autoincrement())
  ownerId String
  @@allow(read, auth.userId == this.ownerId)
}
Table B54Uuid {
  id      Int    @id @default(autoincrement())
  ownerId String @db.Uuid
  @@allow(read, auth.userId == this.ownerId)
}
`;
      const schema = resolve(parse(schemaSource));
      await admin.query(`DROP TABLE IF EXISTS "B54Int", "B54Str", "B54Uuid" CASCADE;`);
      await admin.query(renderPushSql(schema));

      const roleName = "wal_b54_role";
      await ensureNonSuperuserRole(admin, roleName);
      await admin.query(`GRANT SELECT, INSERT ON "B54Int", "B54Str", "B54Uuid" TO "${roleName}";`);

      const uuidVal = "11111111-1111-1111-1111-111111111111";
      await admin.query(`INSERT INTO "B54Int" ("ownerId") VALUES (7);`);
      await admin.query(`INSERT INTO "B54Str" ("ownerId") VALUES ('u1');`);
      await admin.query(`INSERT INTO "B54Uuid" ("ownerId") VALUES ($1);`, [uuidVal]);

      try {
        await admin.query(`SET ROLE "${roleName}";`);

        await admin.query(`SELECT set_config('app.user_id', '7', false);`);
        const intRows = await admin.query(`SELECT 1 FROM "B54Int"`);
        strictEqual(intRows.rowCount, 1, "canonical decimal string claim must match an Int ownerId via the real table's cast");

        await admin.query(`SELECT set_config('app.user_id', 'u1', false);`);
        const strRows = await admin.query(`SELECT 1 FROM "B54Str"`);
        strictEqual(strRows.rowCount, 1);

        await admin.query(`SELECT set_config('app.user_id', $1, false);`, [uuidVal]);
        const uuidRows = await admin.query(`SELECT 1 FROM "B54Uuid"`);
        strictEqual(uuidRows.rowCount, 1, "canonical uuid string claim must match a uuid ownerId via the real table's cast");
      } finally {
        await admin.query(`RESET ROLE;`);
      }

      // The log side never runs its own cast — it matches TEXTUALLY. The
      // consistency property this test asserts (design risk 8, documented
      // rather than "fixed") is that `computeBuckets` emits the SAME
      // canonical string for these rows that the real table's cast above
      // just accepted, so `'<claim>' = ANY(buckets)` in the log agrees with
      // the real table's `<claim>::<type> = ownerId` for canonical values.
      const intTable = schema.tables.find((t) => t.name === "B54Int");
      const strTable = schema.tables.find((t) => t.name === "B54Str");
      const uuidTable = schema.tables.find((t) => t.name === "B54Uuid");
      deepStrictEqual(computeBuckets(intTable, { ownerId: 7 }), ["7"]);
      deepStrictEqual(computeBuckets(strTable, { ownerId: "u1" }), ["u1"]);
      deepStrictEqual(computeBuckets(uuidTable, { ownerId: uuidVal }), [uuidVal]);

      await admin.query(`DROP TABLE IF EXISTS "B54Int", "B54Str", "B54Uuid" CASCADE;`);
      await dropRole(admin, roleName);
    });
  },
);

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
