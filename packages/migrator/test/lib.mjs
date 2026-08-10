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

/** Computes the golden-comparable output for one fixture directory. */
export function computeActual(dir) {
  const prev = resolveFixture(dir, "prev.indigo");
  const next = resolveFixture(dir, "next.indigo");
  if (!next) throw new Error(`${dir}: next.indigo is required`);
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
