/**
 * @indigodb/migrator — Migration diff engine
 *
 * Computes the SQL statements that take a PostgreSQL database from a previous
 * `ResolvedSchema` state to the current one. Unlike `renderPushSql` (idempotent,
 * additive), this produces exact, ordered DDL for a versioned migration file and
 * handles destructive/altering changes: dropped tables/columns, column type /
 * nullability / default changes, and added/removed enums, indexes and FKs.
 */

import type {
  ResolvedSchema,
  ResolvedTable,
  ResolvedColumn,
  ResolvedEnum,
  ResolvedIndex,
  ForeignKey,
} from "@indigodb/core";
import {
  mapScalarToPg,
  quoteIdent,
  renderColumn,
  renderDefaultClause,
} from "./postgres.js";

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

// ─── Naming (kept stable with postgres.ts push output) ───────────────────────

function fkName(table: ResolvedTable, fk: ForeignKey): string {
  return fk.name ?? `${table.dbName}_${fk.columns.join("_")}_fkey`;
}

function indexName(table: ResolvedTable, index: ResolvedIndex): string {
  const suffix = index.unique ? "key" : "idx";
  return index.name ?? `${table.dbName}_${index.columns.join("_")}_${suffix}`;
}

function uniqueColIndexName(table: ResolvedTable, col: ResolvedColumn): string {
  return `${table.dbName}_${col.dbName}_key`;
}

// ─── Statement renderers (exact, no IF NOT EXISTS) ───────────────────────────

function createEnum(e: ResolvedEnum): string {
  return `CREATE TYPE ${quoteIdent(e.name)} AS ENUM (${e.values.map((v) => `'${esc(v)}'`).join(", ")});`;
}

function createTable(table: ResolvedTable): string[] {
  const lines = table.columns.map((c) => `  ${renderColumn(c)}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  const stmts = [`CREATE TABLE ${quoteIdent(table.dbName)} (\n${lines.join(",\n")}\n);`];
  stmts.push(...tableConstraints(table));
  return stmts;
}

function tableConstraints(table: ResolvedTable): string[] {
  const stmts: string[] = [];
  for (const col of table.columns) {
    if (col.unique) stmts.push(createUniqueColIndex(table, col));
  }
  for (const index of table.indexes) stmts.push(createIndex(table, index));
  for (const fk of table.foreignKeys) stmts.push(addForeignKey(table, fk));
  return stmts;
}

function createUniqueColIndex(table: ResolvedTable, col: ResolvedColumn): string {
  return `CREATE UNIQUE INDEX ${quoteIdent(uniqueColIndexName(table, col))} ON ${quoteIdent(table.dbName)} (${quoteIdent(col.dbName)});`;
}

function createIndex(table: ResolvedTable, index: ResolvedIndex): string {
  const kind = index.unique ? "UNIQUE INDEX" : "INDEX";
  const cols = index.columns.map(quoteIdent).join(", ");
  return `CREATE ${kind} ${quoteIdent(indexName(table, index))} ON ${quoteIdent(table.dbName)} (${cols});`;
}

function addForeignKey(table: ResolvedTable, fk: ForeignKey): string {
  const cols = fk.columns.map(quoteIdent).join(", ");
  const refCols = fk.refColumns.map(quoteIdent).join(", ");
  const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
  return `ALTER TABLE ${quoteIdent(table.dbName)} ADD CONSTRAINT ${quoteIdent(fkName(table, fk))} FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(fk.refTable)} (${refCols})${onDelete};`;
}

// ─── Column-level ALTERs ─────────────────────────────────────────────────────

/** Signature used to detect whether a column definition changed. */
function columnSignature(col: ResolvedColumn): string {
  return JSON.stringify({
    type: col.type,
    nullable: col.nullable,
    autoincrement: col.autoincrement,
    default: renderDefaultClause(col) ?? null,
  });
}

function alterColumn(table: ResolvedTable, prev: ResolvedColumn, next: ResolvedColumn): string[] {
  const stmts: string[] = [];
  const t = quoteIdent(table.dbName);
  const c = quoteIdent(next.dbName);

  if (prev.type !== next.type) {
    stmts.push(
      `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${mapScalarToPg(next.type)} USING ${c}::${mapScalarToPg(next.type)};`,
    );
  }
  if (prev.nullable !== next.nullable) {
    stmts.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${next.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`);
  }
  const prevDefault = renderDefaultClause(prev);
  const nextDefault = renderDefaultClause(next);
  if (prevDefault !== nextDefault) {
    stmts.push(
      nextDefault
        ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${nextDefault};`
        : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`,
    );
  }
  return stmts;
}

// ─── Constraint signatures ───────────────────────────────────────────────────

function indexSignature(index: ResolvedIndex): string {
  return `${index.unique ? "u" : "i"}:${index.columns.join(",")}`;
}

function fkSignature(fk: ForeignKey): string {
  return `${fk.columns.join(",")}->${fk.refTable}.${fk.refColumns.join(",")}`;
}

// ─── Table diff ──────────────────────────────────────────────────────────────

function diffTable(prev: ResolvedTable, next: ResolvedTable): string[] {
  const stmts: string[] = [];
  const t = quoteIdent(next.dbName);

  const prevCols = new Map(prev.columns.map((c) => [c.name, c]));
  const nextCols = new Map(next.columns.map((c) => [c.name, c]));

  // Added columns.
  for (const col of next.columns) {
    if (!prevCols.has(col.name)) {
      stmts.push(`ALTER TABLE ${t} ADD COLUMN ${renderColumn(col)};`);
      if (col.unique) stmts.push(createUniqueColIndex(next, col));
    }
  }
  // Dropped columns.
  for (const col of prev.columns) {
    if (!nextCols.has(col.name)) {
      stmts.push(`ALTER TABLE ${t} DROP COLUMN ${quoteIdent(col.dbName)};`);
    }
  }
  // Changed columns.
  for (const col of next.columns) {
    const old = prevCols.get(col.name);
    if (!old) continue;
    if (columnSignature(old) !== columnSignature(col)) {
      stmts.push(...alterColumn(next, old, col));
    }
    // Unique flag toggled.
    if (old.unique !== col.unique) {
      stmts.push(
        col.unique
          ? createUniqueColIndex(next, col)
          : `DROP INDEX ${quoteIdent(uniqueColIndexName(next, col))};`,
      );
    }
  }

  // Indexes.
  const prevIdx = new Map(prev.indexes.map((i) => [indexSignature(i), i]));
  const nextIdx = new Map(next.indexes.map((i) => [indexSignature(i), i]));
  for (const [sig, index] of nextIdx) {
    if (!prevIdx.has(sig)) stmts.push(createIndex(next, index));
  }
  for (const [sig, index] of prevIdx) {
    if (!nextIdx.has(sig)) stmts.push(`DROP INDEX ${quoteIdent(indexName(prev, index))};`);
  }

  // Foreign keys.
  const prevFk = new Map(prev.foreignKeys.map((f) => [fkSignature(f), f]));
  const nextFk = new Map(next.foreignKeys.map((f) => [fkSignature(f), f]));
  for (const [sig, fk] of nextFk) {
    if (!prevFk.has(sig)) stmts.push(addForeignKey(next, fk));
  }
  for (const [sig, fk] of prevFk) {
    if (!nextFk.has(sig)) {
      stmts.push(`ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(fkName(prev, fk))};`);
    }
  }

  return stmts;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Computes the ordered SQL statements migrating a database from `prev` to
 * `next`. Returns an empty array when the schemas are equivalent.
 */
export function diffResolved(prev: ResolvedSchema | null, next: ResolvedSchema): string[] {
  const stmts: string[] = [];

  const prevEnums = new Map((prev?.enums ?? []).map((e) => [e.name, e]));
  const nextEnums = new Map(next.enums.map((e) => [e.name, e]));
  const prevTables = new Map((prev?.tables ?? []).map((t) => [t.name, t]));
  const nextTables = new Map(next.tables.map((t) => [t.name, t]));

  // Enums first (tables may depend on them).
  for (const e of next.enums) {
    const old = prevEnums.get(e.name);
    if (!old) {
      stmts.push(createEnum(e));
    } else {
      for (const v of e.values) {
        if (!old.values.includes(v)) {
          stmts.push(`ALTER TYPE ${quoteIdent(e.name)} ADD VALUE IF NOT EXISTS '${esc(v)}';`);
        }
      }
    }
  }

  // New + altered tables.
  for (const table of next.tables) {
    const old = prevTables.get(table.name);
    if (!old) stmts.push(...createTable(table));
    else stmts.push(...diffTable(old, table));
  }

  // Dropped tables (after alters so dependent FKs are handled by CASCADE).
  for (const table of prevTables.values()) {
    if (!nextTables.has(table.name)) {
      stmts.push(`DROP TABLE ${quoteIdent(table.dbName)} CASCADE;`);
    }
  }

  // Dropped enums last (tables referencing them are already gone/altered).
  for (const e of prevEnums.values()) {
    if (!nextEnums.has(e.name)) stmts.push(`DROP TYPE ${quoteIdent(e.name)};`);
  }

  return stmts;
}

/** Wraps `diffResolved` statements into a migration file body. */
export function renderMigrationSql(prev: ResolvedSchema | null, next: ResolvedSchema): string {
  const stmts = diffResolved(prev, next);
  if (stmts.length === 0) return "";
  return `-- Generated by IndigoDB migrate (PostgreSQL)\n\n${stmts.join("\n\n")}\n`;
}
