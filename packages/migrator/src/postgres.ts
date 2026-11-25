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
  const target = index.expression
    ? index.expression
    : index.columns.map(quoteIdent).join(", ");
  // Postgres syntax: `USING method` sits between the table and the column/expr
  // list — AFTER the column list is a syntax error.
  const using = index.type ? ` USING ${index.type}` : "";
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${kind}${ifNotExists} ${quoteIdent(indexName(table, index))} ON ${quoteIdent(table.dbName)}${using} (${target})${where};`;
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

// ─── Realtime (@@realtime → WAL logical replication) ─────────────────────────
//
// v1 (`pg_notify` triggers, `REALTIME_CHANNEL`/`renderNotifyFunction`/
// `renderCreateTrigger`) is retired — direct cutover, no dual-write path
// (design decision: closed). `WalSource` (`@indigodb/realtime`) consumes a
// logical-replication slot + publication instead; `triggerName`/
// `renderDropTrigger` are kept ONLY to retire any pre-existing legacy
// trigger object (`renderDropLegacyNotify` below), never to create one.

/** Default replication slot/publication name; overridden by `INDIGODB_REALTIME_SLOT`. */
const DEFAULT_SLOT = "indigo_realtime";
/** Postgres logical replication slot names accept only this alphabet. */
const SLOT_NAME_PATTERN = /^[a-z0-9_]{1,63}$/;

/**
 * Resolves the replication slot/publication name shared by the migrator's DDL
 * path (this file, `migrate.ts`), `@indigodb/cli`'s preflight, and
 * `@indigodb/realtime`'s `WalSource` (design decision 6/7) — one name, one
 * resolver, imported everywhere it's needed, so the slot created here and the
 * slot `WalSource` connects to can never drift apart. Validated against a
 * strict whitelist BEFORE any SQL is built or connection attempted — total,
 * not a mitigation: Postgres itself accepts only this alphabet for a
 * replication slot name, so an injection attempt (`x"; DROP TABLE "User`)
 * fails construction here, never reaching a query.
 */
export function resolveSlotName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.INDIGODB_REALTIME_SLOT?.trim() || DEFAULT_SLOT;
  if (!SLOT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid INDIGODB_REALTIME_SLOT "${name}": replication slot names must ` +
        `match ${SLOT_NAME_PATTERN} (lowercase letters, digits, underscores, 1-63 chars)`,
    );
  }
  return name;
}

/** Stable legacy trigger name for a table (kept only to retire it — never re-created). */
export function triggerName(table: ResolvedTable): string {
  return `indigo_rt_${table.dbName}`;
}

/** Drops a table's legacy v1 NOTIFY trigger, if any. Idempotent. */
export function renderDropTrigger(table: ResolvedTable): string {
  return `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(table))} ON ${quoteIdent(table.dbName)};`;
}

/**
 * Drops the legacy shared v1 NOTIFY function. `CASCADE` also drops any
 * trigger still depending on it, so this is a safety net beyond the explicit
 * per-table `renderDropTrigger` calls, not a replacement for them (which run
 * first so the file's intent reads clearly statement-by-statement).
 */
export function renderDropLegacyNotify(): string {
  return "DROP FUNCTION IF EXISTS indigo_notify_trigger() CASCADE;";
}

/**
 * Pre-transaction slot lifecycle DDL (design decision 1/2). Postgres rejects
 * `pg_create_logical_replication_slot` inside a transaction that has already
 * performed writes, so this MUST run as its own statement, before the main
 * script/migration transaction begins — never folded into `renderPushSql` or
 * a `"transaction"`-phase migration statement.
 *
 * Idempotency is a guarded `SELECT`, NOT the repo's usual
 * `DO $$ ... EXCEPTION WHEN duplicate_object` pattern (design decision 3):
 * `pg_create_logical_replication_slot` raises `object_in_use` on a second
 * call, not `duplicate_object`, and a guarded `SELECT` performs no write —
 * which the pre-transaction constraint above depends on.
 *
 * Dropping fails loudly on an active slot (design decision 4): the guard
 * checks only existence, never `AND NOT active`. A `WalSource` still
 * consuming the slot makes the drop raise `replication slot "…" is active`
 * instead of silently no-op-ing — silent skip is exactly how a slot orphans
 * and retains WAL forever.
 */
export function renderReplicationPreSql(schema: ResolvedSchema): string[] {
  const slot = escapeLiteral(resolveSlotName());
  const hasRealtime = schema.tables.some((t) => t.realtime);
  return hasRealtime
    ? [
        `SELECT pg_create_logical_replication_slot('${slot}', 'pgoutput') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}');`,
      ]
    : [
        `SELECT pg_drop_replication_slot('${slot}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}');`,
      ];
}

/**
 * Publication membership DDL (design decision 5), transactional (unlike the
 * slot, `CREATE`/`ALTER PUBLICATION` carry no pre-transaction restriction).
 * Declarative `SET TABLE <every @@realtime table>` so push and the versioned
 * diff can never disagree on membership; `DROP PUBLICATION IF EXISTS` when
 * the set is empty, since `SET TABLE` rejects an empty list.
 */
export function renderPublicationSql(schema: ResolvedSchema): string[] {
  const pub = quoteIdent(resolveSlotName());
  const realtimeTables = schema.tables.filter((t) => t.realtime);
  if (realtimeTables.length === 0) {
    return [`DROP PUBLICATION IF EXISTS ${pub};`];
  }
  const tableList = realtimeTables.map((t) => quoteIdent(t.dbName)).join(", ");
  return [
    `DO $$ BEGIN\n  CREATE PUBLICATION ${pub};\nEXCEPTION WHEN duplicate_object THEN null; END $$;`,
    `ALTER PUBLICATION ${pub} SET TABLE ${tableList};`,
  ];
}

/**
 * `REPLICA IDENTITY FULL` on every `@@realtime` table (design decision 8) —
 * `DEFAULT` restored once a table stops being realtime. Mandatory, not
 * optional: under the default replica identity, `pgoutput` sends only key
 * columns in the old tuple, so `WalSource`'s `event.old` on UPDATE/DELETE
 * would be a PK stub instead of matching `PgNotifySource`'s full row.
 */
export function renderReplicaIdentity(table: ResolvedTable): string {
  return `ALTER TABLE ${quoteIdent(table.dbName)} REPLICA IDENTITY ${table.realtime ? "FULL" : "DEFAULT"};`;
}

/**
 * Shared, LSN-addressed shape log (`realtime-shape-log` design). One table
 * for every `@@realtime` model, discriminated by `table_name` — same
 * internal-bookkeeping precedent as `_indigo_migrations`. `id bigserial` is
 * the PRIMARY KEY (not `lsn`: many rows share one commit LSN, so `lsn` alone
 * is not unique); canonical read order is `ORDER BY lsn, id`, which holds
 * because there is exactly one writer (the replication slot is exclusive).
 *
 * PR A owns table + indexes. PR B appends RLS (`ENABLE`/`FORCE` + the
 * read/insert policy pair, decisions 6/7) via `renderRealtimeLogRls` —
 * kept behind this single exported entry point so `renderPushSql` never
 * needs to know which PR added which half.
 */
export const REALTIME_LOG_TABLE = "_indigo_realtime_log";

/**
 * `[]` when no table is `@@realtime` (nothing to log) — `renderPushSql`
 * skips this branch entirely, matching how `renderPublicationSql` already
 * treats the empty realtime set. Table + 3 indexes + RLS block when at
 * least one table is `@@realtime`; DROP when none are (design decision 13,
 * routed through `forced(...)` by `migrate.ts`, not this idempotent push
 * renderer, which only ever emits the safe `IF NOT EXISTS`/`DROP TABLE IF
 * EXISTS` forms). RLS on the log is unconditional on any table's own
 * `@@allow` — it protects `buckets`, which every `@@realtime` row carries
 * regardless of whether its own model declares `@@allow`.
 */
export function renderRealtimeLogSql(schema: ResolvedSchema): string[] {
  const t = quoteIdent(REALTIME_LOG_TABLE);
  const hasRealtime = schema.tables.some((table) => table.realtime);
  if (!hasRealtime) {
    return [`DROP TABLE IF EXISTS ${t};`];
  }
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (\n` +
      `  id         bigserial PRIMARY KEY,\n` +
      `  lsn        pg_lsn      NOT NULL,\n` +
      `  txid       text,\n` +
      `  table_name text        NOT NULL,\n` +
      `  op         text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),\n` +
      `  pk         jsonb       NOT NULL,\n` +
      `  "new"      jsonb,\n` +
      `  "old"      jsonb,\n` +
      `  ts         timestamptz NOT NULL,\n` +
      `  buckets    text[]\n` +
      `);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${REALTIME_LOG_TABLE}_lsn_idx`)} ON ${t} (lsn, id);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${REALTIME_LOG_TABLE}_table_idx`)} ON ${t} (table_name, lsn, id);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${REALTIME_LOG_TABLE}_buckets_idx`)} ON ${t} USING gin (buckets);`,
    // PR B: RLS block (design decisions 6/7) — `ENABLE`+`FORCE` plus the
    // read/insert policy pair, hand-written by `renderRealtimeLogRls` since
    // `renderPolicy` cannot express `buckets IS NULL OR ... = ANY(buckets)`.
    ...renderRealtimeLogRls(),
  ];
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
 * RLS block for `_indigo_realtime_log` (design decisions 6/7). Hand-written
 * — NOT a `renderPolicy` call: `renderCondition` only emits `left = right`
 * against a `ResolvedTable`'s own columns, and the log table has no
 * `ResolvedTable`. `buckets IS NULL OR ... = ANY(buckets)` is outside that
 * grammar. The MECHANISM is reused (`AUTH_SETTING`, the
 * `NULLIF(current_setting(...), '')` empty-string guard, `policyName`'s
 * `indigo_p_<...>_<action>_<n>` naming shape) — only the renderer is not.
 *
 * `ENABLE` + `FORCE ROW LEVEL SECURITY` is mandatory, not optional: under
 * `FORCE`, the table OWNER also loses the RLS bypass — including
 * `WalSource`'s own writer connection. WITHOUT the explicit
 * `FOR INSERT WITH CHECK (true)` policy below, that writer's own `INSERT`
 * would be rejected by `FORCE` RLS with no matching policy (design decision
 * 6's RED test, tasks.md B5.1) — this policy is mandatory, not a nice-to-
 * have. No `UPDATE`/`DELETE` policy is ever emitted — the log is
 * append-only by construction (design decision 6, tasks.md B4.1/B4.2).
 */
function renderRealtimeLogRls(): string[] {
  const t = quoteIdent(REALTIME_LOG_TABLE);
  const readPolicy = quoteIdent(`indigo_p_${REALTIME_LOG_TABLE}_read_0`);
  const createPolicy = quoteIdent(`indigo_p_${REALTIME_LOG_TABLE}_create_0`);
  // Same claim-read idiom `renderOperand`'s `claim` case uses — reused
  // verbatim (design decision 7).
  const claim = `NULLIF(current_setting('${escapeLiteral(AUTH_SETTING)}', true), '')`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${readPolicy} ON ${t};`,
    `CREATE POLICY ${readPolicy} ON ${t}\n  AS PERMISSIVE FOR SELECT\n  USING (buckets IS NULL OR ${claim} = ANY (buckets));`,
    `DROP POLICY IF EXISTS ${createPolicy} ON ${t};`,
    `CREATE POLICY ${createPolicy} ON ${t}\n  AS PERMISSIVE FOR INSERT WITH CHECK (true);`,
  ];
}

/**
 * Classifies one `AllowRule` operand pair for `computeBuckets` (design
 * decision 8: `AllowOperand` is not a closed `field == claim` vocabulary —
 * it also admits `field == literal`, `field == field` and `claim == claim`,
 * all of which reach the IR per `validate.rs:837-858`; only `claim ==
 * literal` is rejected at compile time).
 *
 * - `claim-field`: genuinely claim-dependent — contributes a bucket value.
 * - `field-literal` / `field-field` / `claim-claim` ("constant"): caller-
 *   INDEPENDENT. These never contribute a bucket VALUE, but a row that
 *   SATISFIES one is a PERMISSIVE rule granting read to everyone regardless
 *   of claim, which collapses the whole result to `null` (decision 9,
 *   PERMISSIVE-OR semantics: multiple PERMISSIVE policies on the same
 *   action OR together, and "public" ORed with anything is still public).
 * - `unsupported`: `claim == literal` (either order) — the compiler already
 *   rejects this combination (`validate.rs:837-858`); defended here rather
 *   than trusted, but never reached through a real compiled schema.
 */
type OperandClassification =
  | { kind: "claim-field"; field: string }
  | { kind: "field-literal"; field: string; literal: Extract<AllowOperand, { kind: "string" | "number" | "boolean" }> }
  | { kind: "field-field"; a: string; b: string }
  | { kind: "constant"; satisfied: boolean }
  | { kind: "unsupported" };

function isLiteralOperand(
  op: AllowOperand,
): op is Extract<AllowOperand, { kind: "string" | "number" | "boolean" }> {
  return op.kind === "string" || op.kind === "number" || op.kind === "boolean";
}

/** Structural equality between two literal operands — different `kind`s
 * (e.g. the string `"1"` vs the number `1`) are never equal. */
function literalsEqual(
  a: Extract<AllowOperand, { kind: "string" | "number" | "boolean" }>,
  b: Extract<AllowOperand, { kind: "string" | "number" | "boolean" }>,
): boolean {
  if (a.kind !== b.kind) return false;
  return a.value === (b as typeof a).value;
}

function classifyOperandPair(left: AllowOperand, right: AllowOperand): OperandClassification {
  if (left.kind === "claim" && right.kind === "field") return { kind: "claim-field", field: right.name };
  if (left.kind === "field" && right.kind === "claim") return { kind: "claim-field", field: left.name };
  if (left.kind === "field" && right.kind === "field") return { kind: "field-field", a: left.name, b: right.name };
  if (left.kind === "field" && isLiteralOperand(right)) return { kind: "field-literal", field: left.name, literal: right };
  if (isLiteralOperand(left) && right.kind === "field") return { kind: "field-literal", field: right.name, literal: left };
  if (isLiteralOperand(left) && isLiteralOperand(right)) {
    return { kind: "constant", satisfied: literalsEqual(left, right) };
  }
  if (left.kind === "claim" && right.kind === "claim") return { kind: "constant", satisfied: true };
  return { kind: "unsupported" };
}

/** `String(value)` guarding `null`/`undefined` (design decision 10: a NULL
 * field value contributes NO element — SQL NULL never satisfies `col =
 * claim`, so emitting it as the literal string `"null"` would be a false
 * grant). */
function bucketFieldValue(row: Record<string, unknown>, field: string): string | undefined {
  const v = row[field];
  return v === null || v === undefined ? undefined : String(v);
}

function fieldLiteralSatisfied(
  row: Record<string, unknown>,
  field: string,
  literal: Extract<AllowOperand, { kind: "string" | "number" | "boolean" }>,
): boolean {
  const v = bucketFieldValue(row, field);
  return v !== undefined && v === String(literal.value);
}

function fieldFieldSatisfied(row: Record<string, unknown>, a: string, b: string): boolean {
  const va = bucketFieldValue(row, a);
  const vb = bucketFieldValue(row, b);
  return va !== undefined && vb !== undefined && va === vb;
}

/**
 * Pure computation of one row's `_indigo_realtime_log.buckets` value from
 * its table's `read` `AllowRule`s (design decisions 8-11; PR B). Evaluated
 * once by `WalSource` at write time, never re-evaluated per subscriber.
 *
 * - `table.allow === undefined` (no `@@allow` block at all): the real table
 *   has no RLS enabled either -> `null` (public).
 * - `table.allow` present but with no `action: "read"` rule (e.g. a
 *   create-only model): the real table DOES have RLS enabled and, with no
 *   matching `read` policy, denies all reads by default -> `[]` (deny-all —
 *   the log must never be MORE permissive than the RLS-protected real table
 *   it mirrors).
 * - Otherwise: the union of every claim-dependent (`field == claim`) rule's
 *   field value, from BOTH `row` and `old` (decision 11 — an UPDATE that
 *   changes ownership must still let the LOSING owner observe the row
 *   leaving their view). A caller-independent rule (`field == literal`,
 *   `field == field`, `claim == claim`) satisfied by `row` OR `old`
 *   collapses the WHOLE result to `null` (decision 9).
 */
export function computeBuckets(
  table: ResolvedTable,
  row: Record<string, unknown>,
  old?: Record<string, unknown>,
): string[] | null {
  const rules = table.allow;
  if (rules === undefined) return null;

  const readRules = rules.filter((r) => r.action === "read");
  if (readRules.length === 0) return [];

  const values = new Set<string>();
  for (const rule of readRules) {
    const classification = classifyOperandPair(rule.left, rule.right);
    switch (classification.kind) {
      case "claim-field": {
        const v = bucketFieldValue(row, classification.field);
        if (v !== undefined) values.add(v);
        if (old) {
          const ov = bucketFieldValue(old, classification.field);
          if (ov !== undefined) values.add(ov);
        }
        break;
      }
      case "field-literal": {
        if (
          fieldLiteralSatisfied(row, classification.field, classification.literal) ||
          (old && fieldLiteralSatisfied(old, classification.field, classification.literal))
        ) {
          return null;
        }
        break;
      }
      case "field-field": {
        if (
          fieldFieldSatisfied(row, classification.a, classification.b) ||
          (old && fieldFieldSatisfied(old, classification.a, classification.b))
        ) {
          return null;
        }
        break;
      }
      case "constant": {
        if (classification.satisfied) return null;
        break;
      }
      case "unsupported":
        break;
    }
  }
  return [...values];
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

  // 5. Realtime (@@realtime → WAL logical replication). Publication
  // membership and REPLICA IDENTITY are transactional; slot lifecycle is
  // pre-transaction — `renderReplicationPreSql`, executed by the CLI
  // BEFORE this script (design decision 2), never folded in here. Legacy
  // v1 NOTIFY trigger/function objects are retired unconditionally so a
  // notify-era database converges to the WAL-based DDL on its next push
  // (direct cutover, no dual-write path).
  blocks.push(...renderPublicationSql(schema));
  for (const table of schema.tables) blocks.push(renderReplicaIdentity(table));
  for (const table of schema.tables) blocks.push(renderDropTrigger(table));
  blocks.push(renderDropLegacyNotify());
  blocks.push(...renderRealtimeLogSql(schema));

  // 6. Row-Level Security (@@allow → policies). `renderRlsBlock` itself
  // decides ENABLE+FORCE+policies / DISABLE+prune / nothing per table.
  for (const table of schema.tables) {
    blocks.push(...renderRlsBlock(table));
  }

  return blocks.join("\n\n") + "\n";
}
