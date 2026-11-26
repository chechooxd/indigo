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
  ResolvedEnumMember,
  ResolvedIndex,
  ForeignKey,
  AllowRule,
} from "@indigodb/core";
import {
  quoteIdent,
  columnSqlType,
  renderColumn,
  renderDefaultClause,
  renderDropTrigger,
  renderDropLegacyNotify,
  renderReplicationPreSql,
  renderPublicationSql,
  renderReplicaIdentity,
  renderRealtimeLogSql,
  REALTIME_LOG_TABLE,
  enumMembers,
  indexName,
  renderIndexDdl,
  renderPolicy,
  namedAllowRules,
} from "./postgres.js";
import type {
  MigrationDiagnostic,
  MigrationPhase,
  MigrationPlan,
  MigrationStatement,
} from "./plan.js";
import { NO_TRANSACTION_BEGIN, NO_TRANSACTION_END, REQUIRES_FORCE_MARKER } from "./plan.js";

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * A comment line must not be breakable by an interpolated value — `impact`
 * ultimately lands in a `-- indigo:requires-force <impact>` marker line
 * (see `renderMigrationSql`), and a raw newline or CR in there would either
 * truncate the marker or leak an extra "SQL" line into the file. Every
 * `forced()` call routes through this before the string reaches the union.
 */
function stripNewlines(impact: string): string {
  return impact.replace(/\r\n|\r|\n/g, " ");
}

/** Builds a `"safe"` statement — never destructive, applies unconditionally. */
function safe(sql: string, phase: MigrationPhase = "transaction"): MigrationStatement {
  return { sql, phase, risk: "safe" };
}

/**
 * Builds a `"requires-force"` statement with its human-readable impact.
 * Always `"transaction"` phase: no requires-force statement in this
 * taxonomy is ever pre-transaction (only enum `ADD VALUE` is, and that is
 * always safe), so `forced()` takes no phase parameter — there is nothing
 * for a future emit site to get wrong here.
 */
function forced(sql: string, impact: string): MigrationStatement {
  return { sql, phase: "transaction", risk: "requires-force", impact: stripNewlines(impact) };
}

// ─── Naming (kept stable with postgres.ts push output) ───────────────────────

function fkName(table: ResolvedTable, fk: ForeignKey): string {
  return fk.name ?? `${table.dbName}_${fk.columns.join("_")}_fkey`;
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
  /**
   * Columns matched by logical field name (pass 1) OR physical `dbName`
   * (pass 2, residuals only) — includes unchanged, renamed (`@map` moved),
   * and physical-identity-fallback pairs alike.
   */
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
 * `@map` rename), then physical `dbName` second on the residuals (a
 * logical name that diverges on both sides while the physical column is
 * the same one — e.g. an introspected `prev` whose `name` === its
 * `dbName`). Both passes push a real `{old, col}` pair so every downstream
 * diff (type/nullability/default ALTERs, unique-index toggle) still runs
 * for a pass-2 match; only the identity key differs. Residual columns
 * matched by neither key feed Rule R (see `ambiguousColumnRemapDiagnostic`).
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

  // Pass 2 — residuals only: physical `dbName` identity. A column matched
  // here already has `old.dbName === col.dbName` by construction (that is
  // the match key), so it never contributes to `renameMap` — this pairing
  // exists to preserve the column's diff-relevant identity when the logical
  // `name` diverged on both sides (e.g. an introspected `prev` whose `name`
  // === its `dbName`), not to detect a rename. Pushing the pair here closes
  // a pre-existing latent bug: previously this pass consumed both columns
  // without ever pairing them, so a column renamed AND type/nullability/
  // default-changed in the same edit silently dropped its ALTER — the
  // physical match said "same column", but nothing carried that identity
  // forward into `diffTable`'s "Changed columns" pass.
  const prevRemaining = prev.columns.filter((c) => !consumedPrev.has(c.name));
  const nextRemaining = next.columns.filter((c) => !consumedNext.has(c.name));
  const prevByDbName = new Map(prevRemaining.map((c) => [c.dbName, c]));
  for (const col of nextRemaining) {
    const old = prevByDbName.get(col.dbName);
    if (!old) continue;
    pairs.push({ old, col });
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

// ─── Table matching ──────────────────────────────────────────────────────────

interface TableMatch {
  /**
   * Tables matched by logical `name` (pass 1) OR physical `dbName` (pass 2,
   * residuals only).
   */
  pairs: { old: ResolvedTable; table: ResolvedTable }[];
  /** `next` tables matched by neither logical name nor physical `dbName`. */
  added: ResolvedTable[];
  /** `prev` tables matched by neither logical name nor physical `dbName`. */
  dropped: ResolvedTable[];
}

/**
 * Matches `prev`'s tables against `next`'s: logical `name` first, then
 * physical `dbName` second on the residuals — the table-level analogue of
 * `matchColumns`. Without the `dbName` fallback, a `prev` whose `name`
 * === `dbName` (e.g. an introspected schema) never matches a `next` table
 * declared with `@@map` under a different logical `name`: the table looks
 * dropped-and-recreated every run even though its physical identity is
 * unchanged. Consumers MUST derive table-drop detection from `dropped`
 * (a consumed set), never from `nextTables.has(name)` — the latter only
 * proves "no `next` table shares this `name`", not "no `next` table
 * matches this `prev` table at all".
 */
function matchTables(prevTables: ResolvedTable[], nextTables: ResolvedTable[]): TableMatch {
  const prevByName = new Map(prevTables.map((t) => [t.name, t]));
  const consumedPrev = new Set<string>();
  const consumedNext = new Set<string>();
  const pairs: { old: ResolvedTable; table: ResolvedTable }[] = [];

  for (const table of nextTables) {
    const old = prevByName.get(table.name);
    if (!old) continue;
    pairs.push({ old, table });
    consumedPrev.add(old.name);
    consumedNext.add(table.name);
  }

  const prevRemaining = prevTables.filter((t) => !consumedPrev.has(t.name));
  const nextRemaining = nextTables.filter((t) => !consumedNext.has(t.name));
  const prevByDbName = new Map(prevRemaining.map((t) => [t.dbName, t]));
  for (const table of nextRemaining) {
    const old = prevByDbName.get(table.dbName);
    if (!old) continue;
    pairs.push({ old, table });
    consumedPrev.add(old.name);
    consumedNext.add(table.name);
  }

  return {
    pairs,
    added: nextTables.filter((t) => !consumedNext.has(t.name)),
    dropped: prevTables.filter((t) => !consumedPrev.has(t.name)),
  };
}

// ─── Enum member matching ────────────────────────────────────────────────────

interface EnumMemberMatch {
  /**
   * Members matched by logical `name` (pass 1) OR physical `dbName`
   * (pass 2, residuals only).
   */
  pairs: { old: ResolvedEnumMember; member: ResolvedEnumMember }[];
  /** `next` members matched by neither logical name nor physical `dbName`. */
  added: ResolvedEnumMember[];
  /** `prev` members matched by neither logical name nor physical `dbName`. */
  removed: ResolvedEnumMember[];
}

/**
 * Matches an enum's `prev` members against `next`'s: logical `name` first,
 * then physical `dbName` second on the residuals — the enum-member
 * analogue of `matchColumns`/`matchTables`. Without the fallback, a
 * `@map`'d member whose logical `name` diverges from an introspected
 * `prev` (`name` === `dbName`) is reported as removed-then-added, tripping
 * the `enum-value-removed` diagnostic and blocking generation even though
 * the physical label never left the type.
 */
function matchEnumMembers(
  oldMembers: ResolvedEnumMember[],
  nextMembers: ResolvedEnumMember[],
): EnumMemberMatch {
  const oldByName = new Map(oldMembers.map((m) => [m.name, m]));
  const consumedOld = new Set<string>();
  const consumedNext = new Set<string>();
  const pairs: { old: ResolvedEnumMember; member: ResolvedEnumMember }[] = [];

  for (const m of nextMembers) {
    const old = oldByName.get(m.name);
    if (!old) continue;
    pairs.push({ old, member: m });
    consumedOld.add(old.name);
    consumedNext.add(m.name);
  }

  const oldRemaining = oldMembers.filter((m) => !consumedOld.has(m.name));
  const nextRemaining = nextMembers.filter((m) => !consumedNext.has(m.name));
  const oldByDbName = new Map(oldRemaining.map((m) => [m.dbName, m]));
  for (const m of nextRemaining) {
    const old = oldByDbName.get(m.dbName);
    if (!old) continue;
    pairs.push({ old, member: m });
    consumedOld.add(old.name);
    consumedNext.add(m.name);
  }

  return {
    pairs,
    added: nextMembers.filter((m) => !consumedNext.has(m.name)),
    removed: oldMembers.filter((m) => !consumedOld.has(m.name)),
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
    // `AllowOperand.Field.name` always carries the physical `dbName`
    // (design decision #7) — a `@map` rename on an `@@allow`-referenced
    // column must remap the rule "for free", exactly like a PK/index/FK
    // column, or `diffPolicies` would see the old rule's field name
    // disappear and the renamed column's DROP+CREATE for no real reason.
    allow: table.allow?.map((rule) => ({
      ...rule,
      left: rule.left.kind === "field" ? { ...rule.left, name: remap(rule.left.name) } : rule.left,
      right: rule.right.kind === "field" ? { ...rule.right, name: remap(rule.right.name) } : rule.right,
    })),
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
function createTable(table: ResolvedTable, enums: ResolvedEnum[]): MigrationStatement[] {
  const lines = table.columns.map((c) => `  ${renderColumn(c, enums)}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  const stmts = [safe(`CREATE TABLE ${quoteIdent(table.dbName)} (\n${lines.join(",\n")}\n);`)];
  stmts.push(...tableConstraintsNoFk(table));
  if (table.realtime) stmts.push(safe(renderReplicaIdentity(table)));
  // Row-Level Security (@@allow), brand-new table: no prior policies can
  // exist, so no DROP/prune is needed — just ENABLE+FORCE and one CREATE
  // POLICY per rule, same ordinal/name formula `renderRlsBlock` uses.
  if (table.allow && table.allow.length > 0) {
    stmts.push(safe(`ALTER TABLE ${quoteIdent(table.dbName)} ENABLE ROW LEVEL SECURITY;`));
    stmts.push(safe(`ALTER TABLE ${quoteIdent(table.dbName)} FORCE ROW LEVEL SECURITY;`));
    for (const { rule, ordinal } of namedAllowRules(table)) {
      stmts.push(safe(renderPolicy(table, rule, ordinal)));
    }
  }
  return stmts;
}

function tableConstraintsNoFk(table: ResolvedTable): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];
  for (const col of table.columns) {
    if (col.unique) stmts.push(safe(createUniqueColIndex(table, col)));
  }
  for (const index of table.indexes) stmts.push(safe(createIndex(table, index)));
  return stmts;
}

function createUniqueColIndex(table: ResolvedTable, col: ResolvedColumn): string {
  return `CREATE UNIQUE INDEX ${quoteIdent(uniqueColIndexName(table, col))} ON ${quoteIdent(table.dbName)} (${quoteIdent(col.dbName)});`;
}

/** Delegates to `postgres.ts`'s shared renderer (design decision #9) — never
 * re-derives `USING <method>`/naming independently, or the two DDL paths
 * (push vs. migrate) would drift apart. `migrate.ts` never wants `IF NOT
 * EXISTS`: it emits exact, ordered DDL for a versioned migration file. */
function createIndex(table: ResolvedTable, index: ResolvedIndex): string {
  return renderIndexDdl(table, index);
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
    list: col.list ?? false,
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
): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];
  const t = quoteIdent(table.dbName);
  const c = quoteIdent(next.dbName);

  if (prev.type !== next.type || (prev.list ?? false) !== (next.list ?? false)) {
    const nextPgType = columnSqlType(next);
    const prevLabel = `${prev.type}${prev.list ? "[]" : ""}`;
    const nextLabel = `${next.type}${next.list ? "[]" : ""}`;
    stmts.push(
      forced(
        `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${nextPgType} USING ${c}::${nextPgType};`,
        `ALTER COLUMN TYPE ${table.name}.${next.name} (${prevLabel} → ${nextLabel})`,
      ),
    );
  }
  if (prev.nullable !== next.nullable) {
    // `DROP NOT NULL` never fails and never loses data: it stays safe.
    // `SET NOT NULL` fails outright against any row already holding NULL —
    // requires-force. The two branches must not share one ternary push, or
    // a future edit to one risks silently mis-tagging the other.
    stmts.push(
      next.nullable
        ? safe(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL;`)
        : forced(
            `ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL;`,
            `SET NOT NULL ${table.name}.${next.name}`,
          ),
    );
  }
  const prevDefault = renderDefaultClause(prev, enums);
  const nextDefault = renderDefaultClause(next, enums);
  if (prevDefault !== nextDefault) {
    stmts.push(
      safe(
        nextDefault
          ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${nextDefault};`
          : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`,
      ),
    );
  }
  return stmts;
}

// ─── Constraint signatures ───────────────────────────────────────────────────

/**
 * Two-pass index diff key (design decision #8), replacing the old single-key
 * `indexSignature` (columns + uniqueness only) that treated a name-only or
 * method-only change as "unchanged".
 *
 * Pass 1 — `indexKey`: FULL identity (columns + uniqueness + explicit
 * `name`, `""` when absent). A same-key match means the index is either
 * unchanged, drifted only on its AUTO-DERIVED name (handled the same way
 * as before — an `ALTER INDEX RENAME`), or had its `type` change (handled
 * as a `DROP`+`CREATE`, since PostgreSQL cannot `ALTER` an index's access
 * method).
 *
 * Pass 2 — residuals only (`indexShape`/`indexDefinition`): pairs an
 * unmatched prev/next index by shape (columns + uniqueness) ONLY when
 * exactly one residual remains per side, mirroring `matchColumns`'s
 * conservatism (never guesses among multiple same-shape candidates). A
 * shape-only match is a pure rename (`ALTER INDEX RENAME`); a shape match
 * whose `type` also differs is a single combined `DROP`+`CREATE` (never two
 * separate statements). An unpaired residual is a genuine add or drop.
 */
function indexKey(index: ResolvedIndex): string {
  return `${index.unique ? "u" : "i"}:${index.columns.join(",")}:${index.expression ?? ""}:${index.name ?? ""}`;
}

function indexShape(index: ResolvedIndex): string {
  return `${index.unique ? "u" : "i"}:${index.columns.join(",")}:${index.expression ?? ""}`;
}

/** Strips a single balanced outer `(...)` wrapper when PostgreSQL's `pg_get_expr` adds one (e.g. `(deleted_at IS NULL)` vs `deleted_at IS NULL`). */
function stripOuterParens(expr: string): string {
  const s = expr.trim();
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  return depth === 0 ? s.slice(1, -1).trim() : s;
}

function indexDefinition(index: ResolvedIndex): string {
  const where = index.where ? stripOuterParens(index.where) : "";
  return `${indexShape(index)}|${index.type ?? ""}|${where}`;
}

function groupByShape(indexes: ResolvedIndex[]): Map<string, ResolvedIndex[]> {
  const groups = new Map<string, ResolvedIndex[]>();
  for (const idx of indexes) {
    const shape = indexShape(idx);
    const group = groups.get(shape);
    if (group) group.push(idx);
    else groups.set(shape, [idx]);
  }
  return groups;
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
): { drops: MigrationStatement[]; adds: MigrationStatement[]; renames: MigrationStatement[] } {
  if (!prevOriginal) {
    return { drops: [], adds: next.foreignKeys.map((fk) => safe(addForeignKey(next, fk))), renames: [] };
  }

  const prev = remapPhysicalNames(prevOriginal, renameMap);
  const drops: MigrationStatement[] = [];
  const adds: MigrationStatement[] = [];
  const renames: MigrationStatement[] = [];
  const origBySig = new Map(prev.foreignKeys.map((fk, i) => [fkSignature(fk), prevOriginal.foreignKeys[i]]));
  const prevFk = new Map(prev.foreignKeys.map((f) => [fkSignature(f), f]));
  const nextFk = new Map(next.foreignKeys.map((f) => [fkSignature(f), f]));

  for (const [sig, fk] of nextFk) {
    const old = prevFk.get(sig);
    if (!old || fkDefinition(old) !== fkDefinition(fk)) {
      adds.push(safe(addForeignKey(next, fk)));
      continue;
    }
    if (!fk.name) {
      const original = origBySig.get(sig);
      if (original) {
        const oldName = fkName(prevOriginal, original);
        const newName = fkName(next, fk);
        if (oldName !== newName) {
          renames.push(
            safe(
              `ALTER TABLE ${quoteIdent(next.dbName)} RENAME CONSTRAINT ${quoteIdent(oldName)} TO ${quoteIdent(newName)};`,
            ),
          );
        }
      }
    }
  }
  for (const [sig, fk] of prevFk) {
    const current = nextFk.get(sig);
    if (!current || fkDefinition(current) !== fkDefinition(fk)) {
      const original = origBySig.get(sig) ?? fk;
      drops.push(
        forced(
          dropForeignKey(next, original),
          `DROP CONSTRAINT ${next.name}.${fkName(next, original)}`,
        ),
      );
    }
  }

  return { drops, adds, renames };
}

// ─── Row-Level Security policy diff (@@allow, design decision #14) ──────────

/**
 * Diffs one EXISTING table's `@@allow` policies against its previous state
 * (`prev` already remapped through `remapPhysicalNames`, so a `@map`
 * rename on the owner column is invisible to this diff — decision #7/#14).
 * Unlike `renderRlsBlock`'s idempotent `db push` path, this is EXACT,
 * ordered DDL from two fully-known schema states, so it never needs a
 * runtime `pg_policies` catalog query or prune loop (decision #14): a
 * policy present in `prev` but not in `next` is a plain `DROP POLICY IF
 * EXISTS`; one present in `next` but not in `prev`, or present in both
 * under the SAME name with a DIFFERENT rendered definition, is a plain
 * `CREATE POLICY`.
 *
 * Rules are matched by their derived `policyName` (design decision #11),
 * which already encodes `(table, action, ordinal)` — so a reordered rule
 * list (same conditions, new positions) is correctly seen as a rename-free
 * DROP+CREATE pair under the ordinals' new names, and an action change
 * (`read` -> `update`) is correctly seen as one policy disappearing and a
 * different one appearing, never an in-place ALTER (Postgres has no `ALTER
 * POLICY ... FOR <action>`).
 *
 * No policy statement here ever destroys row data — adding a policy widens
 * access, dropping one (with RLS still `FORCE`d) narrows it, the safe
 * direction (design decision #14) — so every statement is `safe()`.
 */
function diffPolicies(prev: ResolvedTable, next: ResolvedTable): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];
  const prevNamed = namedAllowRules(prev);
  const nextNamed = namedAllowRules(next);
  const prevHadRules = prevNamed.length > 0;
  const nextHasRules = nextNamed.length > 0;

  // First enablement: this table had no `@@allow` at all, and now does.
  if (!prevHadRules && nextHasRules) {
    stmts.push(safe(`ALTER TABLE ${quoteIdent(next.dbName)} ENABLE ROW LEVEL SECURITY;`));
    stmts.push(safe(`ALTER TABLE ${quoteIdent(next.dbName)} FORCE ROW LEVEL SECURITY;`));
  }

  const prevByName = new Map(prevNamed.map((n) => [n.name, n]));
  const nextByName = new Map(nextNamed.map((n) => [n.name, n]));

  // Removed or redefined policies (present in prev, gone or changed in next)
  // — dropped BEFORE any same-named re-create, so a changed condition never
  // collides with its own stale definition.
  for (const { name, rule, ordinal } of prevNamed) {
    const current = nextByName.get(name);
    const unchanged = current && renderPolicy(next, current.rule, current.ordinal) === renderPolicy(prev, rule, ordinal);
    if (!unchanged) {
      stmts.push(safe(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${quoteIdent(next.dbName)};`));
    }
  }

  // Added or redefined policies (present in next, absent or changed vs prev).
  for (const { name, rule, ordinal } of nextNamed) {
    const before = prevByName.get(name);
    const unchanged = before && renderPolicy(next, rule, ordinal) === renderPolicy(prev, before.rule, before.ordinal);
    if (!unchanged) {
      stmts.push(safe(renderPolicy(next, rule, ordinal)));
    }
  }

  // Full disablement: this table had `@@allow` and now has none.
  if (prevHadRules && !nextHasRules) {
    stmts.push(safe(`ALTER TABLE ${quoteIdent(next.dbName)} DISABLE ROW LEVEL SECURITY;`));
    stmts.push(safe(`ALTER TABLE ${quoteIdent(next.dbName)} NO FORCE ROW LEVEL SECURITY;`));
  }

  return stmts;
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
): MigrationStatement[] {
  const stmts: MigrationStatement[] = [];
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
        safe(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(old.dbName)} TO ${quoteIdent(col.dbName)};`),
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
      stmts.push(safe(`ALTER TABLE ${t} ADD COLUMN ${renderColumn(col, enums)};`));
      if (col.unique) stmts.push(safe(createUniqueColIndex(next, col)));
    }
    // Dropped columns (residual — no match by either key).
    for (const col of match.dropped) {
      stmts.push(
        forced(
          `ALTER TABLE ${t} DROP COLUMN ${quoteIdent(col.dbName)};`,
          `DROP COLUMN ${next.name}.${col.name}`,
        ),
      );
    }
  }

  // Changed columns (matched by logical field name).
  for (const { old, col } of match.pairs) {
    if (columnSignature(old, enums) !== columnSignature(col, enums)) {
      stmts.push(...alterColumn(next, old, col, enums));
    }
    if (old.unique !== col.unique) {
      // Dropping a unique index only relaxes a constraint — it destroys no
      // row data, so it stays safe (taxonomy edge case, same reasoning as
      // every other `DROP INDEX` below).
      stmts.push(
        col.unique
          ? safe(createUniqueColIndex(next, col))
          : safe(`DROP INDEX ${quoteIdent(uniqueColIndexName(next, col))};`),
      );
    } else if (col.unique && old.dbName !== col.dbName) {
      // Renamed column keeps its single-column unique index — the
      // auto-derived name embeds the column's dbName, so realign it.
      const oldName = uniqueColIndexName(prevOriginal, old);
      const newName = uniqueColIndexName(next, col);
      if (oldName !== newName) stmts.push(safe(`ALTER INDEX ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)};`));
    }
  }

  // Primary key change: no data movement, drop and recreate the constraint.
  // KNOWN LIMITATION: assumes PostgreSQL's default `<table>_pkey` naming —
  // what an inline `PRIMARY KEY (...)` in `CREATE TABLE` produces. A
  // hand-named PK constraint would not be found by this DROP.
  if (JSON.stringify(prev.primaryKey) !== JSON.stringify(next.primaryKey)) {
    const pkConstraint = `${prevOriginal.dbName}_pkey`;
    stmts.push(
      forced(
        `ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(pkConstraint)};`,
        `DROP PRIMARY KEY ${next.name} (${pkConstraint})`,
      ),
    );
    stmts.push(safe(`ALTER TABLE ${t} ADD PRIMARY KEY (${next.primaryKey.map(quoteIdent).join(", ")});`));
  }

  // Indexes (against the remapped `prev`, so an unchanged index covering a
  // renamed column is not reported as dropped-and-recreated). See
  // `indexKey`/`indexShape`/`indexDefinition` above for the two-pass matcher.
  const prevIdxByKey = new Map(prev.indexes.map((i) => [indexKey(i), i]));
  const nextIdxByKey = new Map(next.indexes.map((i) => [indexKey(i), i]));
  const origIdxByKey = new Map(prev.indexes.map((i, n) => [indexKey(i), prevOriginal.indexes[n]]));

  // Pass 1: full-identity match (columns + uniqueness + explicit name).
  const consumedPrevKeys = new Set<string>();
  const consumedNextKeys = new Set<string>();
  for (const [key, index] of nextIdxByKey) {
    const old = prevIdxByKey.get(key);
    if (!old) continue;
    consumedPrevKeys.add(key);
    consumedNextKeys.add(key);
    if (indexDefinition(old) !== indexDefinition(index)) {
      // Same identity, `type` changed: PostgreSQL cannot ALTER an index's
      // access method — drop and recreate under the new one. DROP INDEX
      // drops no row data (taxonomy edge case): stays safe.
      const original = origIdxByKey.get(key) ?? old;
      stmts.push(safe(`DROP INDEX ${quoteIdent(indexName(prevOriginal, original))};`));
      stmts.push(safe(createIndex(next, index)));
      continue;
    }
    if (!index.name) {
      const original = origIdxByKey.get(key);
      if (original) {
        const oldName = indexName(prevOriginal, original);
        const newName = indexName(next, index);
        if (oldName !== newName) stmts.push(safe(`ALTER INDEX ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)};`));
      }
    }
  }

  // Pass 2: residuals — pair by shape ONLY when exactly one residual remains
  // per side (matchColumns-style conservatism); anything left unpaired is a
  // genuine add or drop.
  const prevResidual = prev.indexes.filter((i) => !consumedPrevKeys.has(indexKey(i)));
  const nextResidual = next.indexes.filter((i) => !consumedNextKeys.has(indexKey(i)));
  const prevByShape = groupByShape(prevResidual);
  const nextByShape = groupByShape(nextResidual);
  const pairedPrevKeys = new Set<string>();
  const pairedNextKeys = new Set<string>();

  for (const [shape, prevGroup] of prevByShape) {
    const nextGroup = nextByShape.get(shape);
    if (!nextGroup || prevGroup.length !== 1 || nextGroup.length !== 1) continue;
    const oldResidual = prevGroup[0];
    const newResidual = nextGroup[0];
    pairedPrevKeys.add(indexKey(oldResidual));
    pairedNextKeys.add(indexKey(newResidual));
    const original = origIdxByKey.get(indexKey(oldResidual)) ?? oldResidual;
    const oldName = indexName(prevOriginal, original);
    const newName = indexName(next, newResidual);
    if (indexDefinition(oldResidual) === indexDefinition(newResidual)) {
      // Shape and method identical, only the name differs: pure rename.
      if (oldName !== newName) stmts.push(safe(`ALTER INDEX ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)};`));
    } else {
      // Name and/or method differ: a single combined DROP+CREATE, never two
      // separate statements.
      stmts.push(safe(`DROP INDEX ${quoteIdent(oldName)};`));
      stmts.push(safe(createIndex(next, newResidual)));
    }
  }

  // Drop removed indexes BEFORE creating added ones so a same-named
  // unpaired replacement never collides with `relation "..." already exists`.
  for (const idx of prevResidual) {
    if (!pairedPrevKeys.has(indexKey(idx))) {
      const original = origIdxByKey.get(indexKey(idx)) ?? idx;
      stmts.push(safe(`DROP INDEX ${quoteIdent(indexName(prevOriginal, original))};`));
    }
  }
  for (const idx of nextResidual) {
    if (!pairedNextKeys.has(indexKey(idx))) stmts.push(safe(createIndex(next, idx)));
  }

  // Realtime toggled (@@realtime added or removed): REPLICA IDENTITY follows
  // suit. Publication membership and legacy-trigger retirement are handled
  // once, globally, in `computeStatements` (never per-table here) — the
  // publication statement needs the FULL next-state table list, and legacy
  // retirement runs whenever ANY table touches realtime, not just this one.
  if ((prev.realtime ?? false) !== (next.realtime ?? false)) {
    stmts.push(safe(renderReplicaIdentity(next)));
  }

  // Row-Level Security policies (@@allow added/removed/changed). `prev` is
  // already remapped (this function's own `remapPhysicalNames` call above),
  // so an `@map` rename on an `@@allow`-referenced column never looks like
  // an unrelated policy change.
  stmts.push(...diffPolicies(prev, next));

  return stmts;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function push(stmts: MigrationStatement[], sqls: string[], phase: MigrationPhase = "transaction"): void {
  for (const sql of sqls) stmts.push({ sql, phase, risk: "safe" });
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
  const tableMatch = matchTables(prev?.tables ?? [], next.tables);
  const oldTableByNextName = new Map(tableMatch.pairs.map((p) => [p.table.name, p.old]));

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
    const memberMatch = matchEnumMembers(oldMembers, nextMembers);

    for (const m of memberMatch.added) {
      push(
        stmts,
        [`ALTER TYPE ${quoteIdent(e.name)} ADD VALUE IF NOT EXISTS '${esc(m.dbName)}';`],
        "pre-transaction",
      );
    }
    // A member kept under the same name but pointed at a new physical label
    // is an unambiguous rename — the enum analogue of a column `@map` rename.
    // Emitting nothing would leave the database holding a label the schema no
    // longer names, with no signal anywhere. A pass-2 (physical-identity)
    // pair always has `before.dbName === m.dbName` by construction, so it
    // never reaches here.
    for (const { old: before, member: m } of memberMatch.pairs) {
      if (before.dbName === m.dbName) continue;
      push(stmts, [
        `ALTER TYPE ${quoteIdent(e.name)} RENAME VALUE '${esc(before.dbName)}' TO '${esc(m.dbName)}';`,
      ]);
    }

    if (memberMatch.removed.length > 0) {
      diagnostics.push(enumValueRemovedDiagnostic(e, memberMatch.removed.map((m) => m.name)));
    }
  }

  // Realtime replication (@@realtime → WAL logical replication, design
  // decisions 1-8). Every statement below is keyed off an ACTUAL change —
  // never "any realtime table exists" — so `planMigration(introspected,
  // next)` stays a true no-op when nothing changed (the introspection
  // round-trip invariant `introspect.mjs` enforces). This still converges a
  // notify-era database on its first post-upgrade migration WITHOUT needing
  // an unconditional re-emit: shadow-replay reconstructs `prev` by replaying
  // OLD (pre-this-PR) migration files, whose trigger-based DDL never created
  // a publication — so `introspectResolvedSchema` (now publication-based,
  // `introspect.ts`) reports `realtime: false` for such a table regardless
  // of its actual on-disk trigger, making it look "newly realtime" the
  // moment this migrator diffs it, which is exactly the condition that
  // fires legacy retirement below.
  //
  // Slot lifecycle (pre-transaction) cares only about the 0↔1+ boundary.
  // Publication membership and legacy retirement care about which TABLES
  // moved, not just the boolean — adding a second `@@realtime` table to an
  // already-realtime schema must still update `SET TABLE` and drop only
  // the NEW table's legacy trigger, with no slot statement at all (the slot
  // already exists). Publication membership is placed AFTER every table
  // exists (3c, below) since `SET TABLE` names physical tables.
  const prevRealtimeTables = (prev?.tables ?? []).filter((t) => t.realtime);
  const nextRealtimeTables = next.tables.filter((t) => t.realtime);
  const prevRealtimeNames = new Set(prevRealtimeTables.map((t) => t.dbName));
  const nextRealtimeNames = new Set(nextRealtimeTables.map((t) => t.dbName));
  const prevHasRealtime = prevRealtimeNames.size > 0;
  const nextHasRealtime = nextRealtimeNames.size > 0;
  const membershipChanged =
    prevRealtimeNames.size !== nextRealtimeNames.size ||
    [...nextRealtimeNames].some((n) => !prevRealtimeNames.has(n));
  // Tables becoming realtime THIS diff (absent from `prevRealtimeNames`) —
  // the only ones that can still be carrying a legacy v1 trigger no earlier
  // migration would have dropped.
  const newlyRealtimeTables = nextRealtimeTables.filter((t) => !prevRealtimeNames.has(t.dbName));

  if (prevHasRealtime !== nextHasRealtime) {
    push(stmts, renderReplicationPreSql(next), "pre-transaction");
  }
  if (membershipChanged) {
    for (const t of newlyRealtimeTables) push(stmts, [renderDropTrigger(t)]);
    if (newlyRealtimeTables.length > 0) push(stmts, [renderDropLegacyNotify()]);
  }

  // `_indigo_realtime_log` (realtime-shape-log design decisions 4/13): keyed
  // off the SAME 0<->1+ boundary as the slot above, so a second/third
  // `@@realtime` table added while the log already exists causes no DDL
  // churn (`membershipChanged` alone would fire on every table added or
  // removed — the log's own lifecycle only cares whether ANY table is
  // realtime, exactly like the slot). Create is `safe` (additive,
  // idempotent `IF NOT EXISTS`); drop is `forced(...)`, not `safe()` —
  // dropping the log destroys realtime history, the same data-loss gate
  // `DROP TABLE` already goes through elsewhere in this file.
  if (prevHasRealtime !== nextHasRealtime) {
    if (nextHasRealtime) {
      push(stmts, renderRealtimeLogSql(next));
    } else {
      const [dropSql] = renderRealtimeLogSql(next);
      stmts.push(
        forced(dropSql, `DROP TABLE ${REALTIME_LOG_TABLE} (realtime shape log history)`),
      );
    }
  }

  // Match columns and compute every table's FK drops/adds/renames up front,
  // without emitting them yet — 3a/3c below place drops/adds at the correct
  // GLOBAL position, and the column match (identity + rename map) is shared
  // between the FK pass and each table's own structure pass so both agree
  // on which columns moved.
  const matches = new Map<string, ColumnMatch>();
  const fkDrops: MigrationStatement[] = [];
  const fkAdds: MigrationStatement[] = [];
  const fkRenames: MigrationStatement[] = [];
  for (const table of next.tables) {
    const old = oldTableByNextName.get(table.name) ?? null;
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
  stmts.push(...fkDrops);

  // 3b: new + altered table structure, FK-free.
  for (const table of next.tables) {
    const old = oldTableByNextName.get(table.name);
    stmts.push(
      ...(!old
        ? createTable(table, next.enums)
        : diffTable(old, table, next.enums, diagnostics, matches.get(table.name)!)),
    );
  }

  // Realign FK constraint names left stale by a column rename (unchanged
  // constraint, not part of the drop/add flow).
  stmts.push(...fkRenames);

  // 3c: add every new/redefined FK constraint, once every table exists.
  stmts.push(...fkAdds);

  // Publication membership: declarative `SET TABLE <next realtime tables>`
  // (or `DROP PUBLICATION IF EXISTS` when empty) — placed here, not in the
  // realtime preamble above, because every `next.tables` member it could
  // name must already physically exist (created in 3b), and none of them
  // are among the tables about to be DROPped below (disjoint by
  // construction — `tableMatch.dropped` never overlaps `next.tables`).
  if (membershipChanged) {
    push(stmts, renderPublicationSql(next));
  }

  // Dropped tables (after alters so dependent FKs are handled by CASCADE).
  // Uses `tableMatch.dropped` (a consumed set from `matchTables`), never
  // `nextTables.has(name)` — the latter only proves no `next` table shares
  // this table's `name`, not that no `next` table matched it at all (a
  // physical-`dbName` fallback match would still be missed).
  for (const table of tableMatch.dropped) {
    stmts.push(
      forced(`DROP TABLE ${quoteIdent(table.dbName)} CASCADE;`, `DROP TABLE ${table.name}`),
    );
  }

  // Dropped enums last (tables referencing them are already gone/altered).
  // PostgreSQL refuses `DROP TYPE` while anything still references it — a
  // fail-safe: any real data loss already happened via a co-emitted
  // DROP TABLE/DROP COLUMN/type-change ALTER, so this stays safe.
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

/**
 * Wraps a migration plan's statements into a migration file body. A
 * `"requires-force"` statement gets a `-- indigo:requires-force <impact>`
 * comment line directly above its SQL — the ONLY carrier that reaches
 * `migrate deploy` (see `REQUIRES_FORCE_MARKER` in `plan.ts`). No
 * requires-force statement is ever `"pre-transaction"` (only enum
 * `ADD VALUE` is, and that is always safe), so the two taggings never
 * interact.
 */
export function renderMigrationSql(plan: MigrationPlan): string {
  if (plan.statements.length === 0) return "";
  const blocks = plan.statements.map((stmt) => {
    const sql = stmt.risk === "requires-force" ? `${REQUIRES_FORCE_MARKER}${stmt.impact}\n${stmt.sql}` : stmt.sql;
    return stmt.phase === "pre-transaction" ? [NO_TRANSACTION_BEGIN, sql, NO_TRANSACTION_END].join("\n") : sql;
  });
  return `-- Generated by IndigoDB migrate (PostgreSQL)\n\n${blocks.join("\n\n")}\n`;
}
