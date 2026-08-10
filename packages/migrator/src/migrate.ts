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
import type {
  MigrationDiagnostic,
  MigrationPhase,
  MigrationPlan,
  MigrationStatement,
} from "./plan.js";
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

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** Whether a field carries an explicit `@map` (physical name diverges from the schema name). */
function hasExplicitMap(col: ResolvedColumn): boolean {
  return col.dbName !== col.name;
}

function describeColumn(col: ResolvedColumn): string {
  return hasExplicitMap(col) ? `"${col.name}" @map("${col.dbName}")` : `"${col.name}"`;
}

/**
 * `dropped`/`added` are the residual columns matched by neither logical name
 * nor physical name after the two matching passes in `matchColumns` — Rule R
 * fires only when at least one member of each side carries an explicit
 * `@map` (see `matchColumns`'s caller).
 */
function ambiguousColumnRemapDiagnostic(
  table: ResolvedTable,
  dropped: ResolvedColumn[],
  added: ResolvedColumn[],
): MigrationDiagnostic {
  const message =
    dropped.length === 1 && added.length === 1
      ? `Cannot rename column on "${table.name}": field ${describeColumn(dropped[0])} became ${describeColumn(added[0])} in one edit, so the target is ambiguous. Change the field name and the @map in separate migrations.`
      : `Cannot resolve column rename on "${table.name}": ambiguous match between removed fields (${dropped.map(describeColumn).join(", ")}) and added fields (${added.map(describeColumn).join(", ")}). Change the field names and @map values in separate migrations.`;
  return { code: "ambiguous-column-remap", message, table: table.name };
}

function requiredColumnWithoutDefaultDiagnostic(
  table: ResolvedTable,
  col: ResolvedColumn,
): MigrationDiagnostic {
  const message = `Cannot add required column "${col.name}" to existing table "${table.name}" without a default. Declare @default(...) on "${table.name}.${col.name}", or make the field optional ("${col.type}?") and backfill it manually.`;
  return { code: "required-column-without-default", message, table: table.name, column: col.name };
}

function enumValueRemovedDiagnostic(e: ResolvedEnum, removed: string[]): MigrationDiagnostic {
  const quoted = removed.map((v) => `"${v}"`);
  const message =
    removed.length === 1
      ? `Cannot remove value ${quoted[0]} from enum "${e.name}". PostgreSQL cannot drop an enum value; recreate the type by hand after migrating every row that still holds ${quoted[0]}.`
      : `Cannot remove values ${quoted.join(", ")} from enum "${e.name}". PostgreSQL cannot drop an enum value; recreate the type by hand after migrating every row that still holds one of them.`;
  return { code: "enum-value-removed", message, enumName: e.name, values: removed };
}

// ─── Column matching ─────────────────────────────────────────────────────────

interface ColumnMatch {
  /** Columns matched by logical field name — includes unchanged and renamed (`@map` moved) pairs. */
  pairs: { old: ResolvedColumn; col: ResolvedColumn }[];
  /** Physical rename, keyed by OLD `dbName` → NEW `dbName`, for one table. */
  renameMap: Map<string, string>;
  /** `next` columns matched by neither logical nor physical name. */
  added: ResolvedColumn[];
  /** `prev` columns matched by neither logical nor physical name. */
  dropped: ResolvedColumn[];
}

/**
 * Matches `prev`'s columns against `next`'s: logical field name first
 * (unchanged identity — a `dbName` divergence here is an unambiguous
 * `@map` rename), then physical `dbName` second (a logical rename with a
 * stable `@map` — the physical column never moves, nothing to emit).
 * Residual columns matched by neither key feed Rule R (see
 * `ambiguousColumnRemapDiagnostic`).
 */
function matchColumns(prev: ResolvedTable, next: ResolvedTable): ColumnMatch {
  const prevByName = new Map(prev.columns.map((c) => [c.name, c]));
  const consumedPrev = new Set<string>();
  const consumedNext = new Set<string>();
  const pairs: { old: ResolvedColumn; col: ResolvedColumn }[] = [];
  const renameMap = new Map<string, string>();

  for (const col of next.columns) {
    const old = prevByName.get(col.name);
    if (!old) continue;
    pairs.push({ old, col });
    consumedPrev.add(old.name);
    consumedNext.add(col.name);
    if (old.dbName !== col.dbName) renameMap.set(old.dbName, col.dbName);
  }

  const prevRemaining = prev.columns.filter((c) => !consumedPrev.has(c.name));
  const nextRemaining = next.columns.filter((c) => !consumedNext.has(c.name));
  const prevByDbName = new Map(prevRemaining.map((c) => [c.dbName, c]));
  for (const col of nextRemaining) {
    const old = prevByDbName.get(col.dbName);
    if (!old) continue;
    consumedPrev.add(old.name);
    consumedNext.add(col.name);
  }

  return {
    pairs,
    renameMap,
    added: next.columns.filter((c) => !consumedNext.has(c.name)),
    dropped: prev.columns.filter((c) => !consumedPrev.has(c.name)),
  };
}

/**
 * Rewrites a table's physical references (PK columns, index columns, own FK
 * columns) through a rename map before it is diffed against `next`.
 * PostgreSQL follows `RENAME COLUMN` automatically for these, so without
 * this a single `@map` change makes every index/FK/PK on that column look
 * dropped-and-recreated against a column that, physically, never left.
 */
function remapPhysicalNames(table: ResolvedTable, renameMap: Map<string, string>): ResolvedTable {
  if (renameMap.size === 0) return table;
  const remap = (dbName: string) => renameMap.get(dbName) ?? dbName;
  return {
    ...table,
    primaryKey: table.primaryKey.map(remap),
    indexes: table.indexes.map((idx) => ({ ...idx, columns: idx.columns.map(remap) })),
    foreignKeys: table.foreignKeys.map((fk) => ({ ...fk, columns: fk.columns.map(remap) })),
  };
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
 * brand-new table, whose FKs are all adds). `renameMap` (from `matchColumns`)
 * rewrites `prevOriginal`'s FK columns before comparison — an FK on a
 * renamed column must not look dropped-and-recreated. Returns DROP/ADD
 * statement text separately — callers place every DROP (3a) before any table
 * structure change and every ADD (3c) after, never interleaved with
 * `diffTable`'s own per-table statements — plus `renames`, realigning an
 * auto-derived constraint name left stale by a column rename (PostgreSQL
 * does not rename dependent constraints).
 */
function diffTableFks(
  prevOriginal: ResolvedTable | null,
  next: ResolvedTable,
  renameMap: Map<string, string>,
): { drops: string[]; adds: string[]; renames: string[] } {
  if (!prevOriginal) {
    return { drops: [], adds: next.foreignKeys.map((fk) => addForeignKey(next, fk)), renames: [] };
  }

  const prev = remapPhysicalNames(prevOriginal, renameMap);
  const drops: string[] = [];
  const adds: string[] = [];
  const renames: string[] = [];
  const origBySig = new Map(prev.foreignKeys.map((fk, i) => [fkSignature(fk), prevOriginal.foreignKeys[i]]));
  const prevFk = new Map(prev.foreignKeys.map((f) => [fkSignature(f), f]));
  const nextFk = new Map(next.foreignKeys.map((f) => [fkSignature(f), f]));

  for (const [sig, fk] of nextFk) {
    const old = prevFk.get(sig);
    if (!old || fkDefinition(old) !== fkDefinition(fk)) {
      adds.push(addForeignKey(next, fk));
      continue;
    }
    if (!fk.name) {
      const original = origBySig.get(sig);
      if (original) {
        const oldName = fkName(prevOriginal, original);
        const newName = fkName(next, fk);
        if (oldName !== newName) {
          renames.push(
            `ALTER TABLE ${quoteIdent(next.dbName)} RENAME CONSTRAINT ${quoteIdent(oldName)} TO ${quoteIdent(newName)};`,
          );
        }
      }
    }
  }
  for (const [sig, fk] of prevFk) {
    const current = nextFk.get(sig);
    if (!current || fkDefinition(current) !== fkDefinition(fk)) {
      const original = origBySig.get(sig) ?? fk;
      drops.push(dropForeignKey(next, original));
    }
  }

  return { drops, adds, renames };
}

// ─── Table diff ──────────────────────────────────────────────────────────────

/**
 * Diffs one table's non-FK structure: columns, indexes and the realtime
 * trigger. Foreign keys are handled separately by `diffTableFks` (see
 * `computeStatements`'s 3a/3c passes). `match` (from `matchColumns`) already
 * decided column identity; this function renders the statements it implies
 * plus everything downstream of a rename (PK/index diff against remapped
 * physical names, auto-derived index-name realignment).
 */
function diffTable(
  prevOriginal: ResolvedTable,
  next: ResolvedTable,
  enums: ResolvedEnum[],
  diagnostics: MigrationDiagnostic[],
  match: ColumnMatch,
): string[] {
  const stmts: string[] = [];
  const t = quoteIdent(next.dbName);
  const prev = remapPhysicalNames(prevOriginal, match.renameMap);

  // Rule R: residual columns matched by neither key. Refuse only when both
  // sides are non-empty AND at least one member of each carries an explicit
  // `@map` — otherwise fall back to today's DROP+ADD (a bare field rename
  // with no `@map` signal is deliberately left ambiguous, out of scope).
  const droppedMapped = match.dropped.filter(hasExplicitMap);
  const addedMapped = match.added.filter(hasExplicitMap);
  const ambiguous =
    match.dropped.length > 0 &&
    match.added.length > 0 &&
    droppedMapped.length > 0 &&
    addedMapped.length > 0;
  if (ambiguous) {
    diagnostics.push(ambiguousColumnRemapDiagnostic(next, match.dropped, match.added));
  }

  // Unambiguous @map-only renames (matched by logical field name, `dbName`
  // moved). Emitted first so every later ALTER addresses the NEW dbName.
  for (const { old, col } of match.pairs) {
    if (old.dbName !== col.dbName) {
      stmts.push(
        `ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(old.dbName)} TO ${quoteIdent(col.dbName)};`,
      );
    }
  }

  if (!ambiguous) {
    // Added columns (residual — no match by either key).
    for (const col of match.added) {
      if (!col.nullable && !col.autoincrement && renderDefaultClause(col, enums) === undefined) {
        diagnostics.push(requiredColumnWithoutDefaultDiagnostic(next, col));
        continue;
      }
      stmts.push(`ALTER TABLE ${t} ADD COLUMN ${renderColumn(col, enums)};`);
      if (col.unique) stmts.push(createUniqueColIndex(next, col));
    }
    // Dropped columns (residual — no match by either key).
    for (const col of match.dropped) {
      stmts.push(`ALTER TABLE ${t} DROP COLUMN ${quoteIdent(col.dbName)};`);
    }
  }

  // Changed columns (matched by logical field name).
  for (const { old, col } of match.pairs) {
    if (columnSignature(old, enums) !== columnSignature(col, enums)) {
      stmts.push(...alterColumn(next, old, col, enums));
    }
    if (old.unique !== col.unique) {
      stmts.push(
        col.unique
          ? createUniqueColIndex(next, col)
          : `DROP INDEX ${quoteIdent(uniqueColIndexName(next, col))};`,
      );
    } else if (col.unique && old.dbName !== col.dbName) {
      // Renamed column keeps its single-column unique index — the
      // auto-derived name embeds the column's dbName, so realign it.
      const oldName = uniqueColIndexName(prevOriginal, old);
      const newName = uniqueColIndexName(next, col);
      if (oldName !== newName) stmts.push(`ALTER INDEX ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)};`);
    }
  }

  // Primary key change: no data movement, drop and recreate the constraint.
  // KNOWN LIMITATION: assumes PostgreSQL's default `<table>_pkey` naming —
  // what an inline `PRIMARY KEY (...)` in `CREATE TABLE` produces. A
  // hand-named PK constraint would not be found by this DROP.
  if (JSON.stringify(prev.primaryKey) !== JSON.stringify(next.primaryKey)) {
    stmts.push(`ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(`${prevOriginal.dbName}_pkey`)};`);
    stmts.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${next.primaryKey.map(quoteIdent).join(", ")});`);
  }

  // Indexes (against the remapped `prev`, so an unchanged index covering a
  // renamed column is not reported as dropped-and-recreated).
  const prevIdx = new Map(prev.indexes.map((i) => [indexSignature(i), i]));
  const nextIdx = new Map(next.indexes.map((i) => [indexSignature(i), i]));
  const origIdxBySig = new Map(prev.indexes.map((i, n) => [indexSignature(i), prevOriginal.indexes[n]]));
  for (const [sig, index] of nextIdx) {
    const old = prevIdx.get(sig);
    if (!old) {
      stmts.push(createIndex(next, index));
      continue;
    }
    if (!index.name) {
      const original = origIdxBySig.get(sig);
      if (original) {
        const oldName = indexName(prevOriginal, original);
        const newName = indexName(next, index);
        if (oldName !== newName) stmts.push(`ALTER INDEX ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)};`);
      }
    }
  }
  for (const [sig, index] of prevIdx) {
    if (!nextIdx.has(sig)) {
      const original = origIdxBySig.get(sig) ?? index;
      stmts.push(`DROP INDEX ${quoteIdent(indexName(prevOriginal, original))};`);
    }
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
 * `prev` to `next`, plus any diagnostics that must block generation. Empty
 * statements when the schemas are equivalent. Internal — the public contract
 * is `planMigration`, below.
 *
 * Order: enums (`CREATE TYPE` | `ADD VALUE` pre-transaction) → realtime
 * notify function → **3a** every `DROP CONSTRAINT` (all tables) → **3b**
 * every table's own structure (`CREATE TABLE` | `RENAME COLUMN` →
 * ADD/DROP/ALTER COLUMN → PK → indexes → trigger) → FK constraint renames →
 * **3c** every `ADD CONSTRAINT` (all tables) → dropped tables (CASCADE) →
 * dropped enums. 3a/3b/3c is a deferred FK pass, not a topological sort: it
 * satisfies declaration order, self-references, genuine A↔B cycles and
 * existing-table-references-new BY CONSTRUCTION, because no FK statement
 * ever runs before every table exists (adds) or before the tables it might
 * reference lose an old, conflicting definition (drops precede structure).
 * A plan still lists every statement it would otherwise emit even when it
 * carries diagnostics — callers that must refuse generation check
 * `diagnostics.length` themselves; nothing here silently filters the plan.
 */
function computeStatements(
  prev: ResolvedSchema | null,
  next: ResolvedSchema,
  diagnostics: MigrationDiagnostic[],
): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];

  const prevEnums = new Map((prev?.enums ?? []).map((e) => [e.name, e]));
  const nextEnums = new Map(next.enums.map((e) => [e.name, e]));
  const prevTables = new Map((prev?.tables ?? []).map((t) => [t.name, t]));
  const nextTables = new Map(next.tables.map((t) => [t.name, t]));

  // Enums first (tables may depend on them). `ADD VALUE` cannot run in the
  // same transaction as a later statement that uses it, so it is tagged
  // pre-transaction; `CREATE TYPE` for a brand-new enum has no such
  // restriction. PostgreSQL cannot drop an enum value — a removed member
  // refuses generation instead of silently leaving the stale label behind.
  for (const e of next.enums) {
    const old = prevEnums.get(e.name);
    if (!old) {
      push(stmts, [createEnum(e)]);
      continue;
    }
    const oldMembers = enumMembers(old);
    const nextMembers = enumMembers(e);
    const oldNames = new Set(oldMembers.map((m) => m.name));
    const nextNames = new Set(nextMembers.map((m) => m.name));
    for (const m of nextMembers) {
      if (!oldNames.has(m.name)) {
        push(
          stmts,
          [`ALTER TYPE ${quoteIdent(e.name)} ADD VALUE IF NOT EXISTS '${esc(m.dbName)}';`],
          "pre-transaction",
        );
      }
    }
    // A member kept under the same name but pointed at a new physical label
    // is an unambiguous rename — the enum analogue of a column `@map` rename.
    // Emitting nothing would leave the database holding a label the schema no
    // longer names, with no signal anywhere.
    const oldByName = new Map(oldMembers.map((m) => [m.name, m]));
    for (const m of nextMembers) {
      const before = oldByName.get(m.name);
      if (!before || before.dbName === m.dbName) continue;
      push(stmts, [
        `ALTER TYPE ${quoteIdent(e.name)} RENAME VALUE '${esc(before.dbName)}' TO '${esc(m.dbName)}';`,
      ]);
    }

    const removed = oldMembers.filter((m) => !nextNames.has(m.name)).map((m) => m.name);
    if (removed.length > 0) diagnostics.push(enumValueRemovedDiagnostic(e, removed));
  }

  // Realtime notify function, before any trigger that references it. Emitted
  // when realtime first appears; CREATE OR REPLACE makes re-emission harmless.
  const prevHasRealtime = (prev?.tables ?? []).some((t) => t.realtime);
  if (!prevHasRealtime && next.tables.some((t) => t.realtime)) {
    push(stmts, [renderNotifyFunction()]);
  }

  // Match columns and compute every table's FK drops/adds/renames up front,
  // without emitting them yet — 3a/3c below place drops/adds at the correct
  // GLOBAL position, and the column match (identity + rename map) is shared
  // between the FK pass and each table's own structure pass so both agree
  // on which columns moved.
  const matches = new Map<string, ColumnMatch>();
  const fkDrops: string[] = [];
  const fkAdds: string[] = [];
  const fkRenames: string[] = [];
  for (const table of next.tables) {
    const old = prevTables.get(table.name) ?? null;
    if (!old) {
      const { adds } = diffTableFks(null, table, new Map());
      fkAdds.push(...adds);
      continue;
    }
    const match = matchColumns(old, table);
    matches.set(table.name, match);
    const { drops, adds, renames } = diffTableFks(old, table, match.renameMap);
    fkDrops.push(...drops);
    fkAdds.push(...adds);
    fkRenames.push(...renames);
  }

  // 3a: drop every removed/redefined FK constraint first, so 3c can re-add a
  // same-named constraint without a duplicate-name failure.
  push(stmts, fkDrops);

  // 3b: new + altered table structure, FK-free.
  for (const table of next.tables) {
    const old = prevTables.get(table.name);
    push(
      stmts,
      !old ? createTable(table, next.enums) : diffTable(old, table, next.enums, diagnostics, matches.get(table.name)!),
    );
  }

  // Realign FK constraint names left stale by a column rename (unchanged
  // constraint, not part of the drop/add flow).
  push(stmts, fkRenames);

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
 * generation (ambiguous column rename, enum value removed, required column
 * without a default).
 */
export function planMigration(prev: ResolvedSchema | null, next: ResolvedSchema): MigrationPlan {
  const diagnostics: MigrationDiagnostic[] = [];
  const statements = computeStatements(prev, next, diagnostics);
  return { statements, diagnostics };
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
