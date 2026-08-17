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
} from "@indigodb/core";

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
   * Defaults to `["_indigo_migrations"]`.
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
  nativeType?: { name: string; args: string[] };
}

/**
 * Inverts one column's PostgreSQL type back to its IndigoDB scalar (or enum
 * name), recovering a `nativeType` override for the three shapes outside the
 * plain inversion table. Throws — never guesses — for any other unrecognized
 * `udt_name`.
 */
function invertColumnType(row: ColumnRow, tableDbName: string, enumNames: Set<string>): InvertedType {
  const udt = row.udt_name;

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
    `introspectResolvedSchema: unmappable PostgreSQL type "${udt}" on column "${tableDbName}.${row.column_name}"`,
  );
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
SELECT c.table_name, c.column_name, c.ordinal_position, c.udt_name,
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
    SELECT array_agg(a.attname ORDER BY u.ord)
    FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
  ) AS columns,
  (
    SELECT array_agg(a.attname ORDER BY u.ord)
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
  (
    SELECT array_agg(a.attname ORDER BY u.ord)
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

const ENUM_SQL = `
SELECT t.typname AS enum_name, e.enumlabel AS label
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1
ORDER BY t.typname, e.enumsortorder;`;

const TRIGGER_SQL = `
SELECT trel.relname AS table_name, trg.tgname AS trigger_name
FROM pg_trigger trg
JOIN pg_class trel ON trel.oid = trg.tgrelid
JOIN pg_namespace n ON n.oid = trel.relnamespace
WHERE n.nspname = $1 AND trg.tgname LIKE 'indigo\\_rt\\_%' AND NOT trg.tgisinternal
ORDER BY trel.relname, trg.tgname;`;

// ─── Assembly ────────────────────────────────────────────────────────────────

/**
 * Reconstructs a `ResolvedSchema` from a live PostgreSQL catalog. Populated:
 * `tables[].{name(===dbName), dbName, columns, primaryKey, foreignKeys,
 * indexes, realtime?}`; `columns[].{name(===dbName), dbName, type, isEnum,
 * nullable, isPk, unique, autoincrement, default?, nativeType?}`;
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
  const exclude = new Set(options.exclude ?? ["_indigo_migrations"]);

  const [tablesRes, columnsRes, pkRes, fkRes, indexRes, enumRes, triggerRes] = await Promise.all([
    query(TABLES_SQL, [schema]),
    query(COLUMNS_SQL, [schema]),
    query(PK_SQL, [schema]),
    query(FK_SQL, [schema]),
    query(INDEX_SQL, [schema]),
    query(ENUM_SQL, [schema]),
    query(TRIGGER_SQL, [schema]),
  ]);

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
    columns: string[] | null;
  }
  for (const row of indexRes.rows as unknown as IndexRow[]) {
    if (row.is_primary) continue; // PK-backing index — not a distinct object
    const table = tables.get(row.table_name);
    if (!table) continue;

    if (row.has_expression) {
      throw new Error(
        `introspectResolvedSchema: expression index "${row.index_name}" on "${table.dbName}" is not supported`,
      );
    }
    const columns = row.columns ?? [];

    // Single-column unique index whose name matches the DERIVED single-column
    // `@unique` formula is indistinguishable from a single-column `@@unique`
    // — classify as `col.unique`, not a listed `table.indexes` entry.
    if (row.is_unique && columns.length === 1) {
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
    const derived = derivedIndexName(table.dbName, columns, row.is_unique);
    if (row.index_name !== derived) index.name = row.index_name;

    table.indexes.push(index);
  }

  // ── Realtime (indigo_rt_* triggers) ──
  const realtimeTables = new Set(
    (triggerRes.rows as { table_name: string; trigger_name: string }[])
      .filter((r) => r.trigger_name === `indigo_rt_${r.table_name}`)
      .map((r) => r.table_name),
  );
  for (const table of tables.values()) {
    if (realtimeTables.has(table.dbName)) table.realtime = true;
  }

  return {
    tables: [...tables.values()],
    enums,
    tableGroups: [],
  };
}
