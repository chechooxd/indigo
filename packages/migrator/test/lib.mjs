/**
 * Shared fixture-resolution helper for the golden harness (`migrator.mjs`)
 * and its explicit regeneration script (`regen-goldens.mjs`). Kept separate
 * from both entry points so importing it never re-runs either script.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, resolve } from "@indigodb/core";
import { planMigration, renderMigrationSql, renderPushSql } from "../dist/index.js";

/** Parses+resolves an `.indigo` source file, or returns null when absent. */
function resolveFixture(dir, file) {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  const source = readFileSync(path, "utf8");
  return resolve(parse(source));
}

/**
 * Loads and resolves one fixture directory's schema pair. `prev` is `null`
 * when `prev.indigo` is absent (no prior schema). Shared by the golden
 * harness and the PostgreSQL appliability suite so both diff the exact same
 * resolved schemas.
 */
export function loadFixture(dir) {
  const prev = resolveFixture(dir, "prev.indigo");
  const next = resolveFixture(dir, "next.indigo");
  if (!next) throw new Error(`${dir}: next.indigo is required`);
  return { prev, next };
}

/**
 * Loads an ORDERED chain of `schema-NN.indigo` files from `dir` — used by
 * the replay-from-zero suite (`replay.mjs`) instead of the `prev`/`next`
 * pair `loadFixture` reads. Files are sorted lexically (`schema-01`,
 * `schema-02`, ...), so the numeric suffix must stay zero-padded and
 * contiguous starting at 1: a gap or an empty directory is a fixture
 * authoring bug, not a runtime condition to tolerate silently, so both
 * throw loudly instead of returning a partial chain.
 */
export function loadChainFixture(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^schema-\d+\.indigo$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`${dir}: no schema-NN.indigo files found`);
  }
  files.forEach((file, index) => {
    const expectedHop = index + 1;
    const match = file.match(/^schema-(\d+)\.indigo$/);
    const hop = Number.parseInt(match[1], 10);
    if (hop !== expectedHop) {
      throw new Error(
        `${dir}: expected contiguous hops starting at 1, found gap at "${file}" (expected schema-${String(expectedHop).padStart(2, "0")}.indigo)`,
      );
    }
  });
  return files.map((file) => resolve(parse(readFileSync(join(dir, file), "utf8"))));
}

/** Computes the golden-comparable output for one fixture directory. */
export function computeActual(dir) {
  const { prev, next } = loadFixture(dir);
  const plan = planMigration(prev, next);
  return {
    // Statements are recorded with their execution phase: a golden must fail
    // when a statement silently moves in or out of the migration transaction,
    // not only when its SQL text changes.
    statements: plan.statements,
    diagnostics: plan.diagnostics,
    migrationSql: renderMigrationSql(plan),
    pushSql: renderPushSql(next),
  };
}
