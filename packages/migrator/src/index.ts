/**
 * @indigodb/migrator
 *
 * Dialect-agnostic migration engine for IndigoDB.
 * Computes structural differences between schema versions and generates
 * migration steps that can be rendered to SQL by dialect adapters.
 */

import type { Schema, Model, Field } from "@indigodb/ast";

// PostgreSQL dialect + idempotent `db push` renderer.
export {
  renderPushSql,
  renderColumn,
  mapScalarToPg,
  quoteIdent,
} from "./postgres.js";

// ─── Column Definition ───────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue?: string;
}

// ─── Migration Steps ─────────────────────────────────────────────────────────

export type MigrationStep =
  | { kind: "createTable"; name: string; columns: ColumnDef[] }
  | { kind: "dropTable"; name: string }
  | { kind: "addColumn"; table: string; column: ColumnDef }
  | { kind: "dropColumn"; table: string; columnName: string }
  | { kind: "alterColumn"; table: string; columnName: string; changes: Partial<ColumnDef> }
  | { kind: "createIndex"; table: string; columns: string[]; unique: boolean; name?: string }
  | { kind: "dropIndex"; name: string };

// ─── Migration ───────────────────────────────────────────────────────────────

export interface Migration {
  /** Migration name (auto-generated or user-provided). */
  name: string;
  /** Unix timestamp of when the migration was created. */
  timestamp: number;
  /** Ordered list of steps to apply. */
  up: MigrationStep[];
  /** Ordered list of steps to revert (inverse of up). */
  down: MigrationStep[];
}

// ─── Dialect Adapter Interface ───────────────────────────────────────────────

/**
 * Dialect adapters translate abstract MigrationSteps into
 * vendor-specific SQL. Implement this interface to support
 * a new database (PostgreSQL, MySQL, SQLite, etc.).
 */
export interface DialectAdapter {
  /** Human-readable dialect name (e.g., "PostgreSQL"). */
  readonly name: string;

  /** Maps an IndigoDB scalar type name to the dialect's column type. */
  mapScalarType(indigoType: string): string;

  /** Renders a single migration step as one or more SQL statements. */
  renderStep(step: MigrationStep): string;

  /** Renders a complete migration (all steps) as a SQL script. */
  renderMigration(migration: Migration): string;
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

/**
 * Computes the structural difference between two schema versions
 * and produces a Migration with the necessary steps.
 *
 * @param previous - The previous schema state (null for initial migration).
 * @param current  - The current schema state.
 * @param name     - Optional migration name.
 * @returns A Migration object with `up` and `down` steps.
 *
 * @example
 * ```ts
 * import { parse } from "@indigodb/parser";
 * import { diff } from "@indigodb/migrator";
 *
 * const prev = parse(readFileSync("schema.prev.indigo", "utf-8"));
 * const curr = parse(readFileSync("schema.indigo", "utf-8"));
 * const migration = diff(prev, curr, "add_posts_table");
 * ```
 */
export function diff(
  previous: Schema | null,
  current: Schema,
  name?: string,
): Migration {
  const up: MigrationStep[] = [];
  const down: MigrationStep[] = [];

  const prevModels = new Map<string, Model>(
    (previous?.models ?? []).map((m) => [m.name, m]),
  );
  const currModels = new Map<string, Model>(
    current.models.map((m) => [m.name, m]),
  );

  // Detect new tables
  for (const [modelName, model] of currModels) {
    if (!prevModels.has(modelName)) {
      up.push({
        kind: "createTable",
        name: modelName,
        columns: model.fields
          .filter((f) => f.type.scalar)
          .map((f) => fieldToColumnDef(f)),
      });
      down.push({ kind: "dropTable", name: modelName });
    }
  }

  // Detect dropped tables
  for (const [modelName, model] of prevModels) {
    if (!currModels.has(modelName)) {
      up.push({ kind: "dropTable", name: modelName });
      down.push({
        kind: "createTable",
        name: modelName,
        columns: model.fields
          .filter((f) => f.type.scalar)
          .map((f) => fieldToColumnDef(f)),
      });
    }
  }

  // Detect column changes in existing tables
  for (const [modelName, currModel] of currModels) {
    const prevModel = prevModels.get(modelName);
    if (!prevModel) continue;

    const prevFields = new Map<string, Field>(
      prevModel.fields.map((f) => [f.name, f]),
    );
    const currFields = new Map<string, Field>(
      currModel.fields.map((f) => [f.name, f]),
    );

    // New columns
    for (const [fieldName, field] of currFields) {
      if (!prevFields.has(fieldName) && field.type.scalar) {
        up.push({
          kind: "addColumn",
          table: modelName,
          column: fieldToColumnDef(field),
        });
        down.push({
          kind: "dropColumn",
          table: modelName,
          columnName: fieldName,
        });
      }
    }

    // Dropped columns
    for (const [fieldName, field] of prevFields) {
      if (!currFields.has(fieldName) && field.type.scalar) {
        up.push({
          kind: "dropColumn",
          table: modelName,
          columnName: fieldName,
        });
        down.push({
          kind: "addColumn",
          table: modelName,
          column: fieldToColumnDef(field),
        });
      }
    }
  }

  return {
    name: name ?? `migration_${Date.now()}`,
    timestamp: Date.now(),
    up,
    down,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fieldToColumnDef(field: Field): ColumnDef {
  const hasAttr = (name: string) =>
    field.attributes.some((a) => a.name === name);

  return {
    name: field.name,
    type: field.type.name,
    nullable: field.type.optional,
    primaryKey: hasAttr("id"),
    unique: hasAttr("unique"),
    defaultValue: getDefaultValue(field),
  };
}

function getDefaultValue(field: Field): string | undefined {
  const defaultAttr = field.attributes.find((a) => a.name === "default");
  if (!defaultAttr || defaultAttr.args.length === 0) return undefined;

  const val = defaultAttr.args[0].value;

  switch (val.kind) {
    case "string":
      return `'${val.value}'`;
    case "number":
      return String(val.value);
    case "boolean":
      return String(val.value);
    case "function":
      return `${val.name}()`;
    default:
      return undefined;
  }
}
