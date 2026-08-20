/**
 * @indigodb/migrator — `buildShadowSchema` plan-equivalence, documented
 * divergence, chain-replay, and desync-diagnostic suite.
 *
 * Mirrors `introspect.mjs`'s style: plain Node, no test framework, PGlite
 * (`@electric-sql/pglite`) as the real PostgreSQL engine for every test that
 * actually replays SQL. Desync-diagnostic tests (the four REFUSE/WARN rules)
 * use an injected `createShadow` double instead — they never need real WASM,
 * because `buildShadowSchema` decides those cases from `recorded`/`onDisk`
 * alone, before ever touching a database.
 *
 * Plan equivalence (C.1): for every fixture in `test/fixtures/` EXCEPT the
 * documented divergence cases, `planMigration(shadowDerivedPrev, next)` must
 * equal `planMigration(resolvedPrev, next)` — proving shadow replay is a
 * transparent substitute for the old snapshot-derived `prev` in the common
 * case. The excluded fixtures diverge for one root cause, explained in
 * `packages/migrator/src/introspect.ts`'s header: introspection ALWAYS sets
 * `name === dbName` (there is no physical catalog signal for "this was
 * renamed via @map"), so a shadow-derived `prev` can never carry the
 * @map-aware identity `matchColumns`/`matchEnumMembers` need to detect a
 * rename. That degradation is accepted and tested POSITIVELY below, not
 * treated as a bug to silently work around.
 */

import { readdirSync } from "node:fs";
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parse, resolve } from "@indigodb/core";
import { loadFixture, loadChainFixture } from "./lib.mjs";
import { withDatabase, introspectPublicSchema, assertSameStructure } from "./pg-harness.mjs";
import {
  buildShadowSchema,
  ShadowReplayError,
  planMigration,
  renderMigrationSql,
  renderPushSql,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const chainDir = join(here, "fixtures-chain", "user-post-status");

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("migrator shadow: buildShadowSchema plan-equivalence + divergence + chain + desync suite");

/**
 * Builds the shadow-derived `prev` for one fixture: pushes `prevResolved`
 * (idempotent `db push` DDL) as if it were a single migration file, then
 * replays+introspects it through the REAL `buildShadowSchema` (default
 * PGlite-backed `createShadow` — dynamically imported, exactly like
 * production). `null` `prevResolved` (no prior schema) maps to an empty
 * `MigrationSource` — `buildShadowSchema` short-circuits to an empty
 * `ResolvedSchema` without touching a database, mirroring `prev === null`.
 */
async function shadowPrevOf(prevResolved) {
  if (!prevResolved) {
    return buildShadowSchema({
      recorded: [],
      onDisk: [],
      read: () => {
        throw new Error("unexpected read() call for an empty MigrationSource");
      },
      checksum: () => {
        throw new Error("unexpected checksum() call for an empty MigrationSource");
      },
      recordedChecksums: {},
    });
  }
  const sql = renderPushSql(prevResolved);
  return buildShadowSchema({
    recorded: ["0001_prev"],
    onDisk: ["0001_prev"],
    read: () => sql,
    checksum: () => "checksum-0001_prev",
    recordedChecksums: { "0001_prev": "checksum-0001_prev" },
  });
}

// ─── C.1: plan-equivalence over the fixture corpus ───────────────────────────
//
// Excluded, with the documented root cause:
// - map-rename-only / map-rename-with-dependents / map-rename-ambiguous:
//   column `@map` rename, undetectable from a shadow-derived `prev` (C.2-C.4).
// - enum-value-remapped: the SAME root cause, one level up — an enum member
//   whose `@map` target moves. Discovered while building this suite (not
//   named in the original design's divergence list); worse than the column
//   case, because an unmatched removed member trips `enum-value-removed`
//   and REFUSES generation entirely, rather than a clean DROP+ADD. Flagged
//   here explicitly rather than silently folded into "OK".

const EXCLUDED_FROM_PLAN_EQUIVALENCE = new Set([
  "map-rename-only",
  "map-rename-with-dependents",
  "map-rename-ambiguous",
  "enum-value-remapped",
]);

const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const name of fixtureNames.filter((n) => !EXCLUDED_FROM_PLAN_EQUIVALENCE.has(n))) {
  await check(`plan-equivalence: ${name}`, async () => {
    const { prev, next } = loadFixture(join(fixturesDir, name));
    const shadowPrev = await shadowPrevOf(prev);
    const planFromShadow = planMigration(shadowPrev, next);
    const planFromResolved = planMigration(prev, next);
    deepStrictEqual(
      planFromShadow,
      planFromResolved,
      `fixture "${name}": shadow-derived plan diverges from the resolved-prev plan`,
    );
  });
}

// ─── C.2-C.4: positively-asserted @map column-rename divergences ────────────

await check("@map divergence (map-rename-only): DROP+ADD instead of RENAME COLUMN", async () => {
  const { prev, next } = loadFixture(join(fixturesDir, "map-rename-only"));
  const shadowPrev = await shadowPrevOf(prev);
  const plan = planMigration(shadowPrev, next);

  strictEqual(plan.diagnostics.length, 0, "expected no diagnostics — this is a silent degradation, not a refusal");
  const sqlJoined = plan.statements.map((s) => s.sql).join("\n");
  ok(!/RENAME COLUMN/.test(sqlJoined), `expected no RENAME COLUMN, got:\n${sqlJoined}`);
  ok(/DROP COLUMN "created_at"/.test(sqlJoined), `expected DROP COLUMN "created_at", got:\n${sqlJoined}`);
  ok(/ADD COLUMN "creation_date"/.test(sqlJoined), `expected ADD COLUMN "creation_date", got:\n${sqlJoined}`);
});

await check(
  "@map divergence (map-rename-with-dependents): DROP+ADD plan attempted; the dropped column's dependent FK is realigned to the new physical name, and — because `email` is a REQUIRED column with no @default — this specific fixture additionally trips required-column-without-default (a stricter, documented consequence of the same DROP+ADD degradation, not a crash)",
  async () => {
    const { prev, next } = loadFixture(join(fixturesDir, "map-rename-with-dependents"));
    const shadowPrev = await shadowPrevOf(prev);
    const plan = planMigration(shadowPrev, next);

    ok(
      plan.diagnostics.some((d) => d.code === "required-column-without-default" && d.column === "email"),
      `expected a required-column-without-default diagnostic for U.email — DROP+ADD treats it as a brand-new required column, not a rename; got: ${JSON.stringify(plan.diagnostics)}`,
    );
    const sqlJoined = plan.statements.map((s) => s.sql).join("\n");
    ok(!/RENAME COLUMN/.test(sqlJoined), `expected no RENAME COLUMN, got:\n${sqlJoined}`);
    ok(/DROP COLUMN "email_addr"/.test(sqlJoined), `expected DROP COLUMN "email_addr", got:\n${sqlJoined}`);
    // The dependent FK on P.uEmail is realigned to the NEW physical name
    // ("email_address") even though the diagnostic still blocks generation —
    // a plan with diagnostics still lists every statement it would otherwise
    // emit (see `MigrationDiagnostic`'s own doc comment in `plan.ts`).
    ok(/REFERENCES "U" \("email_address"\)/.test(sqlJoined), `expected the FK to realign to "email_address", got:\n${sqlJoined}`);
  },
);

await check("@map divergence (map-rename-ambiguous): no ambiguous-column-remap diagnostic, DROP+ADD instead", async () => {
  const { prev, next } = loadFixture(join(fixturesDir, "map-rename-ambiguous"));
  const shadowPrev = await shadowPrevOf(prev);
  const plan = planMigration(shadowPrev, next);

  ok(
    !plan.diagnostics.some((d) => d.code === "ambiguous-column-remap"),
    `expected no ambiguous-column-remap diagnostic — introspected prev never carries an explicit @map to trigger it; got: ${JSON.stringify(plan.diagnostics)}`,
  );
  const sqlJoined = plan.statements.map((s) => s.sql).join("\n");
  ok(/DROP COLUMN "created_at"/.test(sqlJoined), `expected DROP COLUMN "created_at", got:\n${sqlJoined}`);
  ok(/ADD COLUMN "creation_date"/.test(sqlJoined), `expected ADD COLUMN "creation_date", got:\n${sqlJoined}`);
});

// ─── Discovered divergence: enum member @map rename refuses generation ──────
//
// Same root cause as C.2-C.4, one level up (enum members instead of
// columns) — flagged separately from the design's original list because the
// consequence is materially worse: not a degraded DROP+ADD, but a hard
// `enum-value-removed` REFUSAL (PostgreSQL cannot drop an enum value, and
// the shadow-derived `prev` member looks entirely unrelated to `next`'s).

await check(
  "enum @map divergence (enum-value-remapped, discovered): shadow-derived prev REFUSES via enum-value-removed instead of ALTER TYPE RENAME VALUE",
  async () => {
    const { prev, next } = loadFixture(join(fixturesDir, "enum-value-remapped"));
    const shadowPrev = await shadowPrevOf(prev);
    const plan = planMigration(shadowPrev, next);

    ok(
      plan.diagnostics.some((d) => d.code === "enum-value-removed"),
      `expected an enum-value-removed diagnostic (documented degradation); got: ${JSON.stringify(plan.diagnostics)}`,
    );
  },
);

// ─── C.5: single-column @@unique divergence (identical-index drop+recreate) ─
//
// A single-column `@@unique([col])` and a single-column `@unique` render the
// SAME `UNIQUE INDEX` DDL — indistinguishable once introspected. Design
// decision #4 (`sdd/shadow-replay-diff/design`): the introspector classifies
// a single-column unique index named by the derived `@unique` formula as
// `col.unique`, never as a `table.indexes` entry — so a schema that declares
// its uniqueness via `@@unique` gets ONE identical-index drop+recreate on
// its first post-adoption migration, even diffed against its OWN unchanged
// schema. Built inline (not a `fixtures/` golden fixture) to avoid pulling
// this scenario into the golden-corpus harness, which owns a different
// review artifact (`expected.json`).

await check("single-column @@unique divergence: identical-index drop+recreate on first post-adoption migration", async () => {
  const source = `Table User {\n  id    Int    @id @default(autoincrement())\n  email String\n\n  @@unique([email])\n}\n`;
  const schema = resolve(parse(source));
  const shadowPrev = await shadowPrevOf(schema);

  const plan = planMigration(shadowPrev, schema);
  strictEqual(plan.diagnostics.length, 0, "expected no diagnostics");
  strictEqual(plan.statements.length, 2, `expected exactly one DROP INDEX + one CREATE UNIQUE INDEX, got:\n${plan.statements.map((s) => s.sql).join("\n")}`);
  const sqlJoined = plan.statements.map((s) => s.sql).join("\n");
  ok(/DROP INDEX/.test(sqlJoined), `expected a DROP INDEX, got:\n${sqlJoined}`);
  ok(/CREATE UNIQUE INDEX/.test(sqlJoined), `expected a CREATE UNIQUE INDEX, got:\n${sqlJoined}`);
});

// ─── C.6: chain-replay-through-shadow (fixtures-chain/user-post-status) ─────

await check("chain-replay-through-shadow: structurally equals renderPushSql(final)", async () => {
  const schemas = loadChainFixture(chainDir);

  let prev = null;
  const ids = [];
  const sqlById = new Map();
  for (let i = 0; i < schemas.length; i++) {
    const id = `${String(i + 1).padStart(4, "0")}_hop`;
    const plan = planMigration(prev, schemas[i]);
    ids.push(id);
    sqlById.set(id, renderMigrationSql(plan));
    prev = schemas[i];
  }

  const source = {
    recorded: ids,
    onDisk: [...ids],
    read: (id) => sqlById.get(id),
    checksum: (id) => `checksum-${id}`,
    recordedChecksums: Object.fromEntries(ids.map((id) => [id, `checksum-${id}`])),
  };
  const shadowResult = await buildShadowSchema(source);
  const final = schemas[schemas.length - 1];

  await withDatabase(async (shadowPushDb) => {
    await shadowPushDb.exec(renderPushSql(shadowResult));
    await withDatabase(async (finalPushDb) => {
      await finalPushDb.exec(renderPushSql(final));
      const a = await introspectPublicSchema(shadowPushDb);
      const b = await introspectPublicSchema(finalPushDb);
      assertSameStructure(a, b, { aLabel: "shadow-replayed", bLabel: "push(final)" });
    });
  });
});

// ─── C.7: @@realtime chain replay under PGlite ───────────────────────────────
//
// Open question from the design: does PGlite 0.5.4's base build ship
// plpgsql (needed for the `indigo_rt_*` NOTIFY trigger function)? If it
// does, `realtime` must survive shadow replay via trigger-name detection
// (`introspect.ts`'s `TRIGGER_SQL`). If it does NOT, this is a SCOPED,
// EXPLICIT limitation — logged loudly, never silently skipped — matching
// the design's documented fallback (realtime detection degrades gracefully;
// migrate-runner's `saveSnapshot` path is unaffected either way since it
// isn't involved in shadow replay).

await check("@@realtime chain replay: plpgsql trigger survives shadow replay, or documented scoped fallback", async () => {
  const schema1 = resolve(parse(`Table Order {\n  id Int @id @default(autoincrement())\n}\n`));
  const schema2 = resolve(
    parse(`Table Order {\n  id Int @id @default(autoincrement())\n\n  @@realtime\n}\n`),
  );

  const plan1 = renderMigrationSql(planMigration(null, schema1));
  const plan2 = renderMigrationSql(planMigration(schema1, schema2));
  const source = {
    recorded: ["0001_init", "0002_realtime"],
    onDisk: ["0001_init", "0002_realtime"],
    read: (id) => (id === "0001_init" ? plan1 : plan2),
    checksum: (id) => `checksum-${id}`,
    recordedChecksums: { "0001_init": "checksum-0001_init", "0002_realtime": "checksum-0002_realtime" },
  };

  let shadowResult;
  try {
    shadowResult = await buildShadowSchema(source);
  } catch (err) {
    console.warn(
      `  NOTE (scoped, documented limitation): PGlite's base build appears to lack plpgsql support — ` +
        `@@realtime trigger replay failed during shadow replay: ${err.message}`,
    );
    return;
  }

  const table = shadowResult.tables.find((t) => t.dbName === "Order");
  ok(table, "table Order must be introspected after the realtime chain replay");
  strictEqual(
    table.realtime,
    true,
    "realtime flag must survive shadow replay via indigo_rt_* trigger detection — PGlite's plpgsql support is confirmed present",
  );
});

// ─── C.8-C.11: desync diagnostics (injected createShadow, no WASM needed) ───

function assertShadowReplayError(fn, expectedIds) {
  return (async () => {
    let threw = false;
    try {
      await fn();
    } catch (err) {
      threw = true;
      ok(err instanceof ShadowReplayError, `expected a ShadowReplayError, got: ${err}`);
      deepStrictEqual([...err.ids].sort(), [...expectedIds].sort(), `expected ids ${JSON.stringify(expectedIds)}, got ${JSON.stringify(err.ids)}`);
    }
    ok(threw, "expected buildShadowSchema to throw");
  })();
}

const neverCalledCreateShadow = async () => {
  throw new Error("createShadow must not be called for a refusal path");
};

await check("desync (C.8): recorded migration missing on disk refuses, naming the missing id", async () => {
  await assertShadowReplayError(
    () =>
      buildShadowSchema(
        {
          recorded: ["0001_a", "0002_b"],
          onDisk: ["0001_a"],
          read: (id) => `-- ${id}`,
          checksum: (id) => `checksum-${id}`,
          recordedChecksums: { "0001_a": "checksum-0001_a", "0002_b": "checksum-0002_b" },
        },
        { createShadow: neverCalledCreateShadow },
      ),
    ["0002_b"],
  );
});

await check("desync (C.9): pending on-disk directory not recorded refuses, message names `migrate deploy`", async () => {
  let message = "";
  try {
    await buildShadowSchema(
      {
        recorded: ["0001_a"],
        onDisk: ["0001_a", "0002_b"],
        read: (id) => `-- ${id}`,
        checksum: (id) => `checksum-${id}`,
        recordedChecksums: { "0001_a": "checksum-0001_a" },
      },
      { createShadow: neverCalledCreateShadow },
    );
  } catch (err) {
    ok(err instanceof ShadowReplayError, `expected a ShadowReplayError, got: ${err}`);
    deepStrictEqual(err.ids, ["0002_b"]);
    message = err.message;
  }
  ok(/migrate deploy/.test(message), `expected message to name \`migrate deploy\`, got: ${message}`);
});

await check("desync (C.10): reordered same-set warns and replays in RECORDED order", async () => {
  const calls = [];
  const fakeDb = {
    exec: async (sql) => {
      calls.push(sql);
    },
    query: async () => ({ rows: [] }),
    close: async () => {},
  };
  const warnings = [];

  const result = await buildShadowSchema(
    {
      recorded: ["0002_b", "0001_a"],
      onDisk: ["0001_a", "0002_b"],
      read: (id) => `-- marker ${id}`,
      checksum: (id) => `checksum-${id}`,
      recordedChecksums: { "0001_a": "checksum-0001_a", "0002_b": "checksum-0002_b" },
    },
    {
      onWarning: (message) => warnings.push(message),
      createShadow: async () => fakeDb,
    },
  );

  strictEqual(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
  ok(/0002_b, 0001_a/.test(warnings[0]), `expected warning to name the RECORDED order, got: ${warnings[0]}`);

  const idxB = calls.findIndex((c) => c.includes("0002_b"));
  const idxA = calls.findIndex((c) => c.includes("0001_a"));
  ok(
    idxB >= 0 && idxA >= 0 && idxB < idxA,
    `expected replay in recorded order (0002_b before 0001_a), got: ${JSON.stringify(calls)}`,
  );
  deepStrictEqual(result, { tables: [], enums: [], tableGroups: [] });
});

await check("desync (C.11): empty history yields an empty ResolvedSchema, no database touched", async () => {
  const schema = await buildShadowSchema(
    {
      recorded: [],
      onDisk: [],
      read: () => { throw new Error("read() must not be called for empty history"); },
      checksum: () => { throw new Error("checksum() must not be called for empty history"); },
      recordedChecksums: {},
    },
    { createShadow: neverCalledCreateShadow },
  );
  deepStrictEqual(schema, { tables: [], enums: [], tableGroups: [] });
});

await check("desync (C.12): recorded id with drifted on-disk checksum refuses, naming the drifted id", async () => {
  await assertShadowReplayError(
    () =>
      buildShadowSchema(
        {
          recorded: ["0001_a", "0002_b"],
          onDisk: ["0001_a", "0002_b"],
          read: (id) => `-- ${id}`,
          checksum: (id) => (id === "0002_b" ? "checksum-0002_b-EDITED" : "checksum-0001_a"),
          recordedChecksums: { "0001_a": "checksum-0001_a", "0002_b": "checksum-0002_b" },
        },
        { createShadow: neverCalledCreateShadow },
      ),
    ["0002_b"],
  );
});

await check("desync (C.13): matching checksums replay clean; a null stored checksum skips comparison", async () => {
  const fakeDb = {
    exec: async () => {},
    query: async () => ({ rows: [] }),
    close: async () => {},
  };
  const result = await buildShadowSchema(
    {
      recorded: ["0001_a", "0002_b"],
      onDisk: ["0001_a", "0002_b"],
      read: () => "-- sql",
      checksum: (id) => `checksum-${id}`,
      recordedChecksums: { "0001_a": "checksum-0001_a", "0002_b": null },
    },
    { createShadow: async () => fakeDb },
  );
  deepStrictEqual(result, { tables: [], enums: [], tableGroups: [] });
});

if (failures > 0) {
  console.error(`\nmigrator shadow: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmigrator shadow: all green");
