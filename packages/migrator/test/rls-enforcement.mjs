/**
 * @indigodb/migrator — Row-Level Security ENFORCEMENT suite (design.md
 * decisions 13/15/16/17, tasks.md C5.1/C5.2, Threat Matrix "Privilege
 * bypass (authorization)").
 *
 * Everything in `rls.mjs`/`migrator.mjs`'s golden suites proves the emitted
 * SQL TEXT is correct; NONE of it proves the SQL actually ENFORCES
 * anything at runtime. This file closes that gap: it applies real
 * `renderPushSql` DDL against PGlite, `SET ROLE`s to a purpose-created
 * `NOLOGIN` non-superuser (`pg-harness.mjs`'s `setUpAppRole` — C0.1's
 * confirmed-supported spike result; PGlite's DEFAULT role is a superuser
 * and superusers bypass RLS even under `FORCE`, so testing as-is would
 * assert nothing), then drives real `@indigodb/client` `$auth` calls
 * through that restricted role and asserts on the ROWS actually returned.
 *
 * `@indigodb/client` is a devDependency-only edge (not a runtime
 * dependency of `@indigodb/migrator`) — it exists solely so this
 * integration-level proof can exercise the real `$auth` API against real
 * RLS DDL in one place, rather than re-deriving `set_config` by hand here
 * (which would prove nothing about the shipped `$auth` implementation).
 */

import { deepStrictEqual, ok } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { IndigoClientBase } from "@indigodb/client";
import { createPGliteAdapter } from "@indigodb/client";
import { renderPushSql } from "../dist/index.js";
import { withDatabase, setUpAppRole } from "./pg-harness.mjs";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Exposes the protected `$authSession` (see `client.ts`'s doc comment on
 * why it is not literally named `$auth`) for direct use in this suite. */
class TestClient extends IndigoClientBase {
  auth(ctx, fn) {
    return this.$authSession(ctx, fn);
  }
}

const SCHEMA_SOURCE = `
// Multi-rule OR fixture: TWO permissive "read" rules (owner-claim, and a
// non-auth-dependent isPublic escape) — exercises PERMISSIVE OR semantics
// (design decision #12/#13).
Table Post {
  id       Int     @id @default(autoincrement())
  ownerId  Int
  isPublic Boolean @default(false)
  title    String
  @@allow(read, auth.userId == this.ownerId)
  @@allow(read, this.isPublic == true)
  @@allow(create, auth.userId == this.ownerId)
}

// Single-rule, claim-ONLY fixture — no isPublic escape at all. Isolates
// "deny-by-default" and "no identity leak" from the multi-rule OR fixture
// above: those two properties are about the CLAIM-based rule alone, and a
// non-auth-dependent OR'd rule (like Post's isPublic) would make a row
// visible regardless of $auth for reasons that have nothing to do with
// either property.
Table PrivateNote {
  id      Int    @id @default(autoincrement())
  ownerId Int
  title   String
  @@allow(read, auth.userId == this.ownerId)
}
`;

const schema = resolve(parse(SCHEMA_SOURCE));
const pushSql = renderPushSql(schema);

/**
 * Boots a fresh PGlite database, applies the real RLS-bearing push SQL as
 * the (superuser) owner, seeds rows AS THE OWNER (so seeding itself is
 * never subject to the `create` policy under test), then `SET ROLE`s to
 * the restricted app role for the remainder of the callback — mirroring a
 * real deployment, where the application's own DB connection is never the
 * Postgres superuser.
 */
async function withSeededDatabase(fn) {
  await withDatabase(async (db) => {
    await db.exec(pushSql);
    // "Post" (multi-rule OR fixture) — row 1 belongs to user 1 (private),
    // row 2 belongs to user 2 (private), row 3 belongs to user 2 but public.
    await db.exec(`
      INSERT INTO "Post" ("ownerId", "isPublic", title) VALUES
        (1, false, 'user1-private'),
        (2, false, 'user2-private'),
        (2, true,  'user2-public');
    `);
    // "PrivateNote" (claim-only fixture, no isPublic escape) — one row per
    // user 1 and user 2.
    await db.exec(`
      INSERT INTO "PrivateNote" ("ownerId", title) VALUES
        (1, 'note-user1'),
        (2, 'note-user2');
    `);
    await setUpAppRole(db);
    const { exec, transaction } = createPGliteAdapter(db);
    const client = new TestClient({ db: { exec, transaction } });
    await fn(client);
  });
}

console.log("rls-enforcement: RLS runtime enforcement (real PGlite, SET ROLE to a NOLOGIN non-superuser)");

// ─── Owner sees own row (plus whatever the OTHER permissive rule admits) ──
//
// The fixture schema declares TWO permissive `read` rules — `auth.userId ==
// this.ownerId` AND `this.isPublic == true` — and PERMISSIVE policies OR
// together (Postgres default, design decision #12/#13). Every expectation
// below accounts for BOTH rules, not just the owner-claim one, or the
// assertion would be testing the wrong thing.

await check(
  "$auth({userId: 1}) sees user 1's own private row AND the other owner's PUBLIC row (owner-claim rule OR isPublic rule)",
  async () => {
    await withSeededDatabase(async (client) => {
      const rows = await client.auth({ userId: 1 }, (exec) =>
        exec('SELECT title FROM "Post" ORDER BY title', []),
      );
      deepStrictEqual(rows.map((r) => r.title).sort(), ["user1-private", "user2-public"]);
    });
  },
);

// ─── Multi-rule OR: owner sees own + public rows from others ───────────────

await check(
  "$auth({userId: 2}) sees user 2's own private row AND (via the second permissive read rule) sees no additional rows beyond its own — two permissive rules on the same action OR together",
  async () => {
    await withSeededDatabase(async (client) => {
      const rows = await client.auth({ userId: 2 }, (exec) =>
        exec('SELECT title FROM "Post" ORDER BY title', []),
      );
      // user 2 owns "user2-private" AND "user2-public"; the isPublic rule
      // additionally admits "user2-public" (already visible via ownership)
      // — the OR is only observable when a THIRD user's public row exists.
      deepStrictEqual(rows.map((r) => r.title).sort(), ["user2-private", "user2-public"]);
    });
  },
);

await check(
  "multi-rule OR is genuinely additive: a user who owns NOTHING still sees another owner's PUBLIC row via the isPublic permissive rule",
  async () => {
    await withSeededDatabase(async (client) => {
      const rows = await client.auth({ userId: 999 }, (exec) =>
        exec('SELECT title FROM "Post" ORDER BY title', []),
      );
      deepStrictEqual(rows.map((r) => r.title).sort(), ["user2-public"]);
    });
  },
);

// ─── Cross-tenant denial ────────────────────────────────────────────────────
//
// Uses "PrivateNote" (claim-only fixture, no isPublic escape) so denial is
// unambiguous — "Post" has a second, non-auth-dependent permissive rule
// that would make an OR-admitted row a false negative for this property.

await check(
  "$auth({userId: 1}) does NOT see user 2's private note (cross-tenant denial)",
  async () => {
    await withSeededDatabase(async (client) => {
      const rows = await client.auth({ userId: 1 }, (exec) =>
        exec('SELECT title FROM "PrivateNote" WHERE title = $1', ["note-user2"]),
      );
      deepStrictEqual(rows, []);
    });
  },
);

// ─── Unset $auth: deny-by-default (threat matrix: privilege bypass) ────────

await check(
  "no $auth at all sees NO rows of a claim-only-gated table — deny-by-default, never an SQL error",
  async () => {
    await withSeededDatabase(async (client) => {
      // Deliberately bypasses $auth entirely — a raw query through the
      // client's own outer `exec`, exactly what an app author forgetting
      // to wrap a query in $auth would do.
      const rows = await client.exec('SELECT title FROM "PrivateNote"', []);
      deepStrictEqual(rows, [], "expected zero rows with no auth context set, never a partial/error result");
    });
  },
);

// ─── Pooled-connection identity non-leak (the property $auth is supposed to
// structurally guarantee — design decision #16) ────────────────────────────

await check(
  "identity does not leak across a recycled connection: a query made WITHOUT $auth, AFTER a prior $auth session already committed on the SAME connection, still sees NO rows",
  async () => {
    await withSeededDatabase(async (client) => {
      const authedRows = await client.auth({ userId: 1 }, (exec) =>
        exec('SELECT title FROM "PrivateNote"', []),
      );
      assert(authedRows.length === 1, "sanity: the $auth session itself must see its own row");

      // Same client, same underlying PGlite connection, but OUTSIDE $auth —
      // simulates a later, unrelated request reusing a pooled connection a
      // PRIOR request authenticated on. If `app.user_id` (or RLS itself)
      // leaked across that reuse, this would wrongly see user 1's row.
      const laterRows = await client.exec('SELECT title FROM "PrivateNote"', []);
      deepStrictEqual(laterRows, [], "expected no identity leak — a later unauthenticated query must see nothing");
    });
  },
);

// ─── INSERT (create action): WITH CHECK enforces ownership at write time ──

await check(
  "$auth({userId: 5})-authored INSERT with ownerId matching the caller succeeds (WITH CHECK admits it)",
  async () => {
    await withSeededDatabase(async (client) => {
      await client.auth({ userId: 5 }, (exec) =>
        exec('INSERT INTO "Post" ("ownerId", "isPublic", title) VALUES ($1, $2, $3)', [5, false, "user5-own"]),
      );
      const rows = await client.auth({ userId: 5 }, (exec) =>
        exec('SELECT title FROM "Post" WHERE title = $1', ["user5-own"]),
      );
      deepStrictEqual(rows.map((r) => r.title), ["user5-own"]);
    });
  },
);

await check(
  "$auth({userId: 5})-authored INSERT attempting to write ownerId belonging to a DIFFERENT user is rejected by WITH CHECK (privilege bypass denied at write time, not just read time)",
  async () => {
    await withSeededDatabase(async (client) => {
      let threw = false;
      try {
        await client.auth({ userId: 5 }, (exec) =>
          exec('INSERT INTO "Post" ("ownerId", "isPublic", title) VALUES ($1, $2, $3)', [
            6,
            false,
            "forged-ownership",
          ]),
        );
      } catch (err) {
        threw = true;
        // SQLSTATE 42501 (insufficient_privilege) is Postgres's classification
        // for a row-level security policy violation on INSERT — the client's
        // `IndigoDatabaseError` exposes it via `.sqlstate` (`errors.ts`); the
        // generic `.message` intentionally does not echo raw Postgres text
        // for unclassified codes (`client-database-errors` spec), so assert
        // on the structured field instead of message-sniffing.
        ok(err.sqlstate === "42501", `expected SQLSTATE 42501 (insufficient_privilege), got: ${err.sqlstate} / ${err.message}`);
      }
      assert(threw, "expected the INSERT to be rejected by the create policy's WITH CHECK");
    });
  },
);

console.log("");
if (failures > 0) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("all RLS enforcement cases passed.");
}
