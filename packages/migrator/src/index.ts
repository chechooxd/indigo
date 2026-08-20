/**
 * @indigodb/migrator
 *
 * PostgreSQL migration engine for IndigoDB, driven by the resolved IR
 * (`ResolvedSchema` from `@indigodb/core`): an idempotent `db push` renderer
 * and an exact diff engine for versioned migrations.
 */

// PostgreSQL dialect + idempotent `db push` renderer.
export {
  renderPushSql,
  renderColumn,
  renderDefaultClause,
  renderNotifyFunction,
  renderCreateTrigger,
  renderDropTrigger,
  triggerName,
  mapScalarToPg,
  quoteIdent,
  indexName,
  renderIndexDdl,
} from "./postgres.js";

// Versioned migration diff engine (`indigodb migrate`).
export { planMigration, renderMigrationSql } from "./migrate.js";

// Schema introspection (shadow-replay diff source).
export { introspectResolvedSchema } from "./introspect.js";
export type { IntrospectionQuery, IntrospectOptions } from "./introspect.js";

// Shadow replay (migrate-runner's diff source): replays recorded migration
// files into an isolated database, then introspects it.
export { buildShadowSchema, ShadowReplayError } from "./shadow.js";
export type { MigrationSource, ShadowDb, BuildShadowSchemaOptions } from "./shadow.js";

// Migration plan contract: phase-tagged statements plus blocking diagnostics.
export {
  splitMigrationSql,
  scanRequiresForce,
  NO_TRANSACTION_BEGIN,
  NO_TRANSACTION_END,
  REQUIRES_FORCE_MARKER,
} from "./plan.js";
export type {
  MigrationPlan,
  MigrationStatement,
  MigrationPhase,
  MigrationRisk,
  MigrationDiagnostic,
  MigrationDiagnosticCode,
} from "./plan.js";
