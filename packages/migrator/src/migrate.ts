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
  renderNotifyFunction,
  renderCreateTrigger,
  renderDropTrigger,
  enumMembers,
} from "./postgres.js";
import type { MigrationPhase, MigrationPlan, MigrationStatement } from "./plan.js";
import { NO_TRANSACTION_BEGIN, NO_TRANSACTION_END } from "./plan.js";

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
  const dbNames = enumMembers(e).map((m) => `'${esc(m.dbName)}'`);
  return `CREATE TYPE ${quoteIdent(e.name)} AS ENUM (${dbNames.join(", ")});`;
}

/**
 * Builds a new table's structural DDL: `CREATE TABLE`, unique/plain indexes
 * and its realtime trigger. Foreign keys are NOT included here — every FK,
 * new-table or altered-table alike, is emitted in the dedicated 3c pass (see
 * `computeStatements`) so a table's own constraints never race its
 * dependencies' existence.
 */
function createTable(table: ResolvedTable, enums: ResolvedEnum[]): string[] {
  const lines = table.columns.map((c) => `  ${renderColumn(c, enums)}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  const stmts = [`CREATE TABLE ${quoteIdent(table.dbName)} (\n${lines.join(",\n")}\n);`];
  stmts.push(...tableConstraintsNoFk(table));
  if (table.realtime) stmts.push(renderCreateTrigger(table));
  return stmts;
}

function tableConstraintsNoFk(table: ResolvedTable): string[] {
  const stmts: string[] = [];
  for (const col of table.columns) {
    if (col.unique) stmts.push(createUniqueColIndex(table, col));
  }
  for (const index of table.indexes) stmts.push(createIndex(table, index));
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
  const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : "";
  return `ALTER TABLE ${quoteIdent(table.dbName)} ADD CONSTRAINT ${quoteIdent(fkName(table, fk))} FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(fk.refTable)} (${refCols})${onDelete}${onUpdate};`;
}

function dropForeignKey(table: ResolvedTable, fk: ForeignKey): string {
  return `ALTER TABLE ${quoteIdent(table.dbName)} DROP CONSTRAINT ${quoteIdent(fkName(table, fk))};`;
}

// ─── Column-level ALTERs ─────────────────────────────────────────────────────

/**
 * Signature used to detect whether a column definition changed. `enums` is
 * always the CURRENT (`next`) schema's enum set: it only affects how an enum
 * literal default renders (its PostgreSQL label), and the rendered default
 * is compared as text either way, so resolving both sides against the same
 * enum set is sufficient to detect a real change.
 */
function columnSignature(col: ResolvedColumn, enums: ResolvedEnum[]): string {
  return JSON.stringify({
    type: col.type,
    nullable: col.nullable,
    autoincrement: col.autoincrement,
    default: renderDefaultClause(col, enums) ?? null,
  });
}

function alterColumn(
  table: ResolvedTable,
  prev: ResolvedColumn,
  next: ResolvedColumn,
  enums: ResolvedEnum[],
): string[] {
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
  const prevDefault = renderDefaultClause(prev, enums);
  const nextDefault = renderDefaultClause(next, enums);
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

/** Identity only — column set + referenced table/columns. No referential actions. */
function fkSignature(fk: ForeignKey): string {
  return `${fk.columns.join(",")}->${fk.refTable}.${fk.refColumns.join(",")}`;
}

/**
 * Identity plus referential actions. Compared only for FKs matched by
 * `fkSignature` on both sides: an action-only change (e.g. `onDelete`
 * `Cascade` → `SetNull`) must re-issue the SAME-named constraint
 * (DROP + ADD), not be reported as "unchanged" the way `fkSignature` alone
 * would see it.
 */
function fkDefinition(fk: ForeignKey): string {
  return `${fkSignature(fk)}|${fk.onDelete ?? ""}|${fk.onUpdate ?? ""}`;
}

/**
 * Diffs one table's foreign keys against its previous state (`null` for a
 * brand-new table, whose FKs are all adds). Returns DROP/ADD statement text
 * separately — callers place every DROP (3a) before any table structure
 * change and every ADD (3c) after, never interleaved with `diffTable`'s own
 * per-table statements.
 */
function diffTableFks(
  prev: ResolvedTable | null,
  next: ResolvedTable,
): { drops: string[]; adds: string[] } {
  if (!prev) {
    return { drops: [], adds: next.foreignKeys.map((fk) => addForeignKey(next, fk)) };
  }

  const drops: string[] = [];
  const adds: string[] = [];
  const prevFk = new Map(prev.foreignKeys.map((f) => [fkSignature(f), f]));
  const nextFk = new Map(next.foreignKeys.map((f) => [fkSignature(f), f]));

  for (const [sig, fk] of nextFk) {
    const old = prevFk.get(sig);
    if (!old || fkDefinition(old) !== fkDefinition(fk)) adds.push(addForeignKey(next, fk));
  }
  for (const [sig, fk] of prevFk) {
    const current = nextFk.get(sig);
    if (!current || fkDefinition(current) !== fkDefinition(fk)) drops.push(dropForeignKey(next, fk));
  }

  return { drops, adds };
}

// ─── Table diff ──────────────────────────────────────────────────────────────

/**
 * Diffs one table's non-FK structure: columns, indexes and the realtime
 * trigger. Foreign keys are handled separately by `diffTableFks` (see
 * `computeStatements`'s 3a/3c passes).
 */
function diffTable(prev: ResolvedTable, next: ResolvedTable, enums: ResolvedEnum[]): string[] {
  const stmts: string[] = [];
  const t = quoteIdent(next.dbName);

  const prevCols = new Map(prev.columns.map((c) => [c.name, c]));
  const nextCols = new Map(next.columns.map((c) => [c.name, c]));

  // Added columns.
  for (const col of next.columns) {
    if (!prevCols.has(col.name)) {
      stmts.push(`ALTER TABLE ${t} ADD COLUMN ${renderColumn(col, enums)};`);
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
    if (columnSignature(old, enums) !== columnSignature(col, enums)) {
      stmts.push(...alterColumn(next, old, col, enums));
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

  // Realtime trigger toggled (@@realtime added or removed).
  if ((prev.realtime ?? false) !== (next.realtime ?? false)) {
    stmts.push(next.realtime ? renderCreateTrigger(next) : renderDropTrigger(next));
  }

  return stmts;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function push(stmts: MigrationStatement[], sqls: string[], phase: MigrationPhase = "transaction"): void {
  for (const sql of sqls) stmts.push({ sql, phase });
}

/**
 * Computes the ordered, phase-tagged statements migrating a database from
 * `prev` to `next`. Empty when the schemas are equivalent. Internal — the
 * public contract is `planMigration`, below; this function is unaware of
 * diagnostics (introduced by a later pass).
 *
 * Order: enums (`CREATE TYPE` | `ADD VALUE` pre-transaction) → realtime
 * notify function → **3a** every `DROP CONSTRAINT` (all tables) → **3b**
 * every table's own structure (`CREATE TABLE` | column/index/trigger diff)
 * → **3c** every `ADD CONSTRAINT` (all tables) → dropped tables (CASCADE) →
 * dropped enums. 3a/3b/3c is a deferred FK pass, not a topological sort: it
 * satisfies declaration order, self-references, genuine A↔B cycles and
 * existing-table-references-new BY CONSTRUCTION, because no FK statement
 * ever runs before every table exists (adds) or before the tables it might
 * reference lose an old, conflicting definition (drops precede structure).
 */
function computeStatements(prev: ResolvedSchema | null, next: ResolvedSchema): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];

  const prevEnums = new Map((prev?.enums ?? []).map((e) => [e.name, e]));
  const nextEnums = new Map(next.enums.map((e) => [e.name, e]));
  const prevTables = new Map((prev?.tables ?? []).map((t) => [t.name, t]));
  const nextTables = new Map(next.tables.map((t) => [t.name, t]));

  // Enums first (tables may depend on them). `ADD VALUE` cannot run in the
  // same transaction as a later statement that uses it, so it is tagged
  // pre-transaction; `CREATE TYPE` for a brand-new enum has no such
  // restriction.
  for (const e of next.enums) {
    const old = prevEnums.get(e.name);
    if (!old) {
      push(stmts, [createEnum(e)]);
    } else {
      const oldNames = new Set(enumMembers(old).map((m) => m.name));
      for (const m of enumMembers(e)) {
        if (!oldNames.has(m.name)) {
          push(
            stmts,
            [`ALTER TYPE ${quoteIdent(e.name)} ADD VALUE IF NOT EXISTS '${esc(m.dbName)}';`],
            "pre-transaction",
          );
        }
      }
    }
  }

  // Realtime notify function, before any trigger that references it. Emitted
  // when realtime first appears; CREATE OR REPLACE makes re-emission harmless.
  const prevHasRealtime = (prev?.tables ?? []).some((t) => t.realtime);
  if (!prevHasRealtime && next.tables.some((t) => t.realtime)) {
    push(stmts, [renderNotifyFunction()]);
  }

  // Compute every table's FK drops/adds up front, without emitting them yet
  // — 3a and 3c below place them at the correct GLOBAL position, before and
  // after every table's own structure pass respectively.
  const fkDrops: string[] = [];
  const fkAdds: string[] = [];
  for (const table of next.tables) {
    const { drops, adds } = diffTableFks(prevTables.get(table.name) ?? null, table);
    fkDrops.push(...drops);
    fkAdds.push(...adds);
  }

  // 3a: drop every removed/redefined FK constraint first, so 3c can re-add a
  // same-named constraint without a duplicate-name failure.
  push(stmts, fkDrops);

  // 3b: new + altered table structure, FK-free.
  for (const table of next.tables) {
    const old = prevTables.get(table.name);
    push(stmts, !old ? createTable(table, next.enums) : diffTable(old, table, next.enums));
  }

  // 3c: add every new/redefined FK constraint, once every table exists.
  push(stmts, fkAdds);

  // Dropped tables (after alters so dependent FKs are handled by CASCADE).
  for (const table of prevTables.values()) {
    if (!nextTables.has(table.name)) {
      push(stmts, [`DROP TABLE ${quoteIdent(table.dbName)} CASCADE;`]);
    }
  }

  // Dropped enums last (tables referencing them are already gone/altered).
  for (const e of prevEnums.values()) {
    if (!nextEnums.has(e.name)) push(stmts, [`DROP TYPE ${quoteIdent(e.name)};`]);
  }

  return stmts;
}

/**
 * Computes the migration plan taking a database from `prev` to `next`: an
 * ordered, phase-tagged statement list plus any diagnostics that must block
 * generation. `diagnostics` is always empty in this contract — refusal
 * diagnostics (ambiguous rename, enum removal, unguarded `NOT NULL`) are
 * introduced by a later pass.
 */
export function planMigration(prev: ResolvedSchema | null, next: ResolvedSchema): MigrationPlan {
  return { statements: computeStatements(prev, next), diagnostics: [] };
}

/** Wraps a migration plan's statements into a migration file body. */
export function renderMigrationSql(plan: MigrationPlan): string {
  if (plan.statements.length === 0) return "";
  const blocks = plan.statements.map((stmt) =>
    stmt.phase === "pre-transaction"
      ? [NO_TRANSACTION_BEGIN, stmt.sql, NO_TRANSACTION_END].join("\n")
      : stmt.sql,
  );
  return `-- Generated by IndigoDB migrate (PostgreSQL)\n\n${blocks.join("\n\n")}\n`;
}
