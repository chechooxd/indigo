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
} from "./postgres.js";

// Versioned migration diff engine (`indigodb migrate`).
export { diffResolved, renderMigrationSql } from "./migrate.js";
