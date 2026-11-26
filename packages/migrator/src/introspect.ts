/**
 * @indigodb/migrator — Schema introspection
 *
 * `introspectResolvedSchema` inverts `postgres.ts`'s renderer: given a live
 * catalog connection, it reconstructs a `ResolvedSchema` that — for an
 * IndigoDB-managed database — round-trips through `planMigration` as an
 * EMPTY plan against the schema that produced it. It is NOT a general
 * Postgres-schema-to-anything tool: it only recognizes the physical shapes
 * IndigoDB itself emits (design decision #3, `sdd/shadow-replay-diff/design`).
 *
 * `col.type` is always the IndigoDB scalar name (text -> String, integer ->
 * Int, ...), never the PostgreSQL spelling — `columnSignature` in
 * `migrate.ts` compares `col.type` directly against a resolved `.indigo`
 * schema's `col.type`, so a PG-spelled type would silently diff on every
 * column, every run. Types outside the inverse table (`character
 * varying(n)`, `uuid`, `numeric(p,s)`) recover their IndigoDB base type PLUS
 * a `nativeType` override — never guessed: an unrecognized PostgreSQL type
 * THROWS, naming the exact `table.column` and the type, rather than silently
 * emitting a wrong (and potentially destructive `ALTER ... TYPE`) inference.
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
  AllowAction,
  AllowOperand,
  AllowRule,
} from "@indigodb/core";
import { resolveSlotName } from "./postgres.js";

/**
 * Satisfied by both `pg.Client#query` and `PGlite#query` — the introspection
 * queries below use only `$1`-style bound parameters and a plain
 * `{rows}` result shape, so either driver can be handed in directly.
 */
export type IntrospectionQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface IntrospectOptions {
  /** Catalog schema to introspect. Defaults to `"public"`. */
  schema?: string;
  /**
   * Table names to exclude from the result — IndigoDB's own bookkeeping
   * tables never belong in a replayed/introspected `ResolvedSchema`.
   * Defaults to `["_indigo_migrations", "_indigo_realtime_log"]`. Without
   * excluding `_indigo_realtime_log` (`realtime-shape-log` design decision
   * 5), shadow-replay/introspection sees the log as an ordinary user table
   * and `planMigration` emits `DROP TABLE "_indigo_realtime_log" CASCADE`,
   * breaking the round-trip no-op invariant `introspect.mjs` enforces — same
   * reason `_indigo_migrations` is already excluded.
   */
  exclude?: string[];
}

// ─── Type inversion ──────────────────────────────────────────────────────────

/**
 * The inverse of `mapScalarToPg` (`postgres.ts`), keyed by `udt_name` (the
 * short PostgreSQL type name — stable across `information_schema`'s
 * `data_type`/`udt_name` split, e.g. `integer`/`int4`). `varchar`, `uuid`
 * and `numeric` are handled separately below because they need extra
 * catalog data (length / precision+scale) to decide between a bare scalar
 * and a `nativeType` override.
 */
const PG_TYPE_TO_SCALAR: Record<string, string> = {
  text: "String",
  int4: "Int",
  int8: "BigInt",
  float8: "Float",
  bool: "Boolean",
  timestamptz: "DateTime",
  jsonb: "Json",
  bytea: "Bytes",
};

interface ColumnRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
}

interface InvertedType {
  type: string;
  isEnum: boolean;
  list: boolean;
  nativeType?: { name: string; args: string[] };
}

function invertScalarUdt(
  udt: string,
  row: ColumnRow,
  tableDbName: string,
  enumNames: Set<string>,
): Omit<InvertedType, "list"> {
  if (udt === "varchar") {
    const len = row.character_maximum_length;
    return {
      type: "String",
      isEnum: false,
      nativeType: { name: "VarChar", args: len != null ? [String(len)] : [] },
    };
  }
  if (udt === "uuid") {
    return { type: "String", isEnum: false, nativeType: { name: "Uuid", args: [] } };
  }
  if (udt === "numeric") {
    const precision = row.numeric_precision;
    const scale = row.numeric_scale;
    // Bare `numeric` (no declared precision/scale) stays plain `Decimal`,
    // no `nativeType` override — only an EXPLICIT `numeric(p,s)` recovers one.
    if (precision == null) return { type: "Decimal", isEnum: false };
    return {
      type: "Decimal",
      isEnum: false,
      nativeType: { name: "Numeric", args: [String(precision), String(scale ?? 0)] },
    };
  }

  const base = PG_TYPE_TO_SCALAR[udt];
  if (base) return { type: base, isEnum: false };

  if (enumNames.has(udt)) return { type: udt, isEnum: true };

  throw new Error(
    `introspectResolvedSchema: unmappable PostgreSQL type "${row.udt_name}" on column "${tableDbName}.${row.column_name}"`,
  );
}

/**
 * Inverts one column's PostgreSQL type back to its IndigoDB scalar (or enum
 * name), recovering array list-ness (`_text` -> `String[]`) and `nativeType`
 * overrides. Throws — never guesses — for any unrecognized `udt_name`.
 */
function invertColumnType(row: ColumnRow, tableDbName: string, enumNames: Set<string>): InvertedType {
  const udt = row.udt_name;
  const isArray = row.data_type === "ARRAY" || (udt.startsWith("_") && !enumNames.has(udt));
  if (isArray && udt.startsWith("_")) {
    return { ...invertScalarUdt(udt.slice(1), row, tableDbName, enumNames), list: true };
  }
  return { ...invertScalarUdt(udt, row, tableDbName, enumNames), list: false };
}

// ─── Default parsing ─────────────────────────────────────────────────────────

function unescapeSqlString(s: string): string {
  return s.replace(/''/g, "'");
}

/**
 * Parses a `pg_catalog`-rendered `column_default` expression back into a
 * `ResolvedDefault`. Only the shapes IndigoDB itself can emit are
 * recognized (`now()`, `gen_random_uuid()`, quoted literals — optionally
 * cast — and enum-cast literals); anything else throws rather than guessing.
 */
function parseColumnDefault(raw: string, isEnumColumn: boolean): ResolvedDefault {
  if (raw === "now()") return { kind: "function", name: "now" };
  if (raw === "gen_random_uuid()") return { kind: "function", name: "uuid" };

  // Enum-cast literal: 'ACTIVE'::"Status" or 'ACTIVE'::Status
  const enumMatch = raw.match(/^'((?:[^']|'')*)'::"?[A-Za-z_][\w]*"?$/);
  if (isEnumColumn && enumMatch) {
    return { kind: "value", value: unescapeSqlString(enumMatch[1]) };
  }

  // Plain string literal, optionally cast: 'foo'::text / ''::text / 'foo'::character varying(255)
  const strMatch = raw.match(/^'((?:[^']|'')*)'(::[\w "]+(\(\d+(?:,\d+)?\))?)?$/);
  if (strMatch) return { kind: "value", value: unescapeSqlString(strMatch[1]) };

  if (raw === "true") return { kind: "value", value: true };
  if (raw === "false") return { kind: "value", value: false };

  const num = Number(raw);
  if (raw.trim() !== "" && !Number.isNaN(num)) return { kind: "value", value: num };

  throw new Error(`introspectResolvedSchema: unrecognized default expression "${raw}"`);
}

// ─── Naming (kept stable with postgres.ts / migrate.ts push+diff output) ────

function derivedIndexName(tableDbName: string, columns: string[], unique: boolean): string {
  return `${tableDbName}_${columns.join("_")}_${unique ? "key" : "idx"}`;
}

function derivedFkName(tableDbName: string, columns: string[]): string {
  return `${tableDbName}_${columns.join("_")}_fkey`;
}

/** `confdeltype`/`confupdtype` single-letter codes -> the SQL text `@relation`'s
 * `onDelete`/`onUpdate` renders (`rules.rs`'s `ACTION_SQL` table). `'a'` (NO
 * ACTION) maps to `undefined` — `fkDefinition` in `migrate.ts` compares
 * `fk.onDelete ?? ""` directly, so a literal `"NO ACTION"` string would diff
 * against an absent key on every single run. */
const FK_ACTION_MAP: Record<string, string | undefined> = {
  a: undefined,
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

// ─── Catalog queries ─────────────────────────────────────────────────────────

const TABLES_SQL = `
SELECT c.relname AS table_name
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind = 'r'
ORDER BY c.relname;`;

const COLUMNS_SQL = `
SELECT c.table_name, c.column_name, c.ordinal_position, c.data_type, c.udt_name,
       c.character_maximum_length, c.numeric_precision, c.numeric_scale,
       c.is_nullable, c.column_default, c.is_identity
FROM information_schema.columns c
WHERE c.table_schema = $1
ORDER BY c.table_name, c.ordinal_position;`;

const PK_SQL = `
SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
ORDER BY tc.table_name, kcu.ordinal_position;`;

const FK_SQL = `
SELECT
  con.conname AS name,
  rel.relname AS table_name,
  frel.relname AS ref_table_name,
  con.confdeltype,
  con.confupdtype,
  (
    SELECT array_agg(a.attname::text ORDER BY u.ord)
    FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
  ) AS columns,
  (
    SELECT array_agg(a.attname::text ORDER BY u.ord)
    FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.attnum
  ) AS ref_columns
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_class frel ON frel.oid = con.confrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE con.contype = 'f' AND n.nspname = $1
ORDER BY rel.relname, con.conname;`;

const INDEX_SQL = `
SELECT
  irel.relname AS index_name,
  trel.relname AS table_name,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  am.amname AS access_method,
  (0::int2 = ANY(ix.indkey)) AS has_expression,
  pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
  pg_get_expr(ix.indexprs, ix.indrelid) AS expressions,
  (
    SELECT array_agg(a.attname::text ORDER BY u.ord)
    FROM unnest(ix.indkey) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = u.attnum
  ) AS columns
FROM pg_index ix
JOIN pg_class irel ON irel.oid = ix.indexrelid
JOIN pg_class trel ON trel.oid = ix.indrelid
JOIN pg_am am ON am.oid = irel.relam
JOIN pg_namespace n ON n.oid = trel.relnamespace
WHERE n.nspname = $1
ORDER BY trel.relname, irel.relname;`;

const POLICY_SQL = `
SELECT tablename AS table_name, policyname AS policy_name, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = $1 AND policyname LIKE 'indigo_p_%'
ORDER BY tablename, policyname;`;

const ENUM_SQL = `
SELECT t.typname AS enum_name, e.enumlabel AS label
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1
ORDER BY t.typname, e.enumsortorder;`;

/**
 * Realtime detection now follows the WAL publication, not the retired v1
 * NOTIFY trigger: `pg_publication_tables` lists every table currently a
 * member of `$2` (the resolved slot/publication name, design decision 6/7),
 * which `renderPublicationSql`'s declarative `SET TABLE` keeps in exact sync
 * with `@@realtime`. A `$2` parameter, not string-interpolated, even though
 * `resolveSlotName` already whitelists the name (defense in depth, same
 * posture as every other introspection query here).
 */
const REALTIME_PUBLICATION_SQL = `
SELECT tablename AS table_name
FROM pg_publication_tables
WHERE schemaname = $1 AND pubname = $2;`;

// ─── RLS policy & SQL expression helpers ─────────────────────────────────────

function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let wrapsWhole = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inSingle) {
        if (ch === "'" && s[i + 1] === "'") {
          i++;
        } else if (ch === "'") {
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"' && s[i + 1] === '"') {
          i++;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          wrapsWhole = false;
          break;
        }
      }
    }
    if (!wrapsWhole || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function splitTopLevelEquals(expr: string): [string, string] | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inSingle) {
      if (ch === "'" && expr[i + 1] === "'") i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && expr[i + 1] === '"') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "=" && expr[i - 1] !== "!" && expr[i - 1] !== "<" && expr[i - 1] !== ">") {
      return [expr.slice(0, i).trim(), expr.slice(i + 1).trim()];
    }
  }
  return null;
}

function stripTrailingCast(expr: string): string {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inSingle) {
      if (ch === "'" && expr[i + 1] === "'") i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && expr[i + 1] === '"') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === ":" && expr[i + 1] === ":") {
      return expr.slice(0, i).trim();
    }
  }
  return expr.trim();
}

function parsePolicyOperand(raw: string): AllowOperand | null {
  const s = stripOuterParens(stripTrailingCast(stripOuterParens(raw)));
  if (/^NULLIF\s*\(\s*current_setting\s*\(\s*'app\.user_id'(?:::text)?\s*,\s*true\s*\)\s*,\s*''(?:::text)?\s*\)$/i.test(s)) {
    return { kind: "claim", name: "userId" };
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return { kind: "string", value: unescapeSqlString(s.slice(1, -1)) };
  }
  if (s === "true") return { kind: "boolean", value: true };
  if (s === "false") return { kind: "boolean", value: false };
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return { kind: "number", value: Number(s) };
  if (s.startsWith('"') && s.endsWith('"')) {
    return { kind: "field", name: s.slice(1, -1).replace(/""/g, '"') };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    return { kind: "field", name: s };
  }
  return null;
}

function parsePolicyCondition(expr: string): { left: AllowOperand; right: AllowOperand } | null {
  const stripped = stripOuterParens(expr);
  const parts = splitTopLevelEquals(stripped);
  if (!parts) {
    const solo = parsePolicyOperand(stripped);
    if (solo?.kind === "field") return { left: solo, right: { kind: "boolean", value: true } };
    return null;
  }
  const left = parsePolicyOperand(parts[0]);
  const right = parsePolicyOperand(parts[1]);
  if (!left || !right) return null;
  return { left, right };
}

function parseIndigoPolicyName(
  policyName: string,
  tableDbName: string,
): { action: AllowAction; ordinal: number } | null {
  const match = policyName.match(/^indigo_p_(.+)_(create|read|update|delete)_(\d+)$/);
  if (!match || match[1] !== tableDbName) return null;
  return { action: match[2] as AllowAction, ordinal: Number(match[3]) };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

/**
 * Reconstructs a `ResolvedSchema` from a live PostgreSQL catalog. Populated:
 * `tables[].{name(===dbName), dbName, columns, primaryKey, foreignKeys,
 * indexes, allow?, realtime?}`; `columns[].{name(===dbName), dbName, type,
 * isEnum, list?, nullable, isPk, unique, autoincrement, default?, nativeType?}`;
 * `enums[].{name, values, members}` with member `name === dbName`.
 * Deliberately absent/empty: table/column `note`, `color`, `group`,
 * `relations: []`, `tableGroups: []`, `datasource` omitted — none of these
 * are physically observable in the catalog.
 */
export async function introspectResolvedSchema(
  query: IntrospectionQuery,
  options: IntrospectOptions = {},
): Promise<ResolvedSchema> {
  const schema = options.schema ?? "public";
  const exclude = new Set(options.exclude ?? ["_indigo_migrations", "_indigo_realtime_log"]);

  // Run sequentially rather than via Promise.all: callers (such as `db pull`)
  // pass a single `pg.Client`, which deprecates concurrent `client.query()` calls.
  const tablesRes = await query(TABLES_SQL, [schema]);
  const columnsRes = await query(COLUMNS_SQL, [schema]);
  const pkRes = await query(PK_SQL, [schema]);
  const fkRes = await query(FK_SQL, [schema]);
  const indexRes = await query(INDEX_SQL, [schema]);
  const enumRes = await query(ENUM_SQL, [schema]);
  const publicationRes = await query(REALTIME_PUBLICATION_SQL, [schema, resolveSlotName()]);
  const policyRes = await query(POLICY_SQL, [schema]);

  // ── Enums ──
  const enumsByName = new Map<string, ResolvedEnumMember[]>();
  for (const row of enumRes.rows as { enum_name: string; label: string }[]) {
    const members = enumsByName.get(row.enum_name) ?? [];
    members.push({ name: row.label, dbName: row.label });
    enumsByName.set(row.enum_name, members);
  }
  const enumNames = new Set(enumsByName.keys());
  const enums: ResolvedEnum[] = [...enumsByName.entries()].map(([name, members]) => ({
    name,
    values: members.map((m) => m.name),
    members,
  }));

  // ── Tables (name/dbName scaffold) ──
  const tableNames = (tablesRes.rows as { table_name: string }[])
    .map((r) => r.table_name)
    .filter((name) => !exclude.has(name));

  const tables = new Map<string, ResolvedTable>();
  for (const name of tableNames) {
    tables.set(name, {
      name,
      dbName: name,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      relations: [],
    });
  }

  // ── Columns ──
  for (const row of columnsRes.rows as unknown as ColumnRow[]) {
    const table = tables.get(row.table_name);
    if (!table) continue; // excluded table

    const inverted = invertColumnType(row, table.dbName, enumNames);
    const isIdentity = row.is_identity === "YES";

    const column: ResolvedColumn = {
      name: row.column_name,
      dbName: row.column_name,
      type: inverted.type,
      isEnum: inverted.isEnum,
      ...(inverted.list ? { list: true } : {}),
      nullable: row.is_nullable === "YES",
      isPk: false, // populated below from the PK query
      unique: false, // populated below from the index query
      autoincrement: isIdentity,
    };
    if (inverted.nativeType) column.nativeType = inverted.nativeType;
    if (!isIdentity && row.column_default != null) {
      column.default = parseColumnDefault(row.column_default, inverted.isEnum);
    }

    table.columns.push(column);
  }

  // ── Primary keys ──
  for (const row of pkRes.rows as { table_name: string; column_name: string }[]) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    table.primaryKey.push(row.column_name);
    const col = table.columns.find((c) => c.dbName === row.column_name);
    if (col) col.isPk = true;
  }

  // ── Foreign keys ──
  interface FkRow {
    name: string;
    table_name: string;
    ref_table_name: string;
    confdeltype: string;
    confupdtype: string;
    columns: string[];
    ref_columns: string[];
  }
  for (const row of fkRes.rows as unknown as FkRow[]) {
    const table = tables.get(row.table_name);
    if (!table) continue;

    const fk: ForeignKey = {
      columns: row.columns,
      refTable: row.ref_table_name,
      refColumns: row.ref_columns,
    };
    const onDelete = FK_ACTION_MAP[row.confdeltype];
    const onUpdate = FK_ACTION_MAP[row.confupdtype];
    if (onDelete) fk.onDelete = onDelete;
    if (onUpdate) fk.onUpdate = onUpdate;

    const derived = derivedFkName(table.dbName, fk.columns);
    if (row.name !== derived) fk.name = row.name;

    table.foreignKeys.push(fk);
  }

  // ── Indexes (+ single-column @unique classification) ──
  interface IndexRow {
    index_name: string;
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    access_method: string;
    has_expression: boolean;
    predicate: string | null;
    expressions: string | null;
    columns: string[] | null;
  }
  for (const row of indexRes.rows as unknown as IndexRow[]) {
    if (row.is_primary) continue; // PK-backing index — not a distinct object
    const table = tables.get(row.table_name);
    if (!table) continue;

    const predicate = row.predicate ? stripOuterParens(row.predicate) : null;

    if (row.has_expression) {
      const exprIndex: ResolvedIndex = {
        columns: [],
        unique: row.is_unique,
        name: row.index_name,
      };
      if (row.access_method !== "btree") {
        exprIndex.type = row.access_method as ResolvedIndex["type"];
      }
      if (predicate) exprIndex.where = predicate;
      if (row.expressions) exprIndex.expression = row.expressions;
      table.indexes.push(exprIndex);
      continue;
    }
    const columns = row.columns ?? [];

    // Single-column unique index whose name matches the DERIVED single-column
    // `@unique` formula is indistinguishable from a single-column `@@unique`
    // — classify as `col.unique`, not a listed `table.indexes` entry.
    // Partial unique indexes (`predicate != null`) are NEVER folded into
    // `col.unique`, because they do not enforce full-table uniqueness.
    if (row.is_unique && columns.length === 1 && !predicate) {
      const singleColDerived = derivedIndexName(table.dbName, columns, true);
      if (row.index_name === singleColDerived) {
        const col = table.columns.find((c) => c.dbName === columns[0]);
        if (col) col.unique = true;
        continue;
      }
    }

    const index: ResolvedIndex = { columns, unique: row.is_unique };
    if (row.access_method !== "btree") {
      index.type = row.access_method as ResolvedIndex["type"];
    }
    if (predicate) index.where = predicate;
    const derived = derivedIndexName(table.dbName, columns, row.is_unique);
    if (row.index_name !== derived) index.name = row.index_name;

    table.indexes.push(index);
  }

  // ── Realtime (WAL publication membership) ──
  const realtimeTables = new Set(
    (publicationRes.rows as { table_name: string }[]).map((r) => r.table_name),
  );
  for (const table of tables.values()) {
    if (realtimeTables.has(table.dbName)) table.realtime = true;
  }

  // ── RLS policies (@@allow) ──
  interface PolicyRow {
    table_name: string;
    policy_name: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }
  const allowEntriesByTable = new Map<
    string,
    Array<{ action: AllowAction; ordinal: number; rule: AllowRule }>
  >();
  for (const row of policyRes.rows as unknown as PolicyRow[]) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    const parsedName = parseIndigoPolicyName(row.policy_name, table.dbName);
    if (!parsedName) continue;
    const rawExpr = parsedName.action === "create" ? row.with_check : (row.qual ?? row.with_check);
    if (!rawExpr) continue;
    const cond = parsePolicyCondition(rawExpr);
    if (!cond) continue;
    const list = allowEntriesByTable.get(table.dbName) ?? [];
    list.push({
      action: parsedName.action,
      ordinal: parsedName.ordinal,
      rule: { action: parsedName.action, left: cond.left, right: cond.right },
    });
    allowEntriesByTable.set(table.dbName, list);
  }
  for (const [dbName, entries] of allowEntriesByTable) {
    const table = tables.get(dbName);
    if (!table || entries.length === 0) continue;
    entries.sort((a, b) => a.ordinal - b.ordinal || a.action.localeCompare(b.action));
    table.allow = entries.map((e) => e.rule);
  }

  return {
    tables: [...tables.values()],
    enums,
    tableGroups: [],
  };
}
