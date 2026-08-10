/**
 * Shared fixture-resolution helper for the golden harness (`migrator.mjs`)
 * and its explicit regeneration script (`regen-goldens.mjs`). Kept separate
 * from both entry points so importing it never re-runs either script.
 */

import { readFileSync, existsSync } from "node:fs";
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
