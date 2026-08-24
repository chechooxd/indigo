/**
 * @indigodb/migrator — PostgreSQL dialect
 *
 * Renders idempotent DDL from a `ResolvedSchema` for the MVP `db push` flow
 * (Prisma-style schema sync, no migration history). Every statement is written
 * to be safely re-runnable: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
 * EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, and guarded `DO $$ ... $$`
 * blocks for enum types and foreign keys (which lack an `IF NOT EXISTS` form).
 */

import type {
  ResolvedSchema,
  ResolvedTable,
  ResolvedColumn,
  ResolvedDefault,
  ResolvedEnum,
  ResolvedEnumMember,
  ForeignKey,
  ResolvedIndex,
  AllowRule,
  AllowOperand,
} from "@indigodb/core";

/** A member's schema name plus the PostgreSQL label it must render as; falls
 * back to `values` (name === dbName) for `.snapshot.json` files written
 * before `members` existed. */
export function enumMembers(e: ResolvedEnum): ResolvedEnumMember[] {
  return e.members ?? e.values.map((v) => ({ name: v, dbName: v }));
}

/** Looks up the PostgreSQL label for one enum member by its logical name. */
function enumDbName(enums: ResolvedEnum[], enumName: string, memberName: string): string {
  const e = enums.find((x) => x.name === enumName);
  const member = e && enumMembers(e).find((m) => m.name === memberName);
  return member ? member.dbName : memberName;
}

/** Maps an IndigoDB scalar type to a PostgreSQL column type. */
export function mapScalarToPg(indigoType: string): string {
  switch (indigoType) {
    case "String":
      return "text";
    case "Int":
      return "integer";
    case "BigInt":
      return "bigint";
    case "Float":
      return "double precision";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "timestamptz";
    case "Json":
      return "jsonb";
    case "Decimal":
      return "numeric";
    case "Bytes":
      return "bytea";
    default:
      // Enum types are emitted as named Postgres enums; reference by name.
      return quoteIdent(indigoType);
  }
}

/** Double-quotes an identifier, preserving case (PascalCase table names). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Renders a SQL default clause fragment (without the leading DEFAULT
 * keyword). `enums` resolves an enum literal default to its PostgreSQL
 * label (`dbName`) — omitting it would cast using the LOGICAL member name,
 * which fails at apply time once that member carries an explicit `@map`.
 */
function renderDefault(def: ResolvedDefault, column: ResolvedColumn, enums: ResolvedEnum[]): string | undefined {
  if (def.kind === "function") {
    switch (def.name) {
      case "now":
        return "now()";
      case "uuid":
        return "gen_random_uuid()";
      case "autoincrement":
        return undefined; // handled via IDENTITY
      case "cuid":
        return undefined; // generated app-side; no SQL default
      default:
        return `${def.name}()`;
    }
  }
  // Literal value.
  const v = def.value;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // strings and enum members are quoted; enum members cast to the enum type
  // using their PostgreSQL label, not their logical schema name.
  if (column.isEnum) {
    const label = enumDbName(enums, column.type, String(v));
    return `'${escapeLiteral(label)}'::${quoteIdent(column.type)}`;
  }
  return `'${escapeLiteral(v)}'`;
}

function escapeLiteral(v: string | number | boolean): string {
  return String(v).replace(/'/g, "''");
}

/**
 * Renders a column's DEFAULT fragment (without the `DEFAULT` keyword), or
 * undefined when there is no SQL default (e.g. autoincrement/cuid). Reused by
 * the migration engine for `ALTER COLUMN ... SET DEFAULT`. `enums` defaults
 * to `[]` for callers with no enum default in play.
 */
export function renderDefaultClause(column: ResolvedColumn, enums: ResolvedEnum[] = []): string | undefined {
  if (!column.default || column.autoincrement) return undefined;
  return renderDefault(column.default, column, enums);
}

/**
 * Renders a `@db.X(...)` native type override to its PostgreSQL spelling
 * (`VarChar({args:["255"]})` -> `VARCHAR(255)`, `Uuid` -> `UUID`, bare name
 * with no parens when `args` is empty).
 */
function renderNativeType(n: NonNullable<ResolvedColumn["nativeType"]>): string {
  const sql = { VarChar: "VARCHAR", Uuid: "UUID", Numeric: "NUMERIC" }[n.name];
  return n.args.length ? `${sql}(${n.args.join(",")})` : sql!;
}

/**
 * A column's PostgreSQL SQL type, WITHOUT `NOT NULL`/`DEFAULT` — the exact
 * type-selection branch of `renderColumn` (autoincrement IDENTITY base wins,
 * then `@db.X` native override, then `mapScalarToPg`), extracted so
 * `renderPolicy` (RLS, design decision #8) can derive a cast that can never
 * disagree with the column's own DDL. `@indigodb/migrator`'s
 * `diffPolicies` (`migrate.ts`) reuses this exact function for the same
 * reason.
 */
export function columnSqlType(column: ResolvedColumn): string {
  if (column.autoincrement) {
    return column.type === "BigInt" ? "bigint" : "integer";
  }
  if (column.nativeType) return renderNativeType(column.nativeType);
  return mapScalarToPg(column.type);
}

/** Renders a single column definition line inside CREATE TABLE. */
export function renderColumn(column: ResolvedColumn, enums: ResolvedEnum[] = []): string {
  const parts = [quoteIdent(column.dbName)];

  if (column.autoincrement) {
    // IDENTITY wins over any `nativeType` override — an autoincrement
    // column's physical type is dictated by the IDENTITY clause, not a
    // `@db.X` override (design's explicit ordering requirement).
    const base = column.type === "BigInt" ? "bigint" : "integer";
    parts.push(`${base} GENERATED BY DEFAULT AS IDENTITY`);
  } else if (column.nativeType) {
    parts.push(renderNativeType(column.nativeType));
  } else {
    parts.push(mapScalarToPg(column.type));
  }

  if (!column.nullable) parts.push("NOT NULL");

  if (column.default && !column.autoincrement) {
    const clause = renderDefault(column.default, column, enums);
    if (clause) parts.push(`DEFAULT ${clause}`);
  }

  return parts.join(" ");
}

/**
 * The physical name an index resolves to: the explicit `name:` argument
 * verbatim, or the auto-derived `${table}_${cols}_${suffix}` formula
 * (`_key` for a UNIQUE index, `_idx` otherwise) when omitted. Shared by
 * `renderIndexDdl` (below) and `migrate.ts` (design decision #9) so the two
 * DDL paths can never drift apart on naming.
 */
export function indexName(table: ResolvedTable, index: ResolvedIndex): string {
  const suffix = index.unique ? "key" : "idx";
  return index.name ?? `${table.dbName}_${index.columns.join("_")}_${suffix}`;
}

/**
 * Renders one `CREATE [UNIQUE] INDEX [IF NOT EXISTS] "name" ON "table"
 * [USING method] (cols);` statement. `USING <method>` is omitted entirely
 * when `index.type` is absent — this keeps every pre-existing unnamed/
 * untyped index's DDL byte-for-byte identical to before this change
 * (design's Interfaces section).
 */
export function renderIndexDdl(
  table: ResolvedTable,
  index: ResolvedIndex,
  options: { ifNotExists?: boolean } = {},
): string {
  const kind = index.unique ? "UNIQUE INDEX" : "INDEX";
  const ifNotExists = options.ifNotExists ? " IF NOT EXISTS" : "";
  const cols = index.columns.map(quoteIdent).join(", ");
  // Postgres syntax: `USING method` sits between the table and the column
  // list — AFTER the column list is a syntax error.
  const using = index.type ? ` USING ${index.type}` : "";
  return `CREATE ${kind}${ifNotExists} ${quoteIdent(indexName(table, index))} ON ${quoteIdent(table.dbName)}${using} (${cols});`;
}

/** Renders the `CREATE TABLE IF NOT EXISTS` for a table (columns + PK). */
function renderCreateTable(table: ResolvedTable, enums: ResolvedEnum[]): string {
  const lines = table.columns.map((c) => `  ${renderColumn(c, enums)}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.dbName)} (\n${lines.join(",\n")}\n);`;
}

/** Additive `ADD COLUMN IF NOT EXISTS` for schema evolution on existing tables. */
function renderAddColumns(table: ResolvedTable, enums: ResolvedEnum[]): string[] {
  return table.columns
    .filter((c) => !c.isPk) // PK columns come from the initial CREATE
    .map(
      (c) =>
        `ALTER TABLE ${quoteIdent(table.dbName)} ADD COLUMN IF NOT EXISTS ${renderColumn(c, enums)};`,
    );
}

/** Renders a guarded foreign-key constraint (idempotent via DO block). */
function renderForeignKey(table: ResolvedTable, fk: ForeignKey): string {
  const name =
    fk.name ?? `${table.dbName}_${fk.columns.join("_")}_fkey`;
  const cols = fk.columns.map(quoteIdent).join(", ");
  const refCols = fk.refColumns.map(quoteIdent).join(", ");
  const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
  const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : "";
  return [
    "DO $$ BEGIN",
    `  ALTER TABLE ${quoteIdent(table.dbName)} ADD CONSTRAINT ${quoteIdent(name)}`,
    `    FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(fk.refTable)} (${refCols})${onDelete}${onUpdate};`,
    "EXCEPTION WHEN duplicate_object THEN null; END $$;",
  ].join("\n");
}

/** Renders a guarded `CREATE TYPE ... AS ENUM`, one PostgreSQL label per member. */
function renderEnum(e: ResolvedEnum): string {
  const vals = enumMembers(e).map((m) => `'${escapeLiteral(m.dbName)}'`).join(", ");
  return [
    "DO $$ BEGIN",
    `  CREATE TYPE ${quoteIdent(e.name)} AS ENUM (${vals});`,
    "EXCEPTION WHEN duplicate_object THEN null; END $$;",
  ].join("\n");
}

// ─── Realtime (@@realtime → pg_notify triggers) ──────────────────────────────

/** NOTIFY channel every realtime trigger publishes to. */
export const REALTIME_CHANNEL = "indigo_events";

/** Stable trigger name for a realtime table (kept in sync with migrate.ts). */
export function triggerName(table: ResolvedTable): string {
  return `indigo_rt_${table.dbName}`;
}

/**
 * Generic row-change notify function shared by every `@@realtime` trigger.
 * PK columns arrive via TG_ARGV; payloads over NOTIFY's 8000-byte limit degrade
 * to a keyed notification (`partial: true`) so the client can refetch by PK.
 */
export function renderNotifyFunction(): string {
  return `CREATE OR REPLACE FUNCTION indigo_notify_trigger() RETURNS trigger AS $indigo$
DECLARE
  payload jsonb;
  pk jsonb := '{}'::jsonb;
  rec jsonb;
  col text;
BEGIN
  rec := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  FOREACH col IN ARRAY TG_ARGV LOOP
    pk := pk || jsonb_build_object(col, rec -> col);
  END LOOP;
  payload := jsonb_build_object(
    'table', TG_TABLE_NAME,
    'op',    TG_OP,
    'pk',    pk,
    'txid',  txid_current()::text,
    'ts',    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'new',   CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END,
    'old',   CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END
  );
  IF octet_length(payload::text) > 7800 THEN
    payload := (payload - 'new' - 'old') || jsonb_build_object('partial', true);
  END IF;
  PERFORM pg_notify('${REALTIME_CHANNEL}', payload::text);
  RETURN NULL;
END;
$indigo$ LANGUAGE plpgsql;`;
}

/** DROP+CREATE trigger pair (idempotent without requiring PG14's OR REPLACE). */
export function renderCreateTrigger(table: ResolvedTable): string {
  const args = table.primaryKey.map((c) => `'${escapeLiteral(c)}'`).join(", ");
  return [
    renderDropTrigger(table),
    `CREATE TRIGGER ${quoteIdent(triggerName(table))}`,
    `  AFTER INSERT OR UPDATE OR DELETE ON ${quoteIdent(table.dbName)}`,
    `  FOR EACH ROW EXECUTE FUNCTION indigo_notify_trigger(${args});`,
  ].join("\n");
}

export function renderDropTrigger(table: ResolvedTable): string {
  return `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table))} ON ${quoteIdent(table.dbName)};`;
}

// ─── Row-Level Security (@@allow → policies, design decisions 8/11/12/13) ────

/**
 * The Postgres session/transaction setting `$auth` writes via
 * `set_config('app.user_id', $1, true)` and every RLS policy predicate
 * reads via `current_setting`. Single source of truth for the migrator side
 * — `@indigodb/client`'s `$auth` carries the identical literal (the two
 * packages do not share a dependency edge, same pattern as
 * `REALTIME_CHANNEL` not being re-exported to `@indigodb/client`).
 */
export const AUTH_SETTING = "app.user_id";

/** Postgres identifier byte limit; names beyond this are silently truncated
 * rather than rejected, so this is checked instead of trusted (design
 * decision #11, mirrors the compiler's own `validate_allow_policy_names`). */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * `indigo_p_<dbName>_<action>_<ordinal>` — readable in `pg_policies` and
 * fully derivable from the IR alone (design decision #11). `ordinal` is the
 * rule's index among this table's rules for `rule.action` — callers
 * (`renderRlsBlock`, `diffPolicies`) compute it by filtering `table.allow`
 * to the same action and finding the rule's position, so ordinal
 * computation can never disagree between the two DDL paths.
 */
export function policyName(table: ResolvedTable, rule: AllowRule, ordinal: number): string {
  const name = `indigo_p_${table.dbName}_${rule.action}_${ordinal}`;
  if (Buffer.byteLength(name, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Generated policy name "${name}" for table "${table.dbName}" exceeds ${MAX_IDENTIFIER_BYTES} bytes; shorten the table's @@map name.`,
    );
  }
  return name;
}

/** Looks up a table's column by physical `dbName` (`AllowOperand.Field.name`
 * always carries the physical name, design decision #7). */
function columnByDbName(table: ResolvedTable, dbName: string): ResolvedColumn | undefined {
  return table.columns.find((c) => c.dbName === dbName);
}

/**
 * Renders one side of an `@@allow` condition. `castType` is the SQL type
 * text (from `columnSqlType`) the OTHER side resolved to, when this side is
 * not itself a field — `undefined` (no cast text emitted) when this side IS
 * a field (already typed by its own column DDL) or when neither side of the
 * rule is a field (an edge case the compiler's validator does not itself
 * reach in this slice, e.g. two claims). Claim reads are wrapped in
 * `NULLIF(..., '')` before the cast: PGlite/PostgreSQL leave a residual
 * empty-string placeholder on a custom GUC (`app.user_id`) once it has been
 * `set_config`'d and the local transaction later commits — without the
 * guard, a request that omits `$auth` on a connection that previously used
 * it would hit an SQL cast ERROR (`invalid input syntax for type integer:
 * ""`) instead of the intended silent deny (verified live against PGlite,
 * `C0.1`). Identifiers go through `quoteIdent`, string literals through
 * `escapeLiteral` — never interpolated raw (threat matrix: SQL injection
 * via schema-authored identifiers/literals).
 */
function renderOperand(op: AllowOperand, table: ResolvedTable, castType: string | undefined): string {
  const cast = castType ? `::${castType}` : "";
  switch (op.kind) {
    case "field":
      return quoteIdent(op.name);
    case "claim":
      return `NULLIF(current_setting('${escapeLiteral(AUTH_SETTING)}', true), '')${cast}`;
    case "string":
      return `'${escapeLiteral(op.value)}'${cast}`;
    case "number":
      return `${op.value}${cast}`;
    case "boolean":
      return `${op.value ? "true" : "false"}${cast}`;
  }
}

/**
 * Renders the shared `left = right` condition text for one `AllowRule`,
 * operand order following declaration order (the compiler never normalizes
 * sides). When exactly one side is a `field` operand, the OTHER side casts
 * to that field's own SQL type (design decision #8) — never the field side,
 * which is already typed by its column DDL.
 */
function renderCondition(table: ResolvedTable, rule: AllowRule): string {
  const leftField = rule.left.kind === "field" ? columnByDbName(table, rule.left.name) : undefined;
  const rightField = rule.right.kind === "field" ? columnByDbName(table, rule.right.name) : undefined;
  const fieldType = leftField ? columnSqlType(leftField) : rightField ? columnSqlType(rightField) : undefined;
  const left = renderOperand(rule.left, table, leftField ? undefined : fieldType);
  const right = renderOperand(rule.right, table, rightField ? undefined : fieldType);
  return `${left} = ${right}`;
}

/**
 * Renders one `CREATE POLICY` statement. `PERMISSIVE` (Postgres default —
 * multiple rules on the same action OR together). Command mapping (design
 * decision #12): read/delete get `USING` only; create gets `WITH CHECK`
 * only (Postgres forbids `USING` on `FOR INSERT`); update gets both from
 * the SAME condition (the `WITH CHECK` half is what stops a row being
 * updated OUT OF the caller's ownership).
 */
export function renderPolicy(table: ResolvedTable, rule: AllowRule, ordinal: number): string {
  const name = policyName(table, rule, ordinal);
  const condition = renderCondition(table, rule);
  const t = quoteIdent(table.dbName);
  switch (rule.action) {
    case "read":
      return `CREATE POLICY ${quoteIdent(name)} ON ${t} AS PERMISSIVE FOR SELECT\n  USING (${condition});`;
    case "create":
      return `CREATE POLICY ${quoteIdent(name)} ON ${t} AS PERMISSIVE FOR INSERT\n  WITH CHECK (${condition});`;
    case "update":
      return `CREATE POLICY ${quoteIdent(name)} ON ${t} AS PERMISSIVE FOR UPDATE\n  USING (${condition}) WITH CHECK (${condition});`;
    case "delete":
      return `CREATE POLICY ${quoteIdent(name)} ON ${t} AS PERMISSIVE FOR DELETE\n  USING (${condition});`;
  }
}

/**
 * Guarded prune loop dropping any `pg_policies` row matching
 * `indigo_p_<table>_%` that is not in `keepNames` — a plain PL/pgSQL loop,
 * not a `DO $$ ... EXCEPTION` guard (there is nothing to race: `DROP POLICY`
 * has no `IF NOT EXISTS`-shaped failure mode here, only "does it still
 * exist", which the loop's own `pg_policies` query already answers). Shared
 * by `renderRlsBlock` (rule count > 0) and `renderDisableRls` (rule count
 * === 0, so `keepNames` is empty and every `indigo_p_<table>_*` policy is
 * pruned) so push always converges when a rule is removed, not just added
 * (design decision #13's explicit warning).
 */
function renderPruneLoop(table: ResolvedTable, keepNames: string[]): string {
  const prefix = escapeLiteral(`indigo_p_${table.dbName}_`);
  // `<> ALL(ARRAY[...]::text[])`, NEVER `NOT IN (...)`: with an empty
  // `keepNames` (the `renderDisableRls` case — every rule was removed),
  // `NOT IN (NULL)` is SQL's classic trap — a NULL on the right side of
  // `IN`/`NOT IN` makes the whole comparison NULL (neither true nor false)
  // for every row, so the loop would silently prune NOTHING and leave every
  // stale policy orphaned (exactly the convergence bug design decision #13
  // warns about). `<> ALL(ARRAY[]::text[])` has no such trap: an empty
  // array makes the quantified comparison vacuously true for every row.
  const keepArray = keepNames.map((n) => `'${escapeLiteral(n)}'`).join(", ");
  return [
    "DO $$",
    "DECLARE",
    "  pol record;",
    "BEGIN",
    `  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${escapeLiteral(table.dbName)}' AND policyname LIKE '${prefix}%' AND policyname <> ALL(ARRAY[${keepArray}]::text[])`,
    "  LOOP",
    // `%I` on BOTH the policy name AND the table name — an unquoted table
    // identifier here would case-fold ("Post" -> post), so `DROP POLICY IF
    // EXISTS ... ON post` would silently no-op against a table that doesn't
    // exist (verified live against PGlite: the exact failure mode this
    // comment describes, caught before commit).
    `    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, '${escapeLiteral(table.dbName)}');`,
    "  END LOOP;",
    "END $$;",
  ].join("\n");
}

/**
 * Prune + `DISABLE`/`NO FORCE ROW LEVEL SECURITY` — the zero-rule case
 * (`table.allow` absent or empty): a table that once had `@@allow` rules
 * and now has none must lose both its stale policies AND the RLS toggle
 * itself, or push stops converging.
 */
export function renderDisableRls(table: ResolvedTable): string[] {
  return [
    renderPruneLoop(table, []),
    `ALTER TABLE ${quoteIdent(table.dbName)} DISABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${quoteIdent(table.dbName)} NO FORCE ROW LEVEL SECURITY;`,
  ];
}

/**
 * Pairs every `@@allow` rule with its per-action ordinal (the rule's index
 * among `table.allow`'s rules sharing its `action`, design decision #11)
 * and its derived `policyName`. Exported so `migrate.ts`'s `diffPolicies`
 * computes the exact same `(name, ordinal)` pairing `renderRlsBlock` uses
 * for `db push` — the two DDL paths can never disagree on which rule owns
 * which name.
 */
export function namedAllowRules(
  table: ResolvedTable,
): { rule: AllowRule; ordinal: number; name: string }[] {
  const ordinals = new Map<string, number>();
  return (table.allow ?? []).map((rule) => {
    const ordinal = ordinals.get(rule.action) ?? 0;
    ordinals.set(rule.action, ordinal + 1);
    return { rule, ordinal, name: policyName(table, rule, ordinal) };
  });
}

/**
 * Renders the full RLS DDL for one table: `[]` when it carries no `@@allow`
 * rules at all (untouched — never emit RLS DDL for a table that was never
 * RLS-enabled), `renderDisableRls` when `allow` is present but empty,
 * otherwise `ENABLE`+`FORCE ROW LEVEL SECURITY` (both idempotent no-ops
 * when already set — no `DO` guard needed) followed by the prune loop and
 * one `DROP POLICY IF EXISTS` + `CREATE POLICY` pair per rule (design
 * decision #13). `FORCE` matters even for the table owner: without it, the
 * owner role bypasses RLS entirely regardless of `SET ROLE`.
 */
export function renderRlsBlock(table: ResolvedTable): string[] {
  const rules = table.allow;
  if (rules === undefined) return [];
  if (rules.length === 0) return renderDisableRls(table);

  const named = namedAllowRules(table);

  const stmts: string[] = [
    `ALTER TABLE ${quoteIdent(table.dbName)} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${quoteIdent(table.dbName)} FORCE ROW LEVEL SECURITY;`,
    renderPruneLoop(
      table,
      named.map((n) => n.name),
    ),
  ];
  for (const { rule, ordinal, name } of named) {
    stmts.push(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${quoteIdent(table.dbName)};`);
    stmts.push(renderPolicy(table, rule, ordinal));
  }
  return stmts;
}

/**
 * Renders the full idempotent DDL script that syncs a Postgres database to the
 * given resolved schema. Safe to run repeatedly.
 */
export function renderPushSql(schema: ResolvedSchema): string {
  const blocks: string[] = [
    "-- Generated by IndigoDB — db push (PostgreSQL). Idempotent; safe to re-run.",
  ];

  // 1. Enum types.
  for (const e of schema.enums) blocks.push(renderEnum(e));

  // 2. Tables (create + additive columns).
  for (const table of schema.tables) {
    blocks.push(renderCreateTable(table, schema.enums));
    blocks.push(...renderAddColumns(table, schema.enums));
  }

  // 3. Unique constraints (column-level @unique + composite @@unique) as indexes.
  for (const table of schema.tables) {
    for (const col of table.columns) {
      if (!col.unique) continue;
      const idx = `${table.dbName}_${col.dbName}_key`;
      blocks.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(idx)} ON ${quoteIdent(table.dbName)} (${quoteIdent(col.dbName)});`,
      );
    }
    for (const index of table.indexes) {
      blocks.push(renderIndexDdl(table, index, { ifNotExists: true }));
    }
  }

  // 4. Foreign keys (after all tables exist).
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys) blocks.push(renderForeignKey(table, fk));
  }

  // 5. Realtime notify triggers. Unlike data DDL, push DOES drop triggers on
  // tables that are no longer @@realtime — a trigger is regenerable metadata
  // and leaving it firing would keep notifying dropped subscriptions.
  if (schema.tables.some((t) => t.realtime)) blocks.push(renderNotifyFunction());
  for (const table of schema.tables) {
    blocks.push(table.realtime ? renderCreateTrigger(table) : renderDropTrigger(table));
  }

  // 6. Row-Level Security (@@allow → policies). `renderRlsBlock` itself
  // decides ENABLE+FORCE+policies / DISABLE+prune / nothing per table.
  for (const table of schema.tables) {
    blocks.push(...renderRlsBlock(table));
  }

  return blocks.join("\n\n") + "\n";
}
